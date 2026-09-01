#requires -Version 5.0
<#
.SYNOPSIS
    Fast dev-build wrapper for grok-build. Sets up the max-aggressiveness
    compile pipeline (sccache + rust-lld + parallel codegen) and forwards
    to cargo.

.DESCRIPTION
    Invoke directly:

        .\scripts\build-fast.ps1 check
        .\scripts\build-fast.ps1 test
        .\scripts\build-fast.ps1 nextest
        .\scripts\build-fast.ps1 info   # show sccache hit rate

    Or dot-source to inherit env vars in current shell:

        . .\scripts\build-fast.ps1

    Configures:
      - RUSTC_WRAPPER         -> sccache (rustc cache), only if found
      - SCCACHE_CLIENT_SIDE   -> '1' (sccache 0.17+ client-side mode, no server RTT)
      - SCCACHE_DIR           -> D:\sccache if D: exists else %TEMP%\sccache
      - CARGO_INCREMENTAL     -> '1'
      - CARGO_TARGET_DIR      -> D:\cargo-target\grok-build if D: exists

    Relies on (committed to repo):
      - .cargo/config.toml: rustc-wrapper = "sccache", linker = "rust-lld"
      - Cargo.toml: [profile.dev.package."*"].debug = false

    Install once (Windows):
      > cargo install sccache --locked
      > cargo install cargo-nextest --locked

    Cold build baseline (1309 deps, fresh target/): ~25 min default -> ~3-5 min
    Warm build with sccache: ~seconds
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory=$false, Position=0)]
    [ValidateSet('check', 'build', 'test', 'clippy', 'nextest', 'bench', 'fmt', 'info', 'clean')]
    [string]$Cmd = 'check',

    [Parameter(ValueFromRemainingArguments=$true)]
    [string[]]$CargoArgs = @(),

    [switch]$NoCache,
    [switch]$NoIncr,
    [switch]$UseCache,   # opt-in: enable sccache (default OFF on Windows)
    [int]$Jobs = 0
)

$ErrorActionPreference = 'Stop'
# sccache is OFF by default on Windows because cargo's feature-flag arg list exceeds
# cmd.exe 32k limit when routed through sccache's wrapper. Pass -UseCache to enable.
$UseCache = $false
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

# ---------------------------------------------------------------------------
# Environment setup
# ---------------------------------------------------------------------------

$SccacheBin = $null
foreach ($cand in @("$env:USERPROFILE\.cargo\bin\sccache.exe", 'C:\Users\yangzhitong\.cargo\bin\sccache.exe')) {
    if (Test-Path $cand) { $SccacheBin = $cand; break }
}

if (-not $NoCache -and $UseCache -and $SccacheBin) {
    $env:RUSTC_WRAPPER = $SccacheBin
    $env:SCCACHE_CLIENT_SIDE = '1'
    if (Test-Path 'D:\') {
        $env:SCCACHE_DIR = 'D:\sccache'
    } else {
        $env:SCCACHE_DIR = Join-Path $env:TEMP 'sccache'
    }
    New-Item -ItemType Directory -Force -Path $env:SCCACHE_DIR | Out-Null
    Write-Host "[build-fast] sccache: $SccacheBin" -ForegroundColor DarkGray
    Write-Host "[build-fast] cache:   $($env:SCCACHE_DIR)" -ForegroundColor DarkGray
} else {
    # .cargo/config.toml sets rustc-wrapper = "sccache" globally.
    # If sccache isn't installed, cargo would error trying to invoke it.
    # Override to empty to bypass the broken config setting.
    $env:RUSTC_WRAPPER = ''
    if (-not $NoCache -and $UseCache) {
        Write-Warning "sccache not found. Install with: cargo install sccache --locked"
        Write-Warning "Continuing WITHOUT rust cache (slow)."
    }
}

# CARGO_INCREMENTAL is incompatible with sccache (sccache wraps rustc and cannot
# share incremental metadata across cache misses and hits). When sccache is active
# we REMOVE the var entirely (sccache refuses even ='0', only fully unset works)
# and switch to profile.dev-fast (inherits dev but with incremental=false). When
# sccache is absent we keep cargo's default incremental behavior.
if (-not $NoIncr -and -not $SccacheBin) {
    $env:CARGO_INCREMENTAL = '1'
} else {
    Remove-Item Env:CARGO_INCREMENTAL -ErrorAction SilentlyContinue
}
# Profile selector: dev-fast when sccache wraps, dev otherwise.
if ($SccacheBin -and $UseCache) { $ProfileFlag = '--profile dev-fast' } else { $ProfileFlag = '' }

if ((Test-Path 'D:\') -and (-not $env:CARGO_TARGET_DIR)) {
    $env:CARGO_TARGET_DIR = 'D:\cargo-target\grok-build'
    New-Item -ItemType Directory -Force -Path $env:CARGO_TARGET_DIR | Out-Null
    Write-Host "[build-fast] target:  $env:CARGO_TARGET_DIR" -ForegroundColor DarkGray
}

Push-Location $ProjectRoot
try {
    $jobFlag = if ($Jobs -gt 0) { "-j$Jobs" } else { '' }
    $profileArgs = if ($ProfileFlag) { @($ProfileFlag) } else { @() }
    $jobArgs = if ($jobFlag) { @($jobFlag) } else { @() }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    Write-Host "[build-fast] cargo $Cmd $(if ($CargoArgs) { $CargoArgs -join ' ' })" -ForegroundColor Cyan

    switch ($Cmd) {
        'check'    { & cargo check @profileArgs --workspace --all-targets @jobArgs @CargoArgs; break }
        'build'    { & cargo build @profileArgs --workspace @jobArgs @CargoArgs; break }
        'test'     { & cargo test @profileArgs --workspace @jobArgs @CargoArgs; break }
        'nextest'  {
            if (-not (Get-Command cargo-nextest -ErrorAction SilentlyContinue)) {
                Write-Warning "cargo-nextest not installed. Falling back to cargo test."
                & cargo test @profileArgs --workspace @jobArgs @CargoArgs
            } else {
                & cargo nextest run @profileArgs --workspace @jobArgs @CargoArgs
            }
            break
        }
        'clippy'   { & cargo clippy @profileArgs --workspace --all-targets @jobArgs @CargoArgs; break }
        'bench'    { & cargo bench @profileArgs --workspace @jobArgs @CargoArgs; break }
        'fmt'      { & cargo fmt --all @CargoArgs; break }
        'info'     {
            & rustc --version
            & cargo --version
            if ($SccacheBin) {
                Write-Host "sccache: $($(Get-Item $SccacheBin).VersionInfo.FileVersion)"
                & $SccacheBin --version
                & $SccacheBin -s 2>$null | Select-Object -First 5
            } else {
                Write-Host "sccache: NOT INSTALLED" -ForegroundColor Yellow
            }
            break
        }
        'clean'    {
            if (($CargoArgs -contains 'all') -or ($CargoArgs -contains '--all')) {
                Write-Warning "Refusing to cargo clean target/ wholesale; kills deps cache."
                Write-Warning "Use 'cargo clean -p <crate>' for surgical cleanup."
                return
            }
            & cargo clean @CargoArgs
        }
    }
    $sw.Stop()
    Write-Host ("[build-fast] done in {0:mm\:ss}" -f $sw.Elapsed) -ForegroundColor Green
}
finally {
    Pop-Location
}
