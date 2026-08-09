// ============================================
// API Client for OpenCode Backend
// 基于 @opencode-ai/sdk: /config, /project, /provider 相关接口
// ============================================

import { getSDKClient, unwrap } from './sdk'
import { formatPathForApi } from '../utils/directoryUtils'
import { getAcpActiveModels, getCurrentAcpModelId } from './acpBridge'
import type { ModelInfo, ApiProject, ApiPath } from './types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (isRecord(value)) return value
  throw new Error(message)
}

function requireArray<T = unknown>(value: unknown, message: string): T[] {
  if (Array.isArray(value)) return value as T[]
  throw new Error(message)
}

// Re-export all types
export * from './types'

// Re-export from Attachment feature
export { fromFilePart, fromAgentPart } from '../features/attachment'

// Re-export from sub-modules
export * from './session'
export * from './message'
export * from './permission'
export * from './file'
export * from './agent'
export * from './skill'
export * from './events'
export * from './config'
export * from './vcs'
export * from './mcp'
export * from './pty'
export * from './worktree'
export * from './command'
export * from './global'
export * from './tool'
export * from './lsp'
export * from './acpBridge'

// ============================================
// Model API Functions
// 基于 SDK: config.providers()
// ============================================

export async function getActiveModels(_directory?: string): Promise<ModelInfo[]> {
  // ACP 模式：模型列表来自 initialize 响应 _meta.modelState
  //（x.ai/models/update 通知与 session/new 响应会持续刷新）
  return getAcpActiveModels()
}

export async function getDefaultModels(_directory?: string): Promise<Record<string, string>> {
  const current = getCurrentAcpModelId()
  return current ? { xai: current } : {}
}

// ============================================
// Project API Functions
// 基于 SDK: project.*
// ============================================

/**
 * 获取当前项目
 */
export async function getCurrentProject(directory?: string): Promise<ApiProject> {
  const sdk = getSDKClient()
  return unwrap(await sdk.project.current({ directory: formatPathForApi(directory) }))
}

/**
 * 获取项目列表
 */
export async function getProjects(directory?: string): Promise<ApiProject[]> {
  const sdk = getSDKClient()
  return requireArray<ApiProject>(unwrap(await sdk.project.list({ directory: formatPathForApi(directory) })), 'Invalid OpenCode project list response')
}

/**
 * 初始化 Git 仓库
 */
export async function initGitProject(directory?: string): Promise<ApiProject> {
  const sdk = getSDKClient()
  return unwrap(await sdk.project.initGit({ directory: formatPathForApi(directory) }))
}

/**
 * 更新项目
 */
export async function updateProject(
  projectId: string,
  params: {
    name?: string
    icon?: { url?: string; override?: string; color?: string }
  },
  directory?: string,
): Promise<ApiProject> {
  const sdk = getSDKClient()
  return unwrap(
    await sdk.project.update({
      projectID: projectId,
      directory: formatPathForApi(directory),
      ...params,
    }),
  )
}

// ============================================
// Path API Functions
// ============================================

export async function getPath(): Promise<ApiPath> {
  const sdk = getSDKClient()
  return requireRecord(unwrap(await sdk.path.get()), 'Invalid OpenCode path response') as unknown as ApiPath
}
