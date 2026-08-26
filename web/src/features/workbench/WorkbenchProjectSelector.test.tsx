import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WorkbenchProjectSelector } from './WorkbenchProjectSelector'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

describe('WorkbenchProjectSelector', () => {
  const candidates = ['C:/repo/alpha', 'C:/repo/beta']

  it('只有一个候选时退化成纯标题（不给假下拉）', () => {
    render(<WorkbenchProjectSelector directory="C:/repo/alpha" candidates={['C:/repo/alpha']} onSelect={vi.fn()} />)

    expect(screen.getByText('alpha')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('多个候选时可展开并列出全部项目', () => {
    render(<WorkbenchProjectSelector directory="C:/repo/alpha" candidates={candidates} onSelect={vi.fn()} />)

    fireEvent.click(screen.getByRole('button'))
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(2)
    expect(screen.getByText('beta')).toBeInTheDocument()
    // 完整路径也显示，同名不同路径能区分
    expect(screen.getByText('C:/repo/beta')).toBeInTheDocument()
  })

  it('选中项标记 aria-selected', () => {
    render(<WorkbenchProjectSelector directory="C:/repo/beta" candidates={candidates} onSelect={vi.fn()} />)

    fireEvent.click(screen.getByRole('button'))
    const selected = screen.getAllByRole('option').filter(o => o.getAttribute('aria-selected') === 'true')
    expect(selected).toHaveLength(1)
    expect(selected[0]).toHaveTextContent('beta')
  })

  it('点选项回调目录并关闭下拉', () => {
    const onSelect = vi.fn()
    render(<WorkbenchProjectSelector directory="C:/repo/alpha" candidates={candidates} onSelect={onSelect} />)

    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText('beta'))

    expect(onSelect).toHaveBeenCalledWith('C:/repo/beta')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('点外部关闭下拉（浮层不会一直盖住任务列表）', () => {
    render(<WorkbenchProjectSelector directory="C:/repo/alpha" candidates={candidates} onSelect={vi.fn()} />)

    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('listbox')).toBeInTheDocument()

    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })
})
