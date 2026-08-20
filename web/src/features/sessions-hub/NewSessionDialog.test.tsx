import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NewSessionDialog } from './NewSessionDialog'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: { count?: number }) => (opts?.count !== undefined ? `${key}:${opts.count}` : key) }),
}))

const { useDirectoryMock, gitRootForMock, createIsolatedWorktreeMock, pagerWorktreeIdMock, createSessionMock } = vi.hoisted(() => ({
  useDirectoryMock: vi.fn(),
  gitRootForMock: vi.fn(),
  createIsolatedWorktreeMock: vi.fn(),
  pagerWorktreeIdMock: vi.fn(() => 'pager-abcdef123456'),
  createSessionMock: vi.fn(),
}))

vi.mock('../../contexts/useDirectory', () => ({
  useDirectory: () => useDirectoryMock(),
}))

vi.mock('../../api/worktree', () => ({
  gitRootFor: (...args: unknown[]) => gitRootForMock(...args),
  createIsolatedWorktree: (...args: unknown[]) => createIsolatedWorktreeMock(...args),
  pagerWorktreeId: () => pagerWorktreeIdMock(),
}))

vi.mock('../../contexts/useSessionContext', () => ({
  useSessionContext: () => ({ createSession: (...args: unknown[]) => createSessionMock(...args) }),
}))

function renderDialog(overrides: Record<string, unknown> = {}) {
  const props = {
    isOpen: true,
    initialDirectory: 'C:\\repo',
    onClose: vi.fn(),
    onCreated: vi.fn(),
    ...overrides,
  }
  render(<NewSessionDialog {...props} />)
  return props
}

describe('NewSessionDialog', () => {
  beforeEach(() => {
    useDirectoryMock.mockReset()
    useDirectoryMock.mockReturnValue({
      recentProjects: { 'C:\\repo': 1000, 'D:\\other': 500 },
      touchDirectory: vi.fn(),
    })
    gitRootForMock.mockReset()
    gitRootForMock.mockResolvedValue(null)
    createIsolatedWorktreeMock.mockReset()
    createSessionMock.mockReset()
    pagerWorktreeIdMock.mockReset()
    pagerWorktreeIdMock.mockReturnValue('pager-abcdef123456')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('渲染最近目录列表，选中项高亮', async () => {
    renderDialog()
    expect(screen.getByText('C:\\repo')).toBeInTheDocument()
    fireEvent.click(screen.getByText('D:\\other'))
    // 目录行有 data-selected 标记
    expect(screen.getByText('D:\\other').closest('[data-selected="true"]')).not.toBeNull()
  })

  it('普通创建：用选中目录 createSession 并触发 onCreated', async () => {
    createSessionMock.mockResolvedValue({ id: 's1' })
    const props = renderDialog()
    fireEvent.click(screen.getByText('C:\\repo'))
    fireEvent.click(screen.getByRole('button', { name: /sessionsHub\.createSession/ }))
    await act(async () => {})
    expect(createSessionMock).toHaveBeenCalledWith(undefined, 'C:\\repo')
    expect(props.onCreated).toHaveBeenCalledWith({ id: 's1' })
  })

  it('目录是 git 仓库时显示 worktree 开关', async () => {
    gitRootForMock.mockResolvedValue('C:\\repo')
    renderDialog()
    await act(async () => {})
    expect(screen.getByText('sessionsHub.runInWorktree')).toBeInTheDocument()
  })

  it('worktree 路径：先建 worktree 再用 sessionCwd 建会话', async () => {
    gitRootForMock.mockResolvedValue('C:\\repo')
    createIsolatedWorktreeMock.mockResolvedValue({
      worktreeId: 'pager-abcdef123456',
      worktreePath: 'C:\\repo\\.claude\\worktrees\\w1',
      sessionCwd: 'C:\\repo\\.claude\\worktrees\\w1\\sub',
    })
    createSessionMock.mockResolvedValue({ id: 's2' })
    const props = renderDialog()
    await act(async () => {})
    const toggle = screen.getByRole('switch')
    fireEvent.click(toggle)
    fireEvent.click(screen.getByRole('button', { name: /sessionsHub\.createSession/ }))
    await act(async () => {})
    // 订阅 key 与请求 newSessionId 共享同一个 worktreeId
    expect(createIsolatedWorktreeMock).toHaveBeenCalledWith({
      sourcePath: 'C:\\repo',
      worktreeId: 'pager-abcdef123456',
    })
    expect(createSessionMock).toHaveBeenCalledWith(undefined, 'C:\\repo\\.claude\\worktrees\\w1\\sub')
    expect(props.onCreated).toHaveBeenCalledWith({ id: 's2' })
  })

  it('未选目录时创建按钮禁用', () => {
    useDirectoryMock.mockReturnValue({ recentProjects: {}, touchDirectory: vi.fn() })
    renderDialog({ initialDirectory: '' })
    expect(screen.getByRole('button', { name: /sessionsHub\.createSession/ })).toBeDisabled()
  })

  it('worktree 创建失败时不触发 onCreated、按钮重新可用、显示错误', async () => {
    gitRootForMock.mockResolvedValue('C:\\repo')
    createIsolatedWorktreeMock.mockRejectedValue(new Error('not a git repo'))
    const props = renderDialog()
    await act(async () => {})
    fireEvent.click(screen.getByRole('switch'))
    fireEvent.click(screen.getByRole('button', { name: /sessionsHub\.createSession/ }))
    await act(async () => {})
    expect(createSessionMock).not.toHaveBeenCalled()
    expect(props.onCreated).not.toHaveBeenCalled()
    const createBtn = screen.getByRole('button', { name: /sessionsHub\.createSession/ })
    expect(createBtn).not.toBeDisabled()
    expect(screen.getByText('not a git repo')).toBeInTheDocument()
  })

  it('选中目录变化时重新检测 git（避免 stale isGit）', async () => {
    gitRootForMock.mockImplementation(async (cwd: string) => {
      if (cwd === 'C:\\repo') return 'C:\\repo'
      return null
    })
    renderDialog()
    await act(async () => {})
    expect(screen.getByText('sessionsHub.runInWorktree')).toBeInTheDocument()
    // 切到非 git 目录
    fireEvent.click(screen.getByText('D:\\other'))
    await act(async () => {})
    expect(screen.queryByText('sessionsHub.runInWorktree')).not.toBeInTheDocument()
  })
})