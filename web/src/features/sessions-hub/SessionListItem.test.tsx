import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionListItem } from './SessionListItem'
import type { ApiSession } from '../../api'

vi.mock('../../components/ui/ConfirmDialog', () => ({
  ConfirmDialog: ({ isOpen, onConfirm, title }: { isOpen: boolean; onConfirm: () => void; title: string }) =>
    isOpen ? (
      <div role="dialog">
        {title}
        <button onClick={onConfirm}>confirm</button>
      </div>
    ) : null,
}))

function makeSession(overrides: Partial<ApiSession> = {}): ApiSession {
  return {
    id: 's1',
    directory: 'C:\\repo',
    title: '修登录 bug',
    version: '',
    time: { created: 1000, updated: 2000 },
    ...overrides,
  } as ApiSession
}

describe('SessionListItem', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-20T12:00:00Z'))
  })

  it('渲染标题、相对时间与目录名', () => {
    render(
      <SessionListItem
        session={makeSession()}
        isSelected={false}
        uiStatus={{ kind: 'idle' }}
        onSelect={() => {}}
        onRename={() => Promise.resolve()}
        onDelete={() => Promise.resolve()}
      />,
    )
    expect(screen.getByText('修登录 bug')).toBeInTheDocument()
    expect(screen.getByText('repo')).toBeInTheDocument()
    expect(screen.getByText(/前|刚刚/)).toBeInTheDocument()
  })

  it('选中态有 data-selected 标记', () => {
    const { container } = render(
      <SessionListItem
        session={makeSession()}
        isSelected={true}
        uiStatus={{ kind: 'idle' }}
        onSelect={() => {}}
        onRename={() => Promise.resolve()}
        onDelete={() => Promise.resolve()}
      />,
    )
    expect(container.querySelector('[data-selected="true"]')).not.toBeNull()
  })

  it('点击条目触发 onSelect', () => {
    const onSelect = vi.fn()
    render(
      <SessionListItem
        session={makeSession()}
        isSelected={false}
        uiStatus={{ kind: 'idle' }}
        onSelect={onSelect}
        onRename={() => Promise.resolve()}
        onDelete={() => Promise.resolve()}
      />,
    )
    fireEvent.click(screen.getByText('修登录 bug'))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }))
  })

  it('无标题显示占位文案', () => {
    render(
      <SessionListItem
        session={makeSession({ title: '' })}
        isSelected={false}
        uiStatus={{ kind: 'idle' }}
        onSelect={() => {}}
        onRename={() => Promise.resolve()}
        onDelete={() => Promise.resolve()}
      />,
    )
    expect(screen.getByText('未命名会话')).toBeInTheDocument()
  })

  it('删除需确认，确认后调用 onDelete', () => {
    const onDelete = vi.fn().mockResolvedValue(undefined)
    render(
      <SessionListItem
        session={makeSession()}
        isSelected={false}
        uiStatus={{ kind: 'idle' }}
        onSelect={() => {}}
        onRename={() => Promise.resolve()}
        onDelete={onDelete}
      />,
    )
    fireEvent.click(screen.getByTitle('删除会话'))
    fireEvent.click(screen.getByText('confirm'))
    expect(onDelete).toHaveBeenCalledWith('s1')
  })
})