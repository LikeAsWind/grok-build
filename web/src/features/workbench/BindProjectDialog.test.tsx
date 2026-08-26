// BindProjectDialog：预填当前生效绑定 + 粘贴 TAPD 链接解析 workspace +
// 写入 config.toml。patchGrokConfig 打桩，断言写出的 patch 内容。

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BindProjectDialog } from './BindProjectDialog'
import { slugForDirectory } from './tapdBinding'
import type { TapdBinding } from '../../api/tapd'

const { patchGrokConfigMock } = vi.hoisted(() => ({
  patchGrokConfigMock: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../../api/grokConfig', () => ({
  patchGrokConfig: (...args: unknown[]) => patchGrokConfigMock(...args),
}))

vi.mock('../../components/ui/Dialog', () => ({
  Dialog: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div role="dialog">{children}</div> : null,
}))

vi.mock('../../components/ui/Button', () => ({
  Button: ({ children, onClick, disabled }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}))

const DIRECTORY = 'C:/repo/grok-build'

function binding(overrides: Partial<TapdBinding> = {}): TapdBinding {
  return {
    directory: DIRECTORY,
    workspaceId: '69280376',
    entityTypes: ['task'],
    moduleFilter: ['grok-build'],
    explicit: false,
    ...overrides,
  }
}

function inputs() {
  const all = screen.getAllByRole('textbox') as HTMLInputElement[]
  return { workspace: all[0], modules: all[1] }
}

describe('BindProjectDialog', () => {
  beforeEach(() => {
    patchGrokConfigMock.mockReset()
    patchGrokConfigMock.mockResolvedValue(undefined)
  })

  it('用当前生效的绑定预填（继承来的默认值也要可见）', () => {
    render(<BindProjectDialog isOpen directory={DIRECTORY} binding={binding()} onClose={vi.fn()} onBound={vi.fn()} />)

    const { workspace, modules } = inputs()
    expect(workspace.value).toBe('69280376')
    expect(modules.value).toBe('grok-build')
  })

  it('没有绑定时模块默认取目录名小写', () => {
    render(<BindProjectDialog isOpen directory={DIRECTORY} onClose={vi.fn()} onBound={vi.fn()} />)

    const { workspace, modules } = inputs()
    expect(workspace.value).toBe('')
    expect(modules.value).toBe('grok-build')
  })

  it('粘贴 TAPD 链接自动解析 Workspace ID 后保存', async () => {
    const onBound = vi.fn()
    render(<BindProjectDialog isOpen directory={DIRECTORY} onClose={vi.fn()} onBound={onBound} />)

    fireEvent.change(inputs().workspace, {
      target: { value: 'https://www.tapd.cn/tapd_fe/69280376/iteration/card/1169280376001008721?q=abc' },
    })
    fireEvent.click(screen.getByText('confirm'))

    await waitFor(() => expect(patchGrokConfigMock).toHaveBeenCalledTimes(1))
    const slug = slugForDirectory(DIRECTORY)
    expect(patchGrokConfigMock).toHaveBeenCalledWith({
      set: [
        { path: ['tapd', 'projects', slug, 'directory'], value: DIRECTORY },
        { path: ['tapd', 'projects', slug, 'workspace_id'], value: '69280376' },
        { path: ['tapd', 'projects', slug, 'entity_types'], value: ['task'] },
        { path: ['tapd', 'projects', slug, 'module_filter'], value: ['grok-build'] },
        { path: ['tapd', 'projects', slug, 'enabled'], value: true },
      ],
    })
    expect(onBound).toHaveBeenCalled()
  })

  it('解析不出 Workspace ID 时报错且不写配置', async () => {
    render(<BindProjectDialog isOpen directory={DIRECTORY} onClose={vi.fn()} onBound={vi.fn()} />)

    fireEvent.change(inputs().workspace, { target: { value: 'https://www.tapd.cn/tapd_fe/company/home' } })
    fireEvent.click(screen.getByText('confirm'))

    await waitFor(() => expect(screen.getByText('workspaceIdInvalid')).toBeInTheDocument())
    expect(patchGrokConfigMock).not.toHaveBeenCalled()
  })

  it('可以手动改模块筛选；清空写成空数组（不筛选）', async () => {
    render(<BindProjectDialog isOpen directory={DIRECTORY} binding={binding()} onClose={vi.fn()} onBound={vi.fn()} />)

    fireEvent.change(inputs().modules, { target: { value: '' } })
    fireEvent.click(screen.getByText('confirm'))

    await waitFor(() => expect(patchGrokConfigMock).toHaveBeenCalled())
    const ops = patchGrokConfigMock.mock.calls[0][0].set as { path: string[]; value: unknown }[]
    expect(ops.find(o => o.path[3] === 'module_filter')!.value).toEqual([])
  })

  it('保存失败时显示错误且不关闭', async () => {
    patchGrokConfigMock.mockRejectedValue(new Error('写入失败'))
    const onClose = vi.fn()
    render(<BindProjectDialog isOpen directory={DIRECTORY} binding={binding()} onClose={onClose} onBound={vi.fn()} />)

    fireEvent.click(screen.getByText('confirm'))

    await waitFor(() => expect(screen.getByText('写入失败')).toBeInTheDocument())
    expect(onClose).not.toHaveBeenCalled()
  })
})
