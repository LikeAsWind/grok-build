// ============================================
// Worktree API - 重接 ACP ext（替代已 stub 的 @opencode-ai/sdk）
//
// 后端 ext handler：crates/codegen/xai-grok-shell/src/extensions/worktree.rs、
// crates/codegen/xai-grok-shell/src/extensions/git.rs。
// 注意：x.ai/git/git_repo_root 用 to_raw_response（无 ExtMethodResult
// envelope），acpExtRequest 已按「有 result 才解包」处理，两种形状都兼容。
// ============================================

import { acpExtRequest } from './acpBridge'

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/**
 * 解析 git root。非 git 仓库返回 null。
 * 响应形状（raw，无 envelope）：{ gitRoot } | { status: "notGitRepo" }
 */
export async function gitRootFor(cwd: string): Promise<string | null> {
  const resp = await acpExtRequest('x.ai/git/git_repo_root', { currentWorkingDirectory: cwd })
  if (!isRecord(resp)) return null
  if (typeof resp.gitRoot === 'string' && resp.gitRoot) return resp.gitRoot
  return null
}

function worktreeIdFor(): string {
  return `pager-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}

export interface CreateIsolatedWorktreeInput {
  /** 源目录（工作目录，git root 或子目录） */
  sourcePath: string
  label?: string
  /** git ref（branch/tag/sha），缺省 = HEAD（copyMode dirty） */
  gitRef?: string
}

export interface CreateIsolatedWorktreeResult {
  worktreePath: string
  /** 新会话的工作目录：worktree root 或（源在子目录时）对应子路径 */
  sessionCwd: string
}

/**
 * 同步创建隔离 worktree（TUI 同款路径：create_from_worktree_sync）。
 * 响应：{ status, newSessionId, worktreePath, commit?, sourceGitRoot? }
 */
export async function createIsolatedWorktree(
  input: CreateIsolatedWorktreeInput,
): Promise<CreateIsolatedWorktreeResult> {
  const params: Record<string, unknown> = {
    sourceWorktreePath: input.sourcePath,
    newSessionId: worktreeIdFor(),
    copyMode: input.gitRef ? 'clean' : 'dirty',
  }
  if (input.label) params.label = input.label
  if (input.gitRef) params.gitRef = input.gitRef

  const resp = await acpExtRequest('x.ai/git/worktree/create_from_worktree_sync', params)
  if (!isRecord(resp) || typeof resp.worktreePath !== 'string' || !resp.worktreePath) {
    const detail = isRecord(resp) && typeof resp.message === 'string' ? `: ${resp.message}` : ''
    throw new Error(`worktree 创建失败（响应缺 worktreePath）${detail}`)
  }

  const worktreePath = resp.worktreePath
  let sessionCwd = worktreePath
  const sourceGitRoot = typeof resp.sourceGitRoot === 'string' ? resp.sourceGitRoot : null
  if (sourceGitRoot && sourceGitRoot.length > 0) {
    const rootNorm = sourceGitRoot.replace(/\\/g, '/').replace(/\/+$/, '')
    const srcNorm = input.sourcePath.replace(/\\/g, '/').replace(/\/+$/, '')
    if (srcNorm.toLowerCase().startsWith(rootNorm.toLowerCase() + '/')) {
      const relative = srcNorm.slice(rootNorm.length + 1)
      const usesBackslash = worktreePath.includes('\\')
      const wtNorm = worktreePath.replace(/\\/g, '/').replace(/\/+$/, '')
      sessionCwd = `${wtNorm}/${relative}`
      if (usesBackslash) sessionCwd = sessionCwd.replace(/\//g, '\\')
    }
  }
  return { worktreePath, sessionCwd }
}
