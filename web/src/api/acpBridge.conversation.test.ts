// ============================================
// Web 对话交互全量可用性测试
// 模拟一条完整 ACP 会话流，逐项断言 TUI 对齐的对话工具在
// Web 转译层（acpBridge → events → messageStore）全部可用：
//   文本流 / thinking / 工具卡片 / plan→todo / 权限 / 提问 /
//   plan 审批 / 后台任务 / subagent / compaction / 重试错误 /
//   斜杠命令 / 模式切换 / 会话标题
// ============================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  handleAcpSessionUpdate,
  getAvailableCommands,
  getCurrentMode,
} from './acpBridge'
import { subscribeToEvents } from './events'
import { messageStore } from '../store/messageStore'
import {
  mapAcpPermissionToApi,
  mapAcpQuestionToApi,
  registerAcpResponder,
  consumeAcpResponder,
} from './acpPermissionBridge'
import {
  setPlanApprovalRequest,
  getPlanApprovalRequest,
  subscribePlanApproval,
} from '../store/planApprovalStore'
import type { ApiMessage, ApiPart } from './types'
import type { Part, ToolPart } from '../types/message'

let testSeq = 100
let SID = 'conv-session-0'

function update(u: Record<string, unknown>, sessionId = SID) {
  handleAcpSessionUpdate({ sessionId, update: u })
}

function textChunk(
  text: string,
  kind: 'agent_message_chunk' | 'agent_thought_chunk' | 'user_message_chunk' = 'agent_message_chunk',
) {
  update({ sessionUpdate: kind, content: { type: 'text', text } })
}

function parts(): Part[] {
  const messages = messageStore.getVisibleMessages(SID)
  return messages.flatMap(m => m.parts)
}

