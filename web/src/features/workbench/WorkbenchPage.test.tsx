// WorkbenchPage:工作台作为独立首页入口(#/workbench?dir=...)的页面外壳。
// ProjectSelector 永远顶部可见;WorkbenchPanel 永远渲染(directory=undefined 时退化为
// 空任务框 + "选个任务查看"提示)。这里只验证外壳行为 + 路由交互。

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchPage } from './WorkbenchPage'

const { useCurrentDirectoryMock, useSessionContextMock, useRouterMock } = vi.hoisted(() => ({
  useCurrentDirectoryMock: vi.fn(),
  useSessionContextMock: vi.fn(),
  // mock 一个会随 navigateToWorkbench 变化的 workbenchDirectory state
  useRouterMock: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../../contexts/useDirectory', () => ({
  useCurrentDirectory: () => useCurrentDirectoryMock(),
}))

vi.mock('../../contexts/useSessionContext', () => ({
  useSessionContext: () => useSessionContextMock(),
}))

// useRouter mock:每个测试可以独立设置 workbenchDirectory + 捕获 navigateToWorkbench 调用
let mockWorkbenchDirectory: string | null | undefined = undefined
const mockNavigateToWorkbench = vi.fn()
useRouterMock.mockImplementation(() => ({
  workbenchDirectory: mockWorkbenchDirectory,
  navigateToWorkbench: (dir: string) => {
    mockWorkbenchDirectory = dir
    mockNavigateToWorkbench(dir)
    // 触发组件重渲染 — 通过调度一个 forceUpdate
  },
}))

vi.mock('../../hooks/useRouter', () => ({
  useRouter: () => useRouterMock(),
}))

// 替身把收到的 props 暴露成 DOM,便于断言目录与候选列表
// 候选目录排序 + 点选调用 navigateToWorkbench 这条线现在走 WorkbenchProjectSelector
// (内层 WorkbenchHeader 不再重复渲染选择器)。把选择器 mock 暴露 candidates + pick-beta 按钮。
vi.mock('./WorkbenchProjectSelector', () => ({
  WorkbenchProjectSelector: ({
    directory,
    candidates,
    onSelect,
  }: {
    directory: string | undefined
    candidates: string[]
    onSelect: (dir: string) => void
  }) => (
    <div data-testid="workbench-project-selector">
      <span data-testid="panel-directory">{directory ?? 'NONE'}</span>
      <span data-testid="panel-candidates">{candidates.join('|')}</span>
      <button onClick={() => onSelect('C:/repo/beta')}>pick-beta</button>
    </div>
  ),
}))

vi.mock('./WorkbenchPanel', () => ({
  WorkbenchPanel: ({ directory }: { directory: string | undefined; onOpenSettings: () => void }) => (
    <div data-testid="workbench-panel">
      <span data-testid="panel-inner-directory">{directory ?? 'NONE'}</span>
    </div>
  ),
}))

function sessionCtx(directories: (string | undefined)[]) {
  return { sessions: directories.map((directory, i) => ({ id: 's' + i, directory })) }
}

beforeEach(() => {
  mockWorkbenchDirectory = undefined
  mockNavigateToWorkbench.mockReset()
  useCurrentDirectoryMock.mockReset()
  useSessionContextMock.mockReset()
  useSessionContextMock.mockReturnValue(sessionCtx([]))
})

describe('WorkbenchPage', () => {
  it('有工作目录时渲染工作台面板并把目录传下去', () => {
    useCurrentDirectoryMock.mockReturnValue('C:/repo')
    render(<WorkbenchPage onOpenConfigSettings={() => {}} />)

    expect(screen.getByTestId('panel-directory')).toHaveTextContent('C:/repo')
    expect(screen.queryByText('noDirectoryTitle')).not.toBeInTheDocument()
  })

  it('没有工作目录时仍渲染 WorkbenchPanel(directory=undefined),不再出"请选择工作目录"提示卡片', () => {
    useCurrentDirectoryMock.mockReturnValue(undefined)
    render(<WorkbenchPage onOpenConfigSettings={() => {}} />)

    // 任务框本身保持可见 —— Panel 拿到 undefined,由 Panel 内部用 selectTaskToView 空态
    expect(screen.getByTestId('workbench-panel')).toBeInTheDocument()
    expect(screen.getByTestId('panel-directory')).toHaveTextContent('NONE')
    // 老的"请选择工作目录"提示卡片去掉了
    expect(screen.queryByText('selectProjectPrompt')).not.toBeInTheDocument()
    expect(screen.queryByText('selectProjectHint')).not.toBeInTheDocument()
  })

  it('initialDirectory(进入前所处会话的目录)优先于全局当前目录', () => {
    useCurrentDirectoryMock.mockReturnValue('C:/repo/global')
    render(<WorkbenchPage onOpenConfigSettings={() => {}} initialDirectory="C:/repo/from-session" />)

    expect(screen.getByTestId('panel-directory')).toHaveTextContent('C:/repo/from-session')
  })

  it('候选目录来自会话列表 + 当前目录,去重后按项目名排序', () => {
    useCurrentDirectoryMock.mockReturnValue('C:/repo/alpha')
    useSessionContextMock.mockReturnValue(
      sessionCtx(['C:/repo/beta', 'C:/repo/alpha', undefined, 'C:/repo/beta']),
    )
    render(<WorkbenchPage onOpenConfigSettings={() => {}} />)

    expect(screen.getByTestId('panel-candidates')).toHaveTextContent('C:/repo/alpha|C:/repo/beta')
  })

  it('大小写不同的同一目录只算一个候选(Windows 路径)', () => {
    useCurrentDirectoryMock.mockReturnValue('C:/Repo/Alpha')
    useSessionContextMock.mockReturnValue(sessionCtx(['c:/repo/alpha']))
    render(<WorkbenchPage onOpenConfigSettings={() => {}} />)

    expect(screen.getByTestId('panel-candidates')).toHaveTextContent('C:/Repo/Alpha')
    expect(screen.getByTestId('panel-candidates').textContent).not.toContain('|')
  })

  it('点切换项目调用 navigateToWorkbench 并把选中目录写入 URL', () => {
    useCurrentDirectoryMock.mockReturnValue('C:/repo/alpha')
    useSessionContextMock.mockReturnValue(sessionCtx(['C:/repo/beta']))
    render(<WorkbenchPage onOpenConfigSettings={() => {}} />)

    fireEvent.click(screen.getByText('pick-beta'))
    expect(mockNavigateToWorkbench).toHaveBeenCalledWith('C:/repo/beta')
  })

  it('默认目录(initialDirectory)变化时跟随,因为 URL 没 workbenchDirectory', () => {
    useCurrentDirectoryMock.mockReturnValue(undefined)
    const { rerender } = render(
      <WorkbenchPage onOpenConfigSettings={() => {}} initialDirectory="C:/repo/alpha" />,
    )
    expect(screen.getByTestId('panel-directory')).toHaveTextContent('C:/repo/alpha')

    // 默认目录变了 → 内容区跟着变(URL 路由没动,所以仍然走 defaultDirectory fallback)
    rerender(<WorkbenchPage onOpenConfigSettings={() => {}} initialDirectory="C:/repo/gamma" />)
    expect(screen.getByTestId('panel-directory')).toHaveTextContent('C:/repo/gamma')
  })
})

