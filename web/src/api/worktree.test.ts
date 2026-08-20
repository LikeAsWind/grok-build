import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { acpExtRequestMock, acpNewSessionMock } = vi.hoisted(() => ({
  acpExtRequestMock: vi.fn(),
  acpNewSessionMock: vi.fn(),
}))

vi.mock('./acpBridge', () => ({
  acpExtRequest: (...args: unknown[]) => acpExtRequestMock(...args),
  acpNewSession: (...args: unknown[]) => acpNewSessionMock(...args),
  getServerCwd: () => 'C:\\repo',
}))

import { gitRootFor, createIsolatedWorktree } from './worktree'

describe('worktree ACP API', () => {
  beforeEach(() => {
    acpExtRequestMock.mockReset()
    acpNewSessionMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('gitRootFor 返回 git root', async () => {
    acpExtRequestMock.mockResolvedValue({ gitRepo: { gitRoot: 'C:\\repo' } })
    await expect(gitRootFor('C:\\repo\\sub')).resolves.toBe('C:\\repo')
    expect(acpExtRequestMock).toHaveBeenCalledWith('x.ai/git/git_repo_root', {
      currentWorkingDirectory: 'C:\\repo\\sub',
    })
  })

  it('gitRootFor 非 git 仓库返回 null（响应是裸字符串 "notGitRepo"）', async () => {
    acpExtRequestMock.mockResolvedValue('notGitRepo')
    await expect(gitRootFor('C:\\plain')).resolves.toBeNull()
  })

  it('createIsolatedWorktree 走 create_from_worktree_sync', async () => {
    acpExtRequestMock.mockResolvedValue({
      status: 'created',
      newSessionId: 'pager-abcdef123456',
      worktreePath: 'C:\\repo\\.claude\\worktrees\\2026-08-20-abcdef123456',
      sourceGitRoot: 'C:\\repo',
    })
    const result = await createIsolatedWorktree({ sourcePath: 'C:\\repo\\sub', label: 'feature' })
    expect(acpExtRequestMock).toHaveBeenCalledWith('x.ai/git/worktree/create_from_worktree_sync', {
      sourceWorktreePath: 'C:\\repo\\sub',
      newSessionId: expect.stringMatching(/^pager-/),
      copyMode: 'dirty',
      label: 'feature',
    })
    expect(result.worktreePath).toBe('C:\\repo\\.claude\\worktrees\\2026-08-20-abcdef123456')
    // 源目录在 git root 子目录下：sessionCwd 拼相对子路径
    expect(result.sessionCwd).toBe('C:\\repo\\.claude\\worktrees\\2026-08-20-abcdef123456\\sub')
  })

  it('gitRef 存在时 copyMode 为 clean', async () => {
    acpExtRequestMock.mockResolvedValue({
      status: 'created',
      newSessionId: 'x',
      worktreePath: 'C:\\repo\\.claude\\worktrees\\w',
    })
    await createIsolatedWorktree({ sourcePath: 'C:\\repo', gitRef: 'feature/x' })
    const [, params] = acpExtRequestMock.mock.calls[0]
    expect((params as { copyMode: string }).copyMode).toBe('clean')
    expect((params as { gitRef?: string }).gitRef).toBe('feature/x')
  })

  it('createIsolatedWorktree 缺 sourceGitRoot 时 sessionCwd 回退到 worktreePath', async () => {
    acpExtRequestMock.mockResolvedValue({
      status: 'created',
      newSessionId: 'x',
      worktreePath: 'C:\\repo\\.claude\\worktrees\\w',
      // no sourceGitRoot
    })
    const result = await createIsolatedWorktree({ sourcePath: 'C:\\repo\\sub' })
    expect(result.sessionCwd).toBe(result.worktreePath)
  })

  it('createIsolatedWorktree sourcePath 等于 sourceGitRoot（无子目录）sessionCwd 等于 worktreePath', async () => {
    acpExtRequestMock.mockResolvedValue({
      status: 'created',
      newSessionId: 'x',
      worktreePath: 'C:\\repo\\.claude\\worktrees\\w',
      sourceGitRoot: 'C:\\repo',
    })
    const result = await createIsolatedWorktree({ sourcePath: 'C:\\repo' })
    expect(result.sessionCwd).toBe(result.worktreePath)
  })

  it('响应缺 worktreePath 时报错', async () => {
    acpExtRequestMock.mockResolvedValue({ status: 'error', message: 'disk full' })
    await expect(createIsolatedWorktree({ sourcePath: 'C:\\repo' })).rejects.toThrow(/worktree.*失败.*disk full/)
  })

  it('响应缺 worktreePath 且无 message 时给出兜底提示', async () => {
    acpExtRequestMock.mockResolvedValue({ status: 'error' })
    await expect(createIsolatedWorktree({ sourcePath: 'C:\\repo' })).rejects.toThrow(/worktree.*失败/)
  })
})