describe('Web 对话交互全量可用性', () => {
  let unsubscribe: (() => void) | null = null
  let todoEvents: Array<{ sessionID: string; todos: unknown[] }> = []
  let sessionErrors: unknown[] = []
  let sessionUpdated: unknown[] = []

  beforeEach(() => {
    SID = `conv-session-${++testSeq}`
    messageStore.clearAll()
    todoEvents = []
    sessionErrors = []
    sessionUpdated = []
    unsubscribe = subscribeToEvents({
      onMessageUpdated: (msg: ApiMessage) => messageStore.handleMessageUpdated(msg),
      onPartUpdated: (part: ApiPart) => {
        if ('sessionID' in part && 'messageID' in part) {
          messageStore.handlePartUpdated(part as ApiPart & { sessionID: string; messageID: string })
        }
      },
      onPartDelta: data => messageStore.handlePartDelta(data),
      onSessionIdle: data => messageStore.handleSessionIdle(data.sessionID),
      onTodoUpdated: data => todoEvents.push(data as { sessionID: string; todos: unknown[] }),
      onSessionError: err => sessionErrors.push(err),
      onSessionUpdated: info => sessionUpdated.push(info),
    })
  })

  afterEach(() => {
    unsubscribe?.()
    messageStore.clearAll()
    setPlanApprovalRequest(null)
  })

  // ── 1. 核心流式回路 ─────────────────────────────────────────

  it('文本流 + thinking + 工具卡片交错出现在同一条 assistant 消息', () => {
    textChunk('先想想', 'agent_thought_chunk')
    textChunk('我来读文件')
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      status: 'in_progress',
      rawInput: { path: 'a.txt' },
      _meta: { 'x.ai/tool': { name: 'read_file', kind: 'read', label: 'Read a.txt' } },
    })
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'hello' } }],
    })
    textChunk('读完了')

    const kinds = parts().map(p => p.type)
    expect(kinds).toEqual(['reasoning', 'text', 'tool', 'text'])
    const tool = parts().find(p => p.type === 'tool') as ToolPart
    expect(tool.tool).toBe('read_file')
    expect(tool.state.status).toBe('completed')
    expect(tool.state.output).toBe('hello')
  })

  it('历史回放的单条终态 tool_call（无后续 update）保留输入和输出', () => {
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'c-replay',
      status: 'completed',
      title: 'Fetch: https://example.com',
      rawInput: { url: 'https://example.com' },
      content: [{ type: 'content', content: { type: 'text', text: '<html>ok</html>' } }],
      _meta: { 'x.ai/tool': { name: 'web_fetch', kind: 'web_fetch', label: 'Web Fetch' } },
    })

    const tool = parts().find(p => p.type === 'tool') as ToolPart
    expect(tool.state.status).toBe('completed')
    expect(tool.state.input).toEqual({ url: 'https://example.com' })
    expect(tool.state.output).toBe('<html>ok</html>')
    expect(tool.state.title).toBe('Fetch: https://example.com')
  })

  it('历史回放 tool_call 只有 rawOutput（无 content）时也保留输出', () => {
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'c-replay-raw',
      status: 'completed',
      title: 'List `web/src`',
      rawInput: { target_directory: 'web/src' },
      rawOutput: 'api/\nstore/\n',
      _meta: { 'x.ai/tool': { name: 'list_dir', kind: 'list_dir', label: 'List Files' } },
    })

    const tool = parts().find(p => p.type === 'tool') as ToolPart
    expect(tool.state.status).toBe('completed')
    expect(tool.state.output).toBe('api/\nstore/\n')
  })

  it('turn 结束（取消/打断）时仍在运行的工具卡片收敛为取消态', () => {
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'c-dangling',
      status: 'in_progress',
      title: 'Fetch: https://slow.example.com',
      rawInput: { url: 'https://slow.example.com' },
      _meta: { 'x.ai/tool': { name: 'web_fetch', kind: 'web_fetch', label: 'Web Fetch' } },
    })
    let tool = parts().find(p => p.type === 'tool') as ToolPart
    expect(tool.state.status).toBe('running')

    update({ sessionUpdate: 'turn_completed' })

    tool = parts().find(p => p.type === 'tool') as ToolPart
    expect(tool.state.status).toBe('error')
    expect(tool.state.output).toBe('Cancelled')
    // 已终态的工具不受扫尾影响
    expect(tool.state.input).toEqual({ url: 'https://slow.example.com' })
  })

  // ── 2. plan → todo 卡片 ────────────────────────────────────

  it('plan 通知转译为 todo.updated 且有订阅者收到', () => {
    update({
      sessionUpdate: 'plan',
      entries: [
        { content: '第一步', status: 'completed', priority: 'high' },
        { content: '第二步', status: 'in_progress', priority: 'medium' },
      ],
    })

    expect(todoEvents).toHaveLength(1)
    expect(todoEvents[0].sessionID).toBe(SID)
    expect(todoEvents[0].todos).toHaveLength(2)
  })

  // ── 3. 权限弹窗数据链路 ────────────────────────────────────

  it('权限请求映射 + respond 回调注册/消费', () => {
    const mapped = mapAcpPermissionToApi({
      sessionId: SID,
      toolCall: { toolCallId: 'tc-9', title: 'bash', rawInput: { command: 'rm x' } },
      options: [
        { optionId: 'allow', name: '允许', kind: 'allow_once' },
        { optionId: 'reject', name: '拒绝', kind: 'reject_once' },
      ],
    })
    expect(mapped).not.toBeNull()
    expect(mapped!.sessionID).toBe(SID)
    // options 是 acpPermissionBridge 附加的扩展字段（ApiPermissionRequest 类型未声明）
    expect((mapped as unknown as { options: unknown[] }).options).toHaveLength(2)

    let replied: Record<string, unknown> | null = null
    registerAcpResponder(mapped!.id, r => { replied = r })
    const respond = consumeAcpResponder(mapped!.id)
    expect(respond).not.toBeNull()
    respond!({ outcome: { outcome: 'selected', optionId: 'allow' } })
    expect(replied).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } })
    // 消费后即失效
    expect(consumeAcpResponder(mapped!.id)).toBeNull()
  })

  // ── 4. AskUserQuestion 弹窗数据链路 ─────────────────────────

  it('提问请求映射为 question.asked 格式', () => {
    const mapped = mapAcpQuestionToApi({
      sessionId: SID,
      questionId: 'q-1',
      questions: [
        { header: '方案', question: '选哪个方案？', options: [{ label: 'A' }, { label: 'B' }] },
      ],
    })
    expect(mapped).not.toBeNull()
    expect(mapped!.id).toBe('q-1')
    expect(mapped!.sessionID).toBe(SID)
    expect(mapped!.questions[0].question).toBe('选哪个方案？')
    expect(mapped!.questions[0].options).toHaveLength(2)
  })

  // ── 5. Plan 审批 store ─────────────────────────────────────

  it('plan 审批请求进入 store，订阅者可见，respond 后清空', () => {
    let notified = 0
    const unsub = subscribePlanApproval(() => { notified++ })

    let approvalResult: unknown = null
    setPlanApprovalRequest({
      entries: [{ content: '改三个文件', status: 'pending' }],
      respond: r => {
        approvalResult = r
        setPlanApprovalRequest(null)
      },
    })

    const req = getPlanApprovalRequest()
    expect(req).not.toBeNull()
    expect(req!.entries[0].content).toBe('改三个文件')

    req!.respond({ approved: true })
    expect(approvalResult).toEqual({ approved: true })
    expect(getPlanApprovalRequest()).toBeNull()
    expect(notified).toBeGreaterThanOrEqual(2)
    unsub()
  })

  // ── 6. 后台任务 / subagent / compaction 内联卡片 ────────────

  it('task_completed 内联为系统消息', () => {
    update({ sessionUpdate: 'task_completed', taskId: 't-1', message: 'Task t-1 done' })
    const texts = parts().filter(p => p.type === 'text') as Array<Part & { text: string }>
    expect(texts.some(p => p.text.includes('Task t-1 done'))).toBe(true)
  })

  it('subagent 生命周期内联为系统消息', async () => {
    update({ sessionUpdate: 'subagent_spawned', subagentType: 'Explore', description: '查找代码' })
    update({ sessionUpdate: 'subagent_progress' }) // 高频 tick，不产出 part
    // part id 含 Date.now()，同一毫秒会撞 id；真实 subagent 生命周期为秒级
    await new Promise(r => setTimeout(r, 2))
    update({ sessionUpdate: 'subagent_finished', subagentType: 'Explore', tokensUsed: 1234 })

    const texts = parts().filter(p => p.type === 'text') as Array<Part & { text: string }>
    expect(texts.some(p => p.text.includes('Subagent started') && p.text.includes('Explore'))).toBe(true)
    expect(texts.some(p => p.text.includes('Subagent finished') && p.text.includes('1234'))).toBe(true)
  })

  it('compaction 开始/完成内联为系统消息', async () => {
    update({ sessionUpdate: 'auto_compact_started', percentage: 92 })
    // part id 含 Date.now()，同一毫秒会撞 id；真实 compaction 间隔为秒级
    await new Promise(r => setTimeout(r, 2))
    update({ sessionUpdate: 'auto_compact_completed', tokensAfter: 5000 })

    const texts = parts().filter(p => p.type === 'text') as Array<Part & { text: string }>
    expect(texts.some(p => p.text.includes('Compacting') && p.text.includes('92'))).toBe(true)
    expect(texts.some(p => p.text.includes('compacted') && p.text.includes('5000'))).toBe(true)
  })

  // ── 7. 重试终态错误 → 错误卡片 + session.error ──────────────

  it('retry_state failed 产生 retry part 并广播 session.error', () => {
    textChunk('正在回答')
    update({
      sessionUpdate: 'retry_state',
      type: 'failed',
      error_type: 'overloaded',
      message: '服务过载',
    })

    expect(parts().some(p => p.type === 'retry')).toBe(true)
    expect(sessionErrors).toHaveLength(1)
    expect(messageStore.getIsStreaming(SID)).toBe(false)
  })

  // ── 8. 会话级状态：斜杠命令 / 模式 / 标题 ───────────────────

  it('available_commands_update 供斜杠命令菜单读取', () => {
    update({
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'review' }, { name: 'compact' }],
    })
    expect(getAvailableCommands(SID)).toHaveLength(2)
  })

  it('current_mode_update 供模式切换读取', () => {
    update({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' })
    expect(getCurrentMode(SID)).toBe('plan')
  })

  it('session_info_update 广播 session.updated（标题）', () => {
    update({ sessionUpdate: 'session_info_update', title: '新标题' })
    expect(sessionUpdated).toHaveLength(1)
    expect((sessionUpdated[0] as { title: string }).title).toBe('新标题')
  })
})
