import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiQuestionRequest } from '../../api'
import { InlineQuestion } from './InlineQuestion'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const request: ApiQuestionRequest = {
  id: 'req-1',
  sessionID: 's1',
  questions: [
    {
      question: '你最喜欢哪种颜色?',
      header: '颜色',
      options: [
        { label: '红', description: '' },
        { label: '绿', description: '' },
      ],
    },
  ],
} as ApiQuestionRequest

describe('InlineQuestion 提交', () => {
  it('提交时把 questions 结构转发给 onReply（供 replyQuestion 以问题文本为键）', () => {
    const onReply = vi.fn()
    render(<InlineQuestion request={request} onReply={onReply} onReject={vi.fn()} isReplying={false} />)

    fireEvent.click(screen.getByRole('button', { name: '红' }))
    fireEvent.click(screen.getByRole('button', { name: 'common:submit' }))

    expect(onReply).toHaveBeenCalledWith('req-1', [['红']], request.questions)
  })
})
