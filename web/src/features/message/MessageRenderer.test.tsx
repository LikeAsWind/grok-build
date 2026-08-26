import type { ReactNode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MessageRenderer,
  groupPartsForRender,
  messageHasFinalContent,
  messageHasProcessContent,
  splitProcessRenderItems,
} from './MessageRenderer'
import type { Message, Part, StepFinishPart, TextPart, ToolPart } from '../../types/message'

let mockRenderUserMarkdown = false
let mockCollapseUserMessages = false

vi.mock('motion/mini', () => ({
  animate: () => Promise.resolve(),
}))

vi.mock('../../hooks', () => ({
  useDelayedRender: (show: boolean) => show,
  useDisclosureScrollLock: () => ({
    rootRef: () => undefined,
    headerRef: () => undefined,
    withScrollLock: (action: () => void) => action(),
  }),
}))

vi.mock('../../hooks/useInputCapabilities', () => ({
  useInputCapabilities: () => ({ preferTouchUi: false, canHover: true, hasCoarsePointer: false, hasTouch: false }),
}))

vi.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({
    collapseUserMessages: mockCollapseUserMessages,
    renderUserMarkdown: mockRenderUserMarkdown,
    stepFinishDisplay: { latestOnly: true, turnDuration: false, tokens: true, cache: true, cost: true, duration: true, agent: false, model: false, completedAt: false },
    actionsOnLatestAssistantOnly: true,
    descriptiveToolSteps: false,
    inlineToolRequests: false,
    immersiveMode: false,
  }),
}))

vi.mock('../../components/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div data-testid="user-markdown">{content}</div>,
}))

