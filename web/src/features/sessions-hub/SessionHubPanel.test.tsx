// SessionHubPanel 集成测试：覆盖全局列表、状态筛选、按项目分组、新建会话集成。
// 依赖：useSessionContext（侧栏数据源）+ useBusySessions（busy 状态）+ useNotifications（铃铛）。
// 轻量 mock：NewSessionDialog 用一个最简的 fake 替身，验证面板开关状态机即可。

import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionHubPanel } from './SessionHubPanel'
import type { ApiSession } from '../../api'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: { count?: number }) => (opts?.count !== undefined ? `${key}:${opts.count}` : key) }),
}))

const {
  useSessionContextMock,
  useBusySessionsMock,
  useNotificationsMock,
  useUnreadNotificationCountMock,
  updateSessionMock,
  deleteSessionMock,
} = vi.hoisted(() => ({
  useSessionContextMock: vi.fn(),
  useBusySessionsMock: vi.fn(),
  useNotificationsMock: vi.fn(),
  useUnreadNotificationCountMock: vi.fn(() => 0),
  updateSessionMock: vi.fn().mockResolvedValue(undefined),
  deleteSessionMock: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../contexts/useSessionContext', () => ({
  useSessionContext: () => useSessionContextMock(),
}))

vi.mock('../../store/activeSessionStore', () => ({
  useBusySessions: () => useBusySessionsMock(),
  useBusyCount: () => 0,
  useUnreadNotificationCount: () => useUnreadNotificationCountMock(),
}))

vi.mock('../../store/notificationStore', () => ({
  notificationStore: {
    subscribe: () => () => {},
    getSnapshot: () => ({ notifications: [], toasts: [] }),
  },
  useNotifications: () => useNotificationsMock(),
  useUnreadNotificationCount: () => useUnreadNotificationCountMock(),
}))

vi.mock('../../api', () => ({
  updateSession: (...args: unknown[]) => updateSessionMock(...args),
  deleteSession: (...args: unknown[]) => deleteSessionMock(...args),
}))

vi.mock('../../api/acpBridge', () => ({
  getServerCwd: () => 'C:\\root',
}))

vi.mock('./NewSessionDialog', () => ({
  NewSessionDialog: ({
    isOpen,
    onClose,
    onCreated,
  }: {
    isOpen: boolean
    onClose: () => void
    onCreated: (s: { id: string; directory?: string }) => void
  }) =>
    isOpen ? (
      <div role="dialog">
        <button onClick={() => onCreated({ id: 'new-1', directory: 'C:\\repo' })}>fake-create</button>
        <button onClick={onClose}>fake-close</button>
      </div>
    ) : null,
}))

function makeSession(overrides: Partial<ApiSession> = {}): ApiSession {
  return {
    id: 's1',
    directory: 'C:\\repo',
    title: '会话 A',
    version: '',
    time: { created: 1000, updated: 2000 },
    ...overrides,
  } as ApiSession
}

function sessionCtx(sessions: ApiSession[], search = '') {
  return {
    sessions,
    isLoading: false,
    isLoadingMore: false,
    hasMore: false,
    search,
    setSearch: vi.fn(),
    refresh: vi.fn().mockResolvedValue(undefined),
    loadMore: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
  }
}

function renderPanel(props: Partial<React.ComponentProps<typeof SessionHubPanel>> = {}) {
  return render(
    <SessionHubPanel
      onNewSession={vi.fn()}
      onSelectSession={vi.fn()}
      selectedSessionId={null}
      isExpanded={true}
      onToggleSidebar={vi.fn()}
      onOpenSettings={vi.fn()}
      {...props}
    />,
  )
}

