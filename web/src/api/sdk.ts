// ============================================
// SDK Client - 基于 @opencode-ai/sdk 的统一客户端
//
// ACP 模式：opencode REST 后端不存在，返回安全 stub（空数据 / 静默忽略），
// 防止调用方因未处理 reject 导致白屏。已接入 ACP 的 API 函数（client.ts 的
// getActiveModels、session.ts、message.ts、permission.ts 等）不经过此路径。
// ============================================

import { isTauri } from '../utils/tauri'

// Tauri fetch 缓存
let _tauriFetch: typeof globalThis.fetch | null = null
let _tauriFetchLoading: Promise<typeof globalThis.fetch> | null = null
let _apiRequestGeneration = 0
const _apiRequestControllers = new Set<AbortController>()

async function getTauriFetch(): Promise<typeof globalThis.fetch> {
  if (_tauriFetch) return _tauriFetch
  if (_tauriFetchLoading) return _tauriFetchLoading
  _tauriFetchLoading = import('@tauri-apps/plugin-http').then(mod => {
    _tauriFetch = mod.fetch as unknown as typeof globalThis.fetch
    return _tauriFetch
  })
  return _tauriFetchLoading
}

export function abortInFlightApiRequests(reason = 'Server endpoint changed'): void {
  _apiRequestGeneration++
  for (const controller of _apiRequestControllers) {
    controller.abort(new DOMException(reason, 'AbortError'))
  }
  _apiRequestControllers.clear()
}

/**
 * ACP 模式：opencode REST 后端不存在，返回安全 stub。
 * 所有仍通过此函数调用的 API（file.ts、skill.ts、command.ts、mcp.ts 等）
 * 均收到 `{ data: undefined }` 的 unwrap 兼容值，不会因 fetch reject 白屏。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getSDKClient(): any {
  return SAFE_STUB
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getSDKClientAsync(): Promise<any> {
  if (isTauri()) {
    await getTauriFetch()
  }
  return SAFE_STUB
}

export function invalidateSDKClient(): void {
  // no-op
}

/**
 * 安全 stub：所有 .xxx.yyy() 调用返回 { data: undefined }；
 * unwrap 拿到 undefined → 调用方自行处理（通常静默渲染空状态）
 */
const STUB_RESULT = { data: undefined }

function stubMethod() {
  return STUB_RESULT
}

const SAFE_STUB = new Proxy(
  {},
  {
    get(_target, _prop) {
      const nested: Record<string, unknown> = {}
      return new Proxy(nested, {
        get(_n, _p) {
          if (_p === 'then') return undefined // 防止被当成 Promise
          // 函数调用返回 { data: undefined } 兼容 unwrap
          return stubMethod
        },
        apply() {
          return STUB_RESULT
        },
      })
    },
  },
)

/**
 * 从 SDK 返回值中提取 data，如果有 error 则抛出
 *
 * SDK 默认返回 { data, error, request, response }
 * 我们的上层 API 函数期望直接返回数据，所以需要 unwrap
 */
export function unwrap<T>(result: { data?: T; error?: unknown }): T {
  if (result.error != null) {
    const err = result.error
    if (err instanceof Error) throw err
    if (typeof err === 'string') throw new Error(err)
    throw new Error(JSON.stringify(err))
  }
  return result.data as T
}