vi.mock('../../components/ui', () => ({
  CopyButton: ({ text }: { text: string }) => <button type="button">copy:{text}</button>,
  SmoothHeight: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock('./parts', () => ({
  TextPartView: ({ part }: { part: { text: string } }) => <div>{part.text}</div>,
  ReasoningPartView: () => null,
  ToolPartView: () => null,
  FilePartView: () => null,
  AgentPartView: () => null,
  SyntheticTextPartView: () => null,
  StepFinishPartView: () => <div data-testid="step-finish">step usage</div>,
  SubtaskPartView: () => null,
  RetryPartView: () => null,
  CompactionPartView: () => <div>History compacted</div>,
  MessageErrorView: () => null,
}))

function createAssistantMessage(): Message {
  return {
    info: {
      id: 'assistant-1',
      sessionID: 'session-1',
      role: 'assistant',
      parentID: 'user-1',
      modelID: 'model-1',
      providerID: 'provider-1',
      mode: 'chat',
      agent: 'build',
      path: { cwd: '/workspace', root: '/workspace' },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      time: { created: 1 },
    },
    parts: [
      {
        id: 'text-1',
        sessionID: 'session-1',
        messageID: 'assistant-1',
        type: 'text',
        text: 'assistant reply',
      },
    ],
    isStreaming: false,
  }
}

function createUserMessage(): Message {
  return {
    info: {
      id: 'user-1',
      sessionID: 'session-1',
      role: 'user',
      time: { created: 1 },
      agent: 'build',
      model: { modelID: 'model-1', providerID: 'provider-1' },
    },
    parts: [],
    isStreaming: false,
  }
}

function createUserTextMessage(text: string): Message {
  const message = createUserMessage()
  message.parts = [
    {
      id: 'text-user-1',
      sessionID: 'session-1',
      messageID: 'user-1',
      type: 'text',
      text,
    },
  ]
  return message
}

describe('MessageRenderer assistant fork', () => {
  beforeEach(() => {
    mockRenderUserMarkdown = false
    mockCollapseUserMessages = false
  })

  it('passes the explicit fork target id when forking an assistant message', async () => {
    const onFork = vi.fn()
    const message = createAssistantMessage()

    render(<MessageRenderer message={message} onFork={onFork} forkMessageId="assistant-2" />)

    fireEvent.click(screen.getByRole('button', { name: /fork|分叉/i }))

    await waitFor(() => {
      expect(onFork).toHaveBeenCalledWith(message, 'assistant-2')
    })
  })

  it('hides fork when the assistant message has no copyable text', () => {
    const onFork = vi.fn()
    const message = createAssistantMessage()
    message.parts = [
      {
        id: 'text-blank',
        sessionID: 'session-1',
        messageID: 'assistant-1',
        type: 'text',
        text: '   ',
      },
    ]

    render(<MessageRenderer message={message} onFork={onFork} forkMessageId="assistant-2" />)

    expect(screen.queryByRole('button', { name: /fork|分叉/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /copy/i })).toBeNull()
  })

  it('renders compaction parts inside user messages', () => {
    const message = createUserMessage()
    message.parts = [
      {
        id: 'compaction-1',
        sessionID: 'session-1',
        messageID: 'user-1',
        type: 'compaction',
        auto: true,
        status: 'completed',
      },
    ]

    render(<MessageRenderer message={message} />)

    expect(screen.getByText('History compacted')).toBeInTheDocument()
  })

  it('keeps user text plain by default', () => {
    render(<MessageRenderer message={createUserTextMessage('Use **bold** text')} />)

    expect(screen.queryByTestId('user-markdown')).toBeNull()
    expect(screen.getByText('Use **bold** text')).toBeInTheDocument()
  })

  it('renders user text through markdown when enabled', () => {
    mockRenderUserMarkdown = true

    render(<MessageRenderer message={createUserTextMessage('Use **bold** text')} />)

    expect(screen.getByTestId('user-markdown')).toHaveTextContent('Use **bold** text')
  })

  it('does not crop an interactive user HTML artifact to the collapsed preview height', () => {
    mockRenderUserMarkdown = true
    mockCollapseUserMessages = true
    const message = createUserTextMessage(
      '<section><style>section{height:380px}</style><canvas></canvas><script>requestAnimationFrame(()=>{})</script></section>',
    )

    render(<MessageRenderer message={message} />)

    const container = screen.getByTestId('user-markdown').parentElement!
    expect(container.style.maxHeight).toBe('')
    expect(container.style.contain).toBe('')
    expect(screen.getByTestId('user-markdown').closest('.bg-bg-300')).toHaveClass('w-full', 'max-w-2xl')
    expect(screen.getByTestId('user-markdown').closest('.group')).toHaveClass('w-full')
    expect(screen.getByTestId('user-markdown').closest('[data-user-html-artifact]')).toBeInTheDocument()
  })

  it('clamps a collapsible non-artifact user message with layout isolation', () => {
    mockRenderUserMarkdown = true
    mockCollapseUserMessages = true
    render(<MessageRenderer message={createUserTextMessage('just some plain text')} />)

    const container = screen.getByTestId('user-markdown').parentElement!
    expect(container.style.maxHeight).not.toBe('')
    expect(container.style.contain).toBe('layout paint')
  })
})

describe('process content split', () => {
  function createCompletedAssistant(parts: Part[]): Message {
    return {
      info: {
        id: 'assistant-1',
        sessionID: 'session-1',
        role: 'assistant',
        parentID: 'user-1',
        modelID: 'model-1',
        providerID: 'provider-1',
        mode: 'chat',
        agent: 'build',
        path: { cwd: '/workspace', root: '/workspace' },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        time: { created: 1, completed: 2 },
      },
      parts,
      isStreaming: false,
    }
  }

  it('keeps streaming assistant as process-only until completed', () => {
    const streaming: Message = {
      ...createCompletedAssistant([
        {
          id: 'text-1',
          sessionID: 'session-1',
          messageID: 'assistant-1',
          type: 'text',
          text: 'partial',
        } satisfies TextPart,
      ]),
      isStreaming: true,
      info: {
        ...createCompletedAssistant([]).info,
        time: { created: 1 },
      },
    }

    expect(messageHasProcessContent(streaming)).toBe(true)
    expect(messageHasFinalContent(streaming)).toBe(false)
  })

  it('splits completed tool+text into process and final', () => {
    const message = createCompletedAssistant([
      {
        id: 'tool-1',
        sessionID: 'session-1',
        messageID: 'assistant-1',
        type: 'tool',
        callID: 'call-1',
        tool: 'bash',
        state: {
          status: 'completed',
          input: { command: 'pwd' },
          output: '/workspace',
          title: 'pwd',
          metadata: {},
          time: { start: 1, end: 2 },
        },
      } satisfies ToolPart,
      {
        id: 'text-1',
        sessionID: 'session-1',
        messageID: 'assistant-1',
        type: 'text',
        text: 'done',
      } satisfies TextPart,
      {
        id: 'step-1',
        sessionID: 'session-1',
        messageID: 'assistant-1',
        type: 'step-finish',
        reason: 'stop',
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      } satisfies StepFinishPart,
    ])

    expect(messageHasProcessContent(message)).toBe(true)
    expect(messageHasFinalContent(message)).toBe(true)

    // splitProcessRenderItems is covered via scope rendering; pure text has final only
    const plain = createCompletedAssistant([
      {
        id: 'text-2',
        sessionID: 'session-1',
        messageID: 'assistant-1',
        type: 'text',
        text: 'hello',
      } satisfies TextPart,
    ])
    expect(messageHasProcessContent(plain)).toBe(false)
    expect(messageHasFinalContent(plain)).toBe(true)
    void splitProcessRenderItems
  })
})

describe('groupPartsForRender step-finish 排序', () => {
  const stepFinish = (id: string): StepFinishPart => ({
    id,
    sessionID: 'session-1',
    messageID: 'assistant-1',
    type: 'step-finish',
    reason: 'stop',
    cost: 0,
    tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
  })

  const text = (id: string, value: string): TextPart => ({
    id,
    sessionID: 'session-1',
    messageID: 'assistant-1',
    type: 'text',
    text: value,
  })

  const tool = (id: string): ToolPart => ({
    id,
    sessionID: 'session-1',
    messageID: 'assistant-1',
    type: 'tool',
    callID: `call-${id}`,
    tool: 'bash',
    state: {
      status: 'completed',
      input: { command: 'pwd' },
      output: '/workspace',
      title: 'pwd',
      metadata: {},
      time: { start: 1, end: 2 },
    },
  })

  /** 回放帧序（后端 updates.jsonl 实测）：response_completed 先于聚合的正文帧 */
  it('把排在正文前的 step-finish 挪到正文之后', () => {
    const items = groupPartsForRender([stepFinish('step-1'), text('text-1', 'reply')])

    expect(items.map(item => (item.type === 'single' ? item.part.type : 'tool-group'))).toEqual([
      'text',
      'step-finish',
    ])
  })

  it('正文已在前面时保持原顺序不动', () => {
    const items = groupPartsForRender([text('text-1', 'reply'), stepFinish('step-1')])

    expect(items.map(item => (item.type === 'single' ? item.part.type : 'tool-group'))).toEqual([
      'text',
      'step-finish',
    ])
  })

  it('多步各自的 step-finish 都跟在本步正文之后', () => {
    const items = groupPartsForRender([
      stepFinish('step-1'),
      text('text-1', 'first'),
      stepFinish('step-2'),
      text('text-2', 'second'),
    ])

    expect(
      items.map(item => (item.type === 'single' ? `${item.part.type}:${item.part.id}` : 'tool-group')),
    ).toEqual(['text:text-1', 'step-finish:step-1', 'text:text-2', 'step-finish:step-2'])
  })

  it('step-finish 排在 tool 之前时并入 tool group 而不是单独顶到上方', () => {
    const items = groupPartsForRender([stepFinish('step-1'), tool('tool-1')])

    expect(items).toHaveLength(1)
    expect(items[0].type).toBe('tool-group')
  })

  it('整条消息只有 step-finish（空回复）时不丢用量栏', () => {
    const items = groupPartsForRender([stepFinish('step-1')])

    expect(items.map(item => (item.type === 'single' ? item.part.type : 'tool-group'))).toEqual([
      'step-finish',
    ])
  })

  it('渲染到 DOM 后 Step 栏在回复正文之下', () => {
    const message: Message = {
      info: {
        id: 'assistant-1',
        sessionID: 'session-1',
        role: 'assistant',
        parentID: 'user-1',
        modelID: 'model-1',
        providerID: 'provider-1',
        mode: 'chat',
        agent: 'build',
        path: { cwd: '/workspace', root: '/workspace' },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, completed: 2 },
      },
      // 回放帧序：用量帧在正文帧之前
      parts: [stepFinish('step-1'), text('text-1', 'assistant reply')],
      isStreaming: false,
    }

    const { container } = render(<MessageRenderer message={message} />)

    const replyNode = screen.getByText('assistant reply')
    const stepNode = screen.getByTestId('step-finish')
    // Node.DOCUMENT_POSITION_FOLLOWING = 4：stepNode 在 replyNode 之后
    expect(replyNode.compareDocumentPosition(stepNode) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    void container
  })
})
