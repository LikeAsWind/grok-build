// ============================================
// acpBridge 转译层单元测试
// 模拟后端 ACP session/update 流，断言 messageStore 最终状态
// （事件路径：handleAcpSessionUpdate → injectGlobalEvent → subscribeToEvents
//   → messageStore handler，与 useGlobalEvents 的接线一致）
// ============================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { handleAcpSessionUpdate } from './acpBridge'
import { subscribeToEvents } from './events'
import { messageStore } from '../store/messageStore'
import type { ApiMessage, ApiPart } from './types'
import type { Part, ToolPart } from '../types/message'

let testSeq = 0
let SID = 'test-session-0'

function update(u: Record<string, unknown>, sessionId = SID) {
  handleAcpSessionUpdate({ sessionId, update: u })
}

function textChunk(text: string, kind: 'agent_message_chunk' | 'agent_thought_chunk' | 'user_message_chunk' = 'agent_message_chunk') {
  update({ sessionUpdate: kind, content: { type: 'text', text } })
}

describe('acpBridge 转译层', () => {
  let unsubscribe: (() => void) | null = null

  beforeEach(() => {
    // 每个测试用独立 session（acpBridge 的回合状态按 session 隔离）
    SID = `test-session-${++testSeq}`
    messageStore.clearAll()
    // 与 useGlobalEvents 相同的接线
    unsubscribe = subscribeToEvents({
      onMessageUpdated: (msg: ApiMessage) => messageStore.handleMessageUpdated(msg),
      onPartUpdated: (part: ApiPart) => {
        if ('sessionID' in part && 'messageID' in part) {
          messageStore.handlePartUpdated(part as ApiPart & { sessionID: string; messageID: string })
        }
      },
      onPartDelta: data => messageStore.handlePartDelta(data),
      onSessionIdle: data => messageStore.handleSessionIdle(data.sessionID),
    })
  })

  afterEach(() => {
    unsubscribe?.()
    messageStore.clearAll()
  })

  it('agent_message_chunk 流式拼接为一条 assistant 消息', () => {
    textChunk('你')
    textChunk('好')
    textChunk('！')

    const messages = messageStore.getVisibleMessages(SID)
    expect(messages).toHaveLength(1)
    expect(messages[0].info.role).toBe('assistant')
    const textParts = messages[0].parts.filter((p: Part) => p.type === 'text')
    expect(textParts).toHaveLength(1)
    expect((textParts[0] as Part & { text: string }).text).toBe('你好！')
    expect(messageStore.getIsStreaming(SID)).toBe(true)
  })

  it('thinking 与正文分属不同 part', () => {
    textChunk('思考中...', 'agent_thought_chunk')
    textChunk('答案是 42')

    const messages = messageStore.getVisibleMessages(SID)
    expect(messages).toHaveLength(1)
    const kinds = messages[0].parts.map((p: Part) => p.type)
    expect(kinds).toEqual(['reasoning', 'text'])
  })

  it('tool_call → tool_call_update 生成并更新 tool part', () => {
    textChunk('我来看看文件')
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'call_1',
      title: 'read_file',
      kind: 'read',
      status: 'pending',
      rawInput: { path: 'a.txt' },
      _meta: { 'x.ai/tool': { name: 'read_file', kind: 'read', label: 'Read file' } },
    })
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'file contents here' } }],
    })
    textChunk('文件读完了')

    const messages = messageStore.getVisibleMessages(SID)
    expect(messages).toHaveLength(1)
    const parts = messages[0].parts
    // 顺序：text → tool → text（工具卡片后的文本另开 part）
    expect(parts.map((p: Part) => p.type)).toEqual(['text', 'tool', 'text'])
    const tool = parts[1] as ToolPart
    expect(tool.callID).toBe('call_1')
    expect(tool.tool).toBe('read_file')
    expect(tool.state.status).toBe('completed')
    expect(tool.state.output).toBe('file contents here')
    expect(tool.state.input).toEqual({ path: 'a.txt' })
  })

  it('tool_call_update 失败映射为 error 状态', () => {
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'call_2',
      title: 'bash',
      status: 'in_progress',
      rawInput: { command: 'exit 1' },
    })
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_2',
      status: 'failed',
      rawOutput: 'command failed',
    })

    const messages = messageStore.getVisibleMessages(SID)
    const tool = messages[0].parts.find((p: Part) => p.type === 'tool') as ToolPart
    expect(tool.state.status).toBe('error')
    expect(tool.state.output).toBe('command failed')
  })

  it('迟到的 in_progress 更新不会复活已完成的工具调用（跨 turn 竞态）', () => {
    // 复现后台任务竞态：卡片先 completed，turn_completed 收尾清空 turn.tools，
    // 之后最终输出块迟到（in_progress）——修复前 fallback 会新建一张 running
    // 卡片且永远没有后续终态更新，卡片永远转圈。
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'call_bg',
      title: 'bash',
      status: 'in_progress',
      rawInput: { command: 'sleep 10; echo background-task-done' },
    })
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_bg',
      status: 'completed',
      rawOutput: 'background-task-done',
    })
    // task_completed 自动唤醒注入新 turn 的 user prompt——
    // 开新回合会 finalizeTurn 清空旧 turn 的工具记录
    textChunk('后台任务已完成，继续', 'user_message_chunk')
    // 新 turn 开始后，旧调用的最终输出块迟到
    textChunk('后台任务完成了')
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_bg',
      status: 'in_progress',
      content: [{ type: 'content', content: { type: 'text', text: 'background-task-done' } }],
    })

    const messages = messageStore.getVisibleMessages(SID)
    const tools = messages.flatMap(m => m.parts.filter((p: Part) => p.type === 'tool')) as ToolPart[]
    // 只有一张卡片，且保持 completed——不被迟到更新复活
    expect(tools).toHaveLength(1)
    expect(tools[0].callID).toBe('call_bg')
    expect(tools[0].state.status).toBe('completed')
  })

  it('user_message_chunk 回放构建 user 消息，与 assistant 回合交替', () => {
    textChunk('历史问题', 'user_message_chunk')
    textChunk('历史回答')
    textChunk('第二个问题', 'user_message_chunk')

    const messages = messageStore.getVisibleMessages(SID)
    expect(messages.map(m => m.info.role)).toEqual(['user', 'assistant', 'user'])
    expect((messages[0].parts[0] as Part & { text: string }).text).toBe('历史问题')
  })
})
