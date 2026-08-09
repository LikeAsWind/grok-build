// ============================================
// PTY API - 终端管理
// ============================================

import { getApiBaseUrl, buildQueryString } from './http'
import { serverStore } from '../store/serverStore'
import type { Pty, PtyUpdateParams } from '../types/api/pty'

export interface ShellInfo {
  path: string
  name: string
  acceptable: boolean
}

interface PtyConnectUrlOptions {
  includeAuthInUrl?: boolean
  cursor?: number
}

function randomPtyId(): string {
  return `term-${crypto.randomUUID()}`
}

/**
 * 获取所有 PTY 会话列表
 */
export async function listPtySessions(_directory?: string): Promise<Pty[]> {
  // ACP mode: no REST endpoint for listing PTY sessions.
  // The backend auto-creates PTY on WebSocket connect, so sessions
  // are discovered by opening terminal tabs, not listed here.
  return []
}

/**
 * 获取当前机器可用 shell 列表，用于 opencode config.shell 的候选项。
 */
export async function listAvailableShells(_directory?: string): Promise<ShellInfo[]> {
  return []
}

/**
 * 创建新的 PTY 会话
 */
export async function createPtySession(_params?: unknown, _directory?: string): Promise<Pty> {
  const id = randomPtyId()
  return { id, title: `Terminal (${id.slice(0, 8)})`, status: 'running' } as Pty
}

/**
 * 获取单个 PTY 会话信息
 */
export async function getPtySession(ptyId: string, _directory?: string): Promise<Pty> {
  return { id: ptyId, title: ptyId, status: 'running' } as Pty
}

/**
 * 更新 PTY 会话
 */
export async function updatePtySession(ptyId: string, params: PtyUpdateParams, _directory?: string): Promise<Pty> {
  return { id: ptyId, title: ptyId, status: 'running', ...params } as Pty
}

export async function removePtySession(_ptyId: string, _directory?: string): Promise<boolean> {
  return true
}

/**
 * 获取 PTY 连接 WebSocket URL
 *
 * 浏览器 WebSocket 不支持自定义 header，认证方式：
 * - 跨域：auth_token query parameter（与官方 opencode app 一致）
 * - 同源：浏览器会复用页面的 Basic auth 凭据
 * - Tauri bridge：不走这里，通过 Rust 的 HTTP header 传认证
 */
export function getPtyConnectUrl(ptyId: string, directory?: string, options?: PtyConnectUrlOptions): string {
  const httpBase = getApiBaseUrl()
  const wsBase = httpBase.replace(/^http/, 'ws')
  const includeAuthInUrl = options?.includeAuthInUrl ?? true
  const cursor =
    typeof options?.cursor === 'number' && Number.isSafeInteger(options.cursor) && options.cursor >= 0
      ? options.cursor
      : undefined

  const auth = serverStore.getActiveAuth()
  const formatted = directory ? directory.replace(/\\/g, '/') : undefined

  // Tauri bridge 不需要在 URL 里放认证
  if (!includeAuthInUrl) {
    return `${wsBase}/pty/${ptyId}/connect${buildQueryString({ directory: formatted, cursor })}`
  }

  // 浏览器原生 WebSocket：
  // 跨域时用 auth_token query parameter + userinfo fallback
  // 同源时浏览器会自动复用 Basic auth
  const isCrossOrigin = (() => {
    try {
      return new URL(httpBase).origin !== location.origin
    } catch {
      return true
    }
  })()

  const queryParams: Record<string, string | number | undefined> = { directory: formatted, cursor }

  let wsUrl = wsBase
  if (auth?.password) {
    if (isCrossOrigin) {
      // auth_token = base64(username:password)，与官方 opencode app 一致
      queryParams.auth_token = btoa(`${auth.username}:${auth.password}`)
    }
    // 同时设 userinfo 作为 fallback（部分浏览器直连时能用）
    const creds = `${encodeURIComponent(auth.username)}:${encodeURIComponent(auth.password)}@`
    wsUrl = wsBase.replace('://', `://${creds}`)
  }

  return `${wsUrl}/pty/${ptyId}/connect${buildQueryString(queryParams)}`
}
