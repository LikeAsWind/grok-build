// SessionHubPanel 集成测试：覆盖全局列表、状态筛选、按项目分组、新建会话集成。
// 依赖：useSessionContext（侧栏数据源）+ useBusySessions（busy 状态）+ useNotifications（铃铛）。
// 轻量 mock：NewSessionDialog 用一个最简的 fake 替身，验证面板开关状态机即可。

import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionHubPanel } from './SessionHubPanel'
import { sessionHubViewStore } from '../../store/sessionHubViewStore'
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
  restoreAllChildSessionsMock,
  getSessionInfoMock,
  childSessionSubscribeMock,
  childSessionGetVersionMock,
  useLayoutStoreMock,
  useVcsInfoMock,
  useDirectoryMock,
} = vi.hoisted(() => ({
  useSessionContextMock: vi.fn(),
  useBusySessionsMock: vi.fn(),
  useNotificationsMock: vi.fn(),
  useUnreadNotificationCountMock: vi.fn(() => 0),
  updateSessionMock: vi.fn().mockResolvedValue(undefined),
  restoreAllChildSessionsMock: vi.fn(),
  getSessionInfoMock: vi.fn(),
  childSessionSubscribeMock: vi.fn((_cb: () => void) => () => {}),
  childSessionGetVersionMock: vi.fn(() => 0),
  useLayoutStoreMock: vi.fn(),
  useVcsInfoMock: vi.fn(() => ({ vcsInfo: null, isLoading: false, error: null, refresh: vi.fn() })),
  useDirectoryMock: vi.fn(() => ({ currentDirectory: undefined, recentProjects: {}, touchDirectory: vi.fn() })),
}))

// ProjectGroupHeader（文件夹视图分组头）依赖 useVcsInfo（真实会发起网络请求获取分支信息）
// 和 useDirectory（需要 DirectoryProvider，测试没有套这层 Provider）——都 mock 掉。
vi.mock('../../hooks/useVcsInfo', () => ({
  useVcsInfo: () => useVcsInfoMock(),
}))

