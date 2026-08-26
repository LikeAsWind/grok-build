// WorkbenchPage：工作台作为独立首页入口的页面外壳 + 默认项目/项目候选逻辑。
// WorkbenchPanel（任务/同步/绑定逻辑）用 fake 替身，这里只验证外壳行为。

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchPage } from './WorkbenchPage'

const { useCurrentDirectoryMock, useSessionContextMock } = vi.hoisted(() => ({
  useCurrentDirectoryMock: vi.fn(),
  useSessionContextMock: vi.fn(),
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

// 替身把收到的 props 暴露成 DOM，便于断言目录与候选列表
vi.mock('./WorkbenchPanel', () => ({
  WorkbenchPanel: ({
    directory,
    projectCandidates,
    onSelectProject,
  }: {
    directory: string
    projectCandidates?: string[]
    onSelectProject?: (dir: string) => void
  }) => (
    <div data-testid="workbench-panel">
      <span data-testid="panel-directory">{directory}</span>
      <span data-testid="panel-candidates">{(projectCandidates ?? []).join('|')}</span>
      <button onClick={() => onSelectProject?.('C:/repo/beta')}>pick-beta</button>
    </div>
  ),
}))

function sessionCtx(directories: (string | undefined)[]) {
  return { sessions: directories.map((directory, i) => ({ id: `s${i}`, directory })) }
}

describe('WorkbenchPage', () => {
  beforeEach(() => {
    useCurrentDirectoryMock.mockReset()
    useSessionContextMock.mockReset()
    useSessionContextMock.mockReturnValue(sessionCtx([]))
  })

  it('有工作目录时渲染工作台面板并把目录传下去', () => {
    useCurrentDirectoryMock.mockReturnValue('C:/repo')
    render(<WorkbenchPage onOpenConfigSettings={() => {}} />)

    expect(screen.getByTestId('panel-directory')).toHaveTextContent('C:/repo')
    expect(screen.queryByText('noDirectoryTitle')).not.toBeInTheDocument()
  })

  it('没有工作目录时给出引导文案，而不是空白页', () => {
    useCurrentDirectoryMock.mockReturnValue(undefined)
    render(<WorkbenchPage onOpenConfigSettings={() => {}} />)

    expect(screen.getByText('noDirectoryTitle')).toBeInTheDocument()
    expect(screen.getByText('noDirectoryDescription')).toBeInTheDocument()
    expect(screen.queryByTestId('workbench-panel')).not.toBeInTheDocument()
  })

  it('initialDirectory（进入前所处会话的目录）优先于全局当前目录', () => {
    useCurrentDirectoryMock.mockReturnValue('C:/repo/global')
    render(<WorkbenchPage onOpenConfigSettings={() => {}} initialDirectory="C:/repo/from-session" />)

    expect(screen.getByTestId('panel-directory')).toHaveTextContent('C:/repo/from-session')
  })

  it('候选目录来自会话列表 + 当前目录，去重后按项目名排序', () => {
    useCurrentDirectoryMock.mockReturnValue('C:/repo/alpha')
    useSessionContextMock.mockReturnValue(
      sessionCtx(['C:/repo/beta', 'C:/repo/alpha', undefined, 'C:/repo/beta']),
    )
    render(<WorkbenchPage onOpenConfigSettings={() => {}} />)

    expect(screen.getByTestId('panel-candidates')).toHaveTextContent('C:/repo/alpha|C:/repo/beta')
  })

  it('大小写不同的同一目录只算一个候选（Windows 路径）', () => {
    useCurrentDirectoryMock.mockReturnValue('C:/Repo/Alpha')
    useSessionContextMock.mockReturnValue(sessionCtx(['c:/repo/alpha']))
    render(<WorkbenchPage onOpenConfigSettings={() => {}} />)

    expect(screen.getByTestId('panel-candidates')).toHaveTextContent('C:/Repo/Alpha')
    expect(screen.getByTestId('panel-candidates').textContent).not.toContain('|')
  })

  it('手动切换项目后展示所选项目', () => {
    useCurrentDirectoryMock.mockReturnValue('C:/repo/alpha')
    useSessionContextMock.mockReturnValue(sessionCtx(['C:/repo/beta']))
    render(<WorkbenchPage onOpenConfigSettings={() => {}} />)

    fireEvent.click(screen.getByText('pick-beta'))
    expect(screen.getByTestId('panel-directory')).toHaveTextContent('C:/repo/beta')
  })

  it('手动切换后不被默认目录变化覆盖', () => {
    useCurrentDirectoryMock.mockReturnValue('C:/repo/alpha')
    useSessionContextMock.mockReturnValue(sessionCtx(['C:/repo/beta']))
    const { rerender } = render(<WorkbenchPage onOpenConfigSettings={() => {}} initialDirectory="C:/repo/alpha" />)

    fireEvent.click(screen.getByText('pick-beta'))
    expect(screen.getByTestId('panel-directory')).toHaveTextContent('C:/repo/beta')

    // 默认目录变了（换了会话），但用户已手动选过 → 保持用户选择
    rerender(<WorkbenchPage onOpenConfigSettings={() => {}} initialDirectory="C:/repo/gamma" />)
    expect(screen.getByTestId('panel-directory')).toHaveTextContent('C:/repo/beta')
  })

  it('未手动切换时跟随默认目录变化（从别的会话进工作台）', () => {
    useCurrentDirectoryMock.mockReturnValue(undefined)
    const { rerender } = render(<WorkbenchPage onOpenConfigSettings={() => {}} initialDirectory="C:/repo/alpha" />)
    expect(screen.getByTestId('panel-directory')).toHaveTextContent('C:/repo/alpha')

    rerender(<WorkbenchPage onOpenConfigSettings={() => {}} initialDirectory="C:/repo/gamma" />)
    expect(screen.getByTestId('panel-directory')).toHaveTextContent('C:/repo/gamma')
  })
})
