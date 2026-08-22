import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionListItem } from './SessionListItem'
import type { ApiSession } from '../../api'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: { count?: number }) => (opts?.count !== undefined ? `${key}:${opts.count}` : key) }),
}))

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
    expect(screen.getByText(/^sessionsHub\.(justNow|minutesAgo|hoursAgo|daysAgo)/)).toBeInTheDocument()
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
    expect(screen.getByText('sessionsHub.untitled')).toBeInTheDocument()
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
    fireEvent.click(screen.getByTitle('sessionsHub.deleteSession'))
    fireEvent.click(screen.getByText('confirm'))
    expect(onDelete).toHaveBeenCalledWith('s1')
  })

  it('indent=true 时有 data-indent 标记；默认（未传）时没有', () => {
    const { container, rerender } = render(
      <SessionListItem
        session={makeSession()}
        isSelected={false}
        uiStatus={{ kind: 'idle' }}
        onSelect={() => {}}
        onRename={() => Promise.resolve()}
        onDelete={() => Promise.resolve()}
      />,
    )
    expect(container.querySelector('[data-indent="false"]')).not.toBeNull()

    rerender(
      <SessionListItem
        session={makeSession()}
        isSelected={false}
        uiStatus={{ kind: 'idle' }}
        onSelect={() => {}}
        onRename={() => Promise.resolve()}
        onDelete={() => Promise.resolve()}
        indent
      />,
    )
    expect(container.querySelector('[data-indent="true"]')).not.toBeNull()
  })

  describe('diff stats', () => {
    it('显示实时统计（isLive: true），无 stale 提示', () => {
      const { container } = render(
        <SessionListItem
          session={makeSession()}
          isSelected={false}
          uiStatus={{ kind: 'idle' }}
          onSelect={() => {}}
          onRename={() => Promise.resolve()}
          onDelete={() => Promise.resolve()}
          diffStats={{ additions: 10, deletions: 5, files: 2, isLive: true }}
        />,
      )
      expect(screen.getByText('+10')).toBeInTheDocument()
      expect(screen.getByText('-5')).toBeInTheDocument()
      expect(screen.getByText('2f')).toBeInTheDocument()
      expect(container.querySelector('[title="sessionsHub.diffStatsStale"]')).toBeNull()
      // isLive: true 时用绿/红上色，不能退化成 stale 的灰色
      expect(container.querySelector('.text-green-500')).not.toBeNull()
      expect(container.querySelector('.text-red-500')).not.toBeNull()
    })

    it('显示落盘快照并用灰色提示（isLive: false）', () => {
      const { container } = render(
        <SessionListItem
          session={makeSession()}
          isSelected={false}
          uiStatus={{ kind: 'idle' }}
          onSelect={() => {}}
          onRename={() => Promise.resolve()}
          onDelete={() => Promise.resolve()}
          diffStats={{ additions: 10, deletions: 5, files: 2, isLive: false }}
        />,
      )
      expect(screen.getByText('+10')).toBeInTheDocument()
      expect(screen.getByText('-5')).toBeInTheDocument()
      expect(screen.getByText('2f')).toBeInTheDocument()
      expect(container.querySelector('[title="sessionsHub.diffStatsStale"]')).not.toBeNull()
      // isLive: false 时 additions/deletions 也退化成灰色，不能仍然是绿/红
      expect(container.querySelector('.text-green-500')).toBeNull()
      expect(container.querySelector('.text-red-500')).toBeNull()
    })

    it('无统计数据时不显示 diff 行', () => {
      render(
        <SessionListItem
          session={makeSession()}
          isSelected={false}
          uiStatus={{ kind: 'idle' }}
          onSelect={() => {}}
          onRename={() => Promise.resolve()}
          onDelete={() => Promise.resolve()}
          diffStats={null}
        />,
      )
      expect(screen.queryByText(/^\+/)).toBeNull()
      expect(screen.queryByText(/f$/)).toBeNull()
    })
  })
})