import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ToolPart } from '../../../../types/message'
import { QuestionRenderer } from './QuestionRenderer'

const SELECTED_CLASS = 'border-text-100'

function makePart(input: Record<string, unknown>, output: string, metadata: Record<string, unknown> = {}): ToolPart {
  return {
    id: 'part-1',
    sessionID: 's1',
    messageID: 'm1',
    type: 'tool',
    callID: 'call-1',
    tool: 'ask_user_question',
    state: {
      status: 'completed',
      input,
      output,
      title: '询问了 1 个问题',
      metadata,
      time: { start: 1, end: 2 },
    },
  }
}

function chipFor(container: HTMLElement, label: string): HTMLElement {
  const chips = Array.from(container.querySelectorAll('span[title]')) as HTMLElement[]
  const chip = chips.find(c => c.textContent?.trim() === label)
  if (!chip) throw new Error(`chip "${label}" not found`)
  return chip
}

const colorQuestionInput = {
  questions: [
    {
      question: '你最喜欢哪种颜色?',
      header: '颜色',
      options: [
        { label: '红', description: '' },
        { label: '绿', description: '' },
        { label: '蓝', description: '' },
      ],
    },
  ],
}

describe('QuestionRenderer 答案高亮匹配', () => {
  it('output 键为 q{idx} 兜底格式时仍高亮所选选项', () => {
    const part = makePart(
      colorQuestionInput,
      'User has answered your questions: "q0"="红". You can now continue with the user\'s answers in mind.',
    )
    const { container } = render(<QuestionRenderer part={part} data={{ output: part.state.output }} />)

    expect(chipFor(container, '红').className).toContain(SELECTED_CLASS)
    expect(chipFor(container, '绿').className).not.toContain(SELECTED_CLASS)
    expect(chipFor(container, '蓝').className).not.toContain(SELECTED_CLASS)
  })

  it('output 键为 header 时仍高亮所选选项', () => {
    const part = makePart(colorQuestionInput, 'User has answered your questions: "颜色"="红".')
    const { container } = render(<QuestionRenderer part={part} data={{ output: part.state.output }} />)

    expect(chipFor(container, '红').className).toContain(SELECTED_CLASS)
  })

  it('output 键为问题原文时高亮所选选项（既有行为不回归）', () => {
    const part = makePart(colorQuestionInput, 'User has answered your questions: "你最喜欢哪种颜色?"="红".')
    const { container } = render(<QuestionRenderer part={part} data={{ output: part.state.output }} />)

    expect(chipFor(container, '红').className).toContain(SELECTED_CLASS)
  })
})
