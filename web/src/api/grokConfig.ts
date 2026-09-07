// ============================================
// grok config.toml 读写 API（xai-grok-web 的 /config-file 端点）
// ============================================

import { getBackendBaseUrl, getAcpSecret, acpExtRequest } from './acpBridge'

export interface GrokConfigFile {
  path: string
  content: string
}

function authHeaders(): Record<string, string> {
  const secret = getAcpSecret()
  if (!secret) throw new Error('缺少访问密钥，无法读取配置')
  return { 'x-server-key': secret }
}

/** 读取后端机器上的 ~/.grok/config.toml */
export async function getGrokConfigFile(): Promise<GrokConfigFile> {
  const resp = await fetch(`${getBackendBaseUrl()}/config-file`, { headers: authHeaders() })
  if (!resp.ok) throw new Error(`读取配置失败: ${resp.status} ${await resp.text().catch(() => '')}`)
  return (await resp.json()) as GrokConfigFile
}

/**
 * 保存 config.toml（服务端做 TOML 语法校验；模型/MCP 变更由 shell 热重载）
 * 语法错误时抛出包含错误位置的异常
 */
export async function saveGrokConfigFile(content: string): Promise<void> {
  const resp = await fetch(`${getBackendBaseUrl()}/config-file`, {
    method: 'PUT',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
  if (!resp.ok) throw new Error(await resp.text().catch(() => `保存失败: ${resp.status}`))
}

// ── 结构化读写（表单模式用）─────────────────────────────────────────

export interface GrokConfigParsed extends GrokConfigFile {
  /** TOML → JSON；解析失败时为 undefined，parseError 带错误信息 */
  parsed?: Record<string, unknown>
  parseError?: string
}

/** 读取 config.toml 并附带解析后的 JSON 结构 */
export async function getGrokConfigParsed(): Promise<GrokConfigParsed> {
  const resp = await fetch(`${getBackendBaseUrl()}/config-file?format=json`, { headers: authHeaders() })
  if (!resp.ok) throw new Error(`读取配置失败: ${resp.status} ${await resp.text().catch(() => '')}`)
  return (await resp.json()) as GrokConfigParsed
}

export interface GrokConfigPatch {
  /** path 为分段键（段内可含点，如模型 id "grok-4.20"） */
  set?: Array<{ path: string[]; value: unknown }>
  delete?: Array<{ path: string[] }>
}

/**
 * 结构化修改 config.toml：后端用 toml_edit 应用，注释与未触及内容原样保留。
 * 模型/MCP section 保存后由 shell 热重载。
 */
export async function patchGrokConfig(patch: GrokConfigPatch): Promise<void> {
  const resp = await fetch(`${getBackendBaseUrl()}/config-file`, {
    method: 'PATCH',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!resp.ok) throw new Error(await resp.text().catch(() => `保存失败: ${resp.status}`))
}

/**
 * 通知后端从磁盘重载模型配置（grok web 模式没有 config watcher，
 * 保存 [model.*]/[models] 后由前端主动触发；随后 UI 应刷新模型列表）
 */
export async function reloadBackendModels(): Promise<void> {
  try {
    await reloadBackend('models')
  } catch (err) {
    throw new Error(`模型热重载失败（ACP 未连接？刷新页面后再试）: ${err instanceof Error ? err.message : err}`)
  }
}

/** 热重载 features/session/toolset/ui/permission/subagents（非模型/MCP section） */
export async function reloadBackendConfig(): Promise<void> {
  try {
    await acpExtRequest('x.ai/internal/reload_config')
    await new Promise(resolve => setTimeout(resolve, 300))
  } catch (err) {
    throw new Error(`配置热重载失败（ACP 未连接？刷新页面后再试）: ${err instanceof Error ? err.message : err}`)
  }
}

const RELOAD_METHODS = {
  models: 'x.ai/internal/reload_models',
  mcp: 'x.ai/internal/reload_all_mcp_servers',
  skills: 'x.ai/internal/reload_skills',
} as const

export type BackendReloadKind = keyof typeof RELOAD_METHODS

/** 保存配置后按 section 类型触发后端热重载 */
export async function reloadBackend(kind: BackendReloadKind): Promise<void> {
  await acpExtRequest(RELOAD_METHODS[kind])
  // x.ai/models/update 是异步通知，等待确保后续 refreshModels() 读到新值
  await new Promise(resolve => setTimeout(resolve, 1200))
}

// ── 本地目录浏览 ─────────────────────────────────────────────────

export interface BrowseDirEntry {
  name: string
  isDir: boolean
}

export interface BrowseDirResult {
  path: string
  entries: BrowseDirEntry[]
  error: string | null
}

/**
 * 浏览后端机器上的本地文件系统目录
 * 需要 server-key 认证（查询参数或 header）
 */
// ── cron.yaml 读写（v2 spec §7.2.3）─────────────────────────────────
//
// Backend endpoints are not yet wired (ext method registration deferred to
// M2.12 follow-up). The UI consumes these helpers so the API surface is
// stable; calls will surface a backend error until the endpoint exists.

export interface CronYamlFile {
  /** Absolute path on the backend host (typically ~/.grok/cron.yaml). */
  path: string
  /** Raw YAML content. Empty string if file does not exist yet. */
  content: string
}

export async function getCronYaml(): Promise<CronYamlFile> {
  return (await acpExtRequest('x.ai/workbench/cron/get')) as CronYamlFile
}

export async function saveCronYaml(content: string): Promise<void> {
  await acpExtRequest('x.ai/workbench/cron/save', { content })
}

export async function browseDirectory(dirPath: string): Promise<BrowseDirResult> {
  const secret = getAcpSecret()
  if (!secret) throw new Error('未连接后端')
  const url = `${getBackendBaseUrl()}/browse-dir?path=${encodeURIComponent(dirPath)}`
  const resp = await fetch(url, { headers: { 'x-server-key': secret } })
  if (!resp.ok) throw new Error(`浏览目录失败: ${resp.status}`)
  return (await resp.json()) as BrowseDirResult
}
