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
 * 响应形状（raw，无 envelope，外层标签枚举）：
 *   - git 仓库：`{ gitRepo: { gitRoot } }`（Rust `GitRepoResponse::GitRepo(GitRepoPathResponse)`）
 *   - 非 git：`"notGitRepo"`（unit 变体序列化为裸字符串）
 */
export async function gitRootFor(cwd: string): Promise<string | null> {
  const resp = await acpExtRequest('x.ai/git/git_repo_root', { currentWorkingDirectory: cwd })
  if (!isRecord(resp)) return null
  const gitRepo = resp.gitRepo
  if (!isRecord(gitRepo)) return null
  if (typeof gitRepo.gitRoot === 'string' && gitRepo.gitRoot) return gitRepo.gitRoot
  return null
}

/**
 * pager worktree id 格式：与后端 x.ai/git/worktree/* handler 一致（newSessionId 用同一格式）。
 * 暴露给前端订阅方，便于 createIsolatedWorktree 返回前/进度事件到达前就挂上订阅。
 */
export function pagerWorktreeId(): string {
  return `pager-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}

export interface CreateIsolatedWorktreeInput {
  /** 源目录（工作目录，git root 或子目录） */
  sourcePath: string
  label?: string
  /** git ref（branch/tag/sha），缺省 = HEAD（copyMode dirty） */
  gitRef?: string
  /**
   * 显式指定 pager worktree id（与后端 newSessionId 同格式）。
   * 用于让调用方的 `worktreeStatusStore` 订阅 key 与请求的 `newSessionId`
   * 共享同一个 id，这样后端的进度通知才能被前端订阅到。
   * 不传则自动生成（此时订阅方拿不到进度通知——非交互式批量场景适用）。
   */
  worktreeId?: string
}

export interface CreateIsolatedWorktreeResult {
  /** 实际使用的 pager worktree id（与请求 newSessionId 一致） */
  worktreeId: string
  worktreePath: string
  /** 新会话的工作目录：worktree root 或（源在子目录时）对应子路径 */
  sessionCwd: string
}

/**
 * 同步创建隔离 worktree（TUI 同款路径：create_from_worktree_sync）。
 * 响应：{ status, newSessionId, worktreePath, commit?, sourceGitRoot?, copiedChanges? }
 */
export async function createIsolatedWorktree(
  input: CreateIsolatedWorktreeInput,
): Promise<CreateIsolatedWorktreeResult> {
  const worktreeId = input.worktreeId ?? pagerWorktreeId()
  const params: Record<string, unknown> = {
    sourceWorktreePath: input.sourcePath,
    newSessionId: worktreeId,
    copyMode: input.gitRef ? 'clean' : 'dirty',
  }
  if (input.label) params.label = input.label
  if (input.gitRef) params.gitRef = input.gitRef

  const resp = await acpExtRequest('x.ai/git/worktree/create_from_worktree_sync', params)
  if (!isRecord(resp) || typeof resp.worktreePath !== 'string' || !resp.worktreePath) {
    // 已知 gap：后端 ExtMethodResult::failure 的 error 字符串被 acpExtRequest 解包时丢弃
    // （'result' in raw 时只取 result），此处只能基于响应内字段拼诊断。
    const detail = isRecord(resp) && typeof resp.message === 'string' ? `: ${resp.message}` : '响应缺 worktreePath'
    throw new Error(`worktree 创建失败${detail}`)
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
  return { worktreeId, worktreePath, sessionCwd }
}