describe('SessionHubPanel', () => {
  beforeEach(() => {
    useSessionContextMock.mockReset()
    useBusySessionsMock.mockReset()
    useBusySessionsMock.mockReturnValue([])
    useNotificationsMock.mockReset()
    useNotificationsMock.mockReturnValue([])
    useUnreadNotificationCountMock.mockReset()
    useUnreadNotificationCountMock.mockReturnValue(0)
    updateSessionMock.mockReset()
    updateSessionMock.mockResolvedValue(undefined)
    deleteSessionMock.mockReset()
    deleteSessionMock.mockResolvedValue(undefined)
  })

  it('渲染全局会话列表（含不同目录的会话）', () => {
    useSessionContextMock.mockReturnValue(
      sessionCtx([
        makeSession({ id: 's1', directory: 'C:\\repo', title: '会话 A' }),
        makeSession({ id: 's2', directory: 'D:\\other', title: '会话 B' }),
      ]),
    )
    renderPanel()

    expect(screen.getByText('会话 A')).toBeInTheDocument()
    expect(screen.getByText('会话 B')).toBeInTheDocument()
    // 全局列表：两个目录的会话都要可见
    expect(screen.getByText('other')).toBeInTheDocument()
  })

  it('状态筛选：Working 只显示对应会话', () => {
    useSessionContextMock.mockReturnValue(
      sessionCtx([
        makeSession({ id: 's1', title: '会话 A' }),
        makeSession({ id: 's2', title: '会话 B' }),
      ]),
    )
    useBusySessionsMock.mockReturnValue([{ sessionId: 's2', status: { type: 'busy' } }] as never)
    renderPanel()

    fireEvent.click(screen.getByText('sessionsHub.filter'))
    fireEvent.click(screen.getByText('sessionsHub.filterWorking'))
    // s1 (idle) 被过滤掉
    expect(screen.queryByText('会话 A')).not.toBeInTheDocument()
    // s2 (working) 保留
    expect(screen.getByText('会话 B')).toBeInTheDocument()
  })

  it('按项目分组：同目录折叠到分组头', () => {
    useSessionContextMock.mockReturnValue(
      sessionCtx([
        makeSession({ id: 's1', directory: 'C:\\repo' }),
        makeSession({ id: 's2', directory: 'C:\\repo' }),
      ]),
    )
    const { container } = renderPanel()

    // 点击 topbar 之外的「分组」切换按钮开启分组
    fireEvent.click(screen.getByText('sessionsHub.groupByProject'))
    // getDirectoryName('C:\\repo') = 'repo'；分组头应该显示「repo · 2」
    // groupHeaderCount mock 返回 "sessionsHub.groupHeaderCount:2"，外加硬编码 "· "
    // 文本被拆到两个 span 中，用 textContent 校验父容器
    const groupHead = container.querySelector('[class*="uppercase"]')
    expect(groupHead?.textContent).toBe('repo· sessionsHub.groupHeaderCount:2')
  })

  it('点新建打开对话框，fake-create 后触发 onNewSession', () => {
    const onNewSession = vi.fn()
    useSessionContextMock.mockReturnValue(sessionCtx([]))
    renderPanel({ onNewSession })

    fireEvent.click(screen.getByTitle('sessionsHub.newChatDialogTitle'))
    fireEvent.click(screen.getByText('fake-create'))
    expect(onNewSession).toHaveBeenCalled()
  })

  it('点击会话条目触发 onSelectSession', () => {
    useSessionContextMock.mockReturnValue(sessionCtx([makeSession({ id: 's1' })]))
    const onSelect = vi.fn()
    renderPanel({ onSelectSession: onSelect })

    // SessionListItem 的 onClick 走 row 的 onClick（不是 hover 操作按钮）
    fireEvent.click(screen.getByText('会话 A'))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }))
  })

  it('删除当前选中会话会触发 onNewSession（fallback 行为）', async () => {
    deleteSessionMock.mockResolvedValue(true)
    useSessionContextMock.mockReturnValue(sessionCtx([makeSession({ id: 'current' })]))
    const onNewSession = vi.fn()
    renderPanel({ selectedSessionId: 'current', onNewSession })

    // 点 hover trash 按钮 → ConfirmDialog → 确认按钮
    fireEvent.click(screen.getByTitle('sessionsHub.deleteSession'))
    fireEvent.click(screen.getByText('sessionsHub.delete'))
    await act(async () => {})
    expect(deleteSessionMock).toHaveBeenCalledWith('current')
    expect(onNewSession).toHaveBeenCalled()
  })

  it('重命名会话走 updateSession + refresh', async () => {
    updateSessionMock.mockResolvedValue({})
    useSessionContextMock.mockReturnValue(sessionCtx([makeSession({ id: 'rn1', title: 'old' })]))
    renderPanel()

    // SessionListItem 重命名：点 pencil → input → Enter 提交
    fireEvent.click(screen.getByTitle('sessionsHub.renameSession'))
    const input = screen.getByDisplayValue('old')
    fireEvent.change(input, { target: { value: 'new title' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await act(async () => {})
    expect(updateSessionMock).toHaveBeenCalledWith('rn1', { title: 'new title' })
  })

  it('通知未读数显示为徽章数字', () => {
    useSessionContextMock.mockReturnValue(sessionCtx([]))
    useNotificationsMock.mockReturnValue([
      { id: 'n1', type: 'error', title: 't', body: 'b', sessionId: 'x', timestamp: 1, read: false },
      { id: 'n2', type: 'completed', title: 't', body: 'b', sessionId: 'y', timestamp: 2, read: true }, // 已读
    ])
    useUnreadNotificationCountMock.mockReturnValue(1)
    renderPanel()

    // 未读徽章应显示 "1"
    expect(screen.getByText('1')).toBeInTheDocument()
  })

  it('空通知时显示「暂无通知」', () => {
    useSessionContextMock.mockReturnValue(sessionCtx([]))
    useNotificationsMock.mockReturnValue([])
    renderPanel()

    fireEvent.click(screen.getByTitle('sessionsHub.notifications'))
    expect(screen.getByText('sessionsHub.noNotifications')).toBeInTheDocument()
  })
})
