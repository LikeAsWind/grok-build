// WorkbenchPage:工作台作为独立首页入口(#/workbench?dir=...)的页面外壳。
// ProjectSelector 永远顶部可见;WorkbenchPanel 内容区按当前 directory 渲染。
// 这里只验证外壳行为 + 路由交互(URL 是 selected directory 的 source of truth)。

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
let mockWorkbenchDirectory: string | undefined = undefined
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
vi.mock('./WorkbenchPanel', () => ({
  WorkbenchPanel: ({
    directory,
    projectCandidates,
    onSelectProject,
  }: {
    directory: string | undefined
    projectCandidates?: string[]
    onSelectProject?: (dir: string) => void
  }) => (
    <div data-testid="workbench-panel">
      <span data-testid="panel-directory">{directory ?? 'NONE'}</span>
      <span data-testid="panel-candidates">{(projectCandidates ?? []).join('|')}</span>
      <button onClick={() => onSelectProject?.('C:/repo/beta')}>pick-beta</button>
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

  it('没有工作目录时显示引导文案 + 占位提示,不渲染 WorkbenchPanel', () => {
    useCurrentDirectoryMock.mockReturnValue(undefined)
    render(<WorkbenchPage onOpenConfigSettings={() => {}} />)

    // 引导文案:WorkbenchProjectSelector 永远可见 + 内容区给"请选择"提示
    expect(screen.getByText('selectProjectPrompt')).toBeInTheDocument()
    expect(screen.getByText('selectProjectHint')).toBeInTheDocument()
    // 没 directory 时不渲染 WorkbenchPanel 内容区
    expect(screen.queryByTestId('workbench-panel')).not.toBeInTheDocument()
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