vi.mock('../../contexts/useDirectory', () => ({
  useDirectory: () => useDirectoryMock(),
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

vi.mock('../../store/childSessionStore', () => ({
  childSessionStore: {
    getSessionInfo: (id: string) => getSessionInfoMock(id),
    subscribe: (cb: () => void) => childSessionSubscribeMock(cb),
    getVersion: () => childSessionGetVersionMock(),
  },
}))

vi.mock('../../store/layoutStore', () => ({
  useLayoutStore: () => useLayoutStoreMock(),
}))

vi.mock('../message/synthNotifPersist', () => ({
  restoreAllChildSessions: () => restoreAllChildSessionsMock(),
}))

vi.mock('../../api', () => ({
  updateSession: (...args: unknown[]) => updateSessionMock(...args),
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
    restoreAllChildSessionsMock.mockReset()
    getSessionInfoMock.mockReset()
    getSessionInfoMock.mockReturnValue(undefined)
    childSessionSubscribeMock.mockReset()
    childSessionSubscribeMock.mockReturnValue(() => {})
    childSessionGetVersionMock.mockReset()
    childSessionGetVersionMock.mockReturnValue(0)
    useLayoutStoreMock.mockReset()
    useLayoutStoreMock.mockReturnValue({ sidebarShowChildSessions: false })
    useVcsInfoMock.mockReset()
    useVcsInfoMock.mockReturnValue({ vcsInfo: null, isLoading: false, error: null, refresh: vi.fn() })
    useDirectoryMock.mockReset()
    useDirectoryMock.mockReturnValue({ currentDirectory: undefined, recentProjects: {}, touchDirectory: vi.fn() })
    // sessionHubViewStore 是模块级单例，viewMode 会持久化到 localStorage 并跨测试保留——
    // 每个测试前重置回默认的 list 视图，避免测试间互相污染。
    sessionHubViewStore.setViewMode('list')
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

  it('切换到文件夹视图：同目录会话折叠到分组头（项目名 + 会话数）', () => {
    useSessionContextMock.mockReturnValue(
      sessionCtx([
        makeSession({ id: 's1', directory: 'C:\\repo' }),
        makeSession({ id: 's2', directory: 'C:\\repo' }),
      ]),
    )
    const { container } = renderPanel()

    // 点击视图切换按钮，从列表视图切到文件夹视图
    fireEvent.click(screen.getByTitle('sessionsHub.viewFolder'))
    // getDirectoryName('C:\\repo') = 'repo'；ProjectGroupHeader（aria-expanded 按钮）
    // 渲染项目名 + 会话数（groupHeaderCount mock 返回 "sessionsHub.groupHeaderCount:2"）
    const groupHead = container.querySelector('button[aria-expanded]')
    expect(groupHead?.textContent).toContain('repo')
    expect(groupHead?.textContent).toContain('sessionsHub.groupHeaderCount:2')
  })

  it('点新建打开对话框，fake-create 后进入新会话（onSelectSession），而不是回首页', () => {
    const onNewSession = vi.fn()
    const onSelect = vi.fn()
    useSessionContextMock.mockReturnValue(sessionCtx([]))
    renderPanel({ onNewSession, onSelectSession: onSelect })

    fireEvent.click(screen.getByTitle('sessionsHub.newChatDialogTitle'))
    fireEvent.click(screen.getByText('fake-create'))
    expect(onSelect).toHaveBeenCalledWith({ id: 'new-1', directory: 'C:\\repo' })
    expect(onNewSession).not.toHaveBeenCalled()
  })

  it('点击会话条目触发 onSelectSession', () => {
    useSessionContextMock.mockReturnValue(sessionCtx([makeSession({ id: 's1' })]))
    const onSelect = vi.fn()
    renderPanel({ onSelectSession: onSelect })

    // SessionListItem 的 onClick 走 row 的 onClick（不是 hover 操作按钮）
    fireEvent.click(screen.getByText('会话 A'))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }))
  })

  it('删除当前选中会话走 SessionContext.deleteSession 并触发 onNewSession（fallback 行为）', async () => {
    const ctx = sessionCtx([makeSession({ id: 'current' })])
    useSessionContextMock.mockReturnValue(ctx)
    const onNewSession = vi.fn()
    renderPanel({ selectedSessionId: 'current', onNewSession })

    // 点 hover trash 按钮 → ConfirmDialog → 确认按钮
    fireEvent.click(screen.getByTitle('sessionsHub.deleteSession'))
    fireEvent.click(screen.getByText('sessionsHub.delete'))
    await act(async () => {})
    // 必须走 context 的 deleteSession（本地过滤 sessions state），不能直接调裸的 api.deleteSession——
    // 否则删除后列表不会刷新，UI 看起来像"点击没反应"（回归测试保护这个具体的 bug）。
    expect(ctx.deleteSession).toHaveBeenCalledWith('current')
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

  it('挂载时调用 restoreAllChildSessions 预热子会话映射', () => {
    useSessionContextMock.mockReturnValue(sessionCtx([]))
    renderPanel()
    expect(restoreAllChildSessionsMock).toHaveBeenCalled()
  })

  it('子会话嵌套显示在父会话下，标题为空时 fallback 到 childSessionStore 记录的描述', () => {
    useLayoutStoreMock.mockReturnValue({ sidebarShowChildSessions: true })
    getSessionInfoMock.mockImplementation((id: string) =>
      id === 'child-1'
        ? { id: 'child-1', parentID: 'parent-1', title: '子任务描述', status: 'running', createdAt: 1 }
        : undefined,
    )
    useSessionContextMock.mockReturnValue(
      sessionCtx([
        makeSession({ id: 'parent-1', title: '父会话' }),
        // roster 还没回写子会话标题（后端异步），title 为空
        makeSession({ id: 'child-1', title: '' }),
      ]),
    )
    renderPanel()

    expect(screen.getByText('父会话')).toBeInTheDocument()
    expect(screen.getByText('子任务描述')).toBeInTheDocument()
    expect(screen.queryByText('sessionsHub.untitled')).not.toBeInTheDocument()
  })

  it('开关关闭时，非忙碌且未选中的子会话被隐藏', () => {
    useLayoutStoreMock.mockReturnValue({ sidebarShowChildSessions: false })
    getSessionInfoMock.mockImplementation((id: string) =>
      id === 'child-1'
        ? { id: 'child-1', parentID: 'parent-1', title: '子会话标题', status: 'idle', createdAt: 1 }
        : undefined,
    )
    useSessionContextMock.mockReturnValue(
      sessionCtx([
        makeSession({ id: 'parent-1', title: '父会话' }),
        makeSession({ id: 'child-1', title: '子会话标题' }),
      ]),
    )
    renderPanel({ selectedSessionId: null })

    expect(screen.getByText('父会话')).toBeInTheDocument()
    expect(screen.queryByText('子会话标题')).not.toBeInTheDocument()
  })

  it('开关打开时，所有已知子会话都显示（不论忙碌或选中状态）', () => {
    useLayoutStoreMock.mockReturnValue({ sidebarShowChildSessions: true })
    getSessionInfoMock.mockImplementation((id: string) => {
      if (id === 'child-a') return { id: 'child-a', parentID: 'parent-1', title: 'A', status: 'idle', createdAt: 1 }
      if (id === 'child-b') return { id: 'child-b', parentID: 'parent-1', title: 'B', status: 'idle', createdAt: 2 }
      return undefined
    })
    useSessionContextMock.mockReturnValue(
      sessionCtx([
        makeSession({ id: 'parent-1', title: '父会话' }),
        makeSession({ id: 'child-a', title: '子会话 A' }),
        makeSession({ id: 'child-b', title: '子会话 B' }),
      ]),
    )
    renderPanel({ selectedSessionId: null })

    expect(screen.getByText('子会话 A')).toBeInTheDocument()
    expect(screen.getByText('子会话 B')).toBeInTheDocument()
  })

  describe('工作台入口', () => {
    it('点击调用 onOpenWorkbench', () => {
      const onOpenWorkbench = vi.fn()
      useSessionContextMock.mockReturnValue(sessionCtx([]))
      renderPanel({ onOpenWorkbench })

      fireEvent.click(screen.getByLabelText('sidebar.workbench'))
      expect(onOpenWorkbench).toHaveBeenCalledTimes(1)
    })

    it('位置在「新对话」之上', () => {
      const onOpenWorkbench = vi.fn()
      useSessionContextMock.mockReturnValue(sessionCtx([]))
      renderPanel({ onOpenWorkbench })

      const workbench = screen.getByLabelText('sidebar.workbench')
      const newChat = screen.getByLabelText('sidebar.newChat')
      // DOCUMENT_POSITION_FOLLOWING = 4：newChat 在 workbench 之后
      expect(workbench.compareDocumentPosition(newChat) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it('active 时标记 aria-current，非 active 时不标记', () => {
      useSessionContextMock.mockReturnValue(sessionCtx([]))
      const { unmount } = renderPanel({ onOpenWorkbench: vi.fn(), isWorkbenchActive: true })
      expect(screen.getByLabelText('sidebar.workbench')).toHaveAttribute('aria-current', 'page')
      unmount()

      renderPanel({ onOpenWorkbench: vi.fn(), isWorkbenchActive: false })
      expect(screen.getByLabelText('sidebar.workbench')).not.toHaveAttribute('aria-current')
    })

    it('未传 onOpenWorkbench 时不渲染入口（不给死按钮）', () => {
      useSessionContextMock.mockReturnValue(sessionCtx([]))
      renderPanel()

      expect(screen.queryByLabelText('sidebar.workbench')).not.toBeInTheDocument()
      expect(screen.getByLabelText('sidebar.newChat')).toBeInTheDocument()
    })
  })
})

