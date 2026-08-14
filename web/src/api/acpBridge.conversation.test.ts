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
  beginAcpReplay,
  finishAcpReplay,
  demoteHeldTaskNotifications,
  prepareTurnForPrompt,
  settlePromptTurn,
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

  it('replyPermission 把语义 reply 解析成后端下发的真实 optionId', async () => {
    const { replyPermission } = await import('./permission')
    const options = [
      { optionId: 'always-allow', name: 'always allow', kind: 'allow_always' },
      { optionId: 'allow-once', name: 'allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'reject once', kind: 'reject_once' },
    ]
    const cases: Array<['once' | 'always' | 'reject', string]> = [
      ['once', 'allow-once'],
      ['always', 'always-allow'],
      ['reject', 'reject-once'],
    ]
    for (const [reply, expectedId] of cases) {
      const mapped = mapAcpPermissionToApi({
        sessionId: SID,
        permissionId: `perm-${reply}`,
        toolCall: { toolCallId: `tc-${reply}`, title: 'bash', rawInput: {} },
        options,
      })
      let replied: Record<string, unknown> | null = null
      registerAcpResponder(mapped!.id, r => { replied = r }, mapped!.options ?? [])
      await replyPermission(mapped!.id, reply)
      // 拒绝也是 selected + reject-once（cancelled 语义是"取消提问"，非用户拒绝）
      expect(replied).toEqual({ outcome: { outcome: 'selected', optionId: expectedId } })
    }
  })

  it('replyPermission 直接携带 optionId（动态按钮路径）原样回显', async () => {
    const { replyPermission } = await import('./permission')
    const mapped = mapAcpPermissionToApi({
      sessionId: SID,
      permissionId: 'perm-dynamic',
      toolCall: { toolCallId: 'tc-dyn', title: 'bash', rawInput: {} },
      options: [
        { optionId: 'allow-always-command', name: 'Always allow: git push', kind: 'allow_always' },
        { optionId: 'allow-once', name: 'Yes, proceed', kind: 'allow_once' },
      ],
    })
    let replied: Record<string, unknown> | null = null
    registerAcpResponder(mapped!.id, r => { replied = r }, mapped!.options ?? [])
    await replyPermission(mapped!.id, { optionId: 'allow-always-command' })
    expect(replied).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-always-command' } })
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

  // ── 6. 后台任务（独立系统消息）/ subagent / compaction ────────

  const taskMsgs = () =>
    messageStore.getVisibleMessages(SID).filter(m => m.info.id.startsWith('msg_tasknotif_'))

  it('空闲态 task_completed 渲染为独立系统消息（不蹭 assistant 消息）', () => {
    update({
      sessionUpdate: 'task_completed',
      task_snapshot: {
        task_id: '019fef62-7d06',
        command: 'bash -c "sleep 10 && echo background-task-done"',
        exit_code: 0,
        output: 'background-task-done',
        completed: true,
      },
      will_wake: false,
    })
    const msgs = taskMsgs()
    expect(msgs).toHaveLength(1)
    expect(msgs[0].info.id).toBe('msg_tasknotif_019fef62-7d06')
    const part = msgs[0].parts[0] as Part & {
      taskId: string; command: string; ok: boolean; exitCode: number; output: string; endTime: number
    }
    expect(part.type).toBe('task-completion')
    expect(part.ok).toBe(true)
    expect(part.exitCode).toBe(0)
    expect(part.command).toContain('sleep 10')
    expect(part.output).toBe('background-task-done')
    expect(part.endTime).toBeGreaterThan(0)
    // 通知已定稿：不把空闲 session 翻成 busy
    expect(msgs[0].info.time.completed).not.toBeNull()
    expect(messageStore.getIsStreaming(SID)).toBe(false)
    // 没有蹭出来的普通 assistant 消息
    expect(messageStore.getVisibleMessages(SID)).toHaveLength(1)
  })

  it('task_completed 失败任务（非零退出码）ok=false', () => {
    update({
      sessionUpdate: 'task_completed',
      task_snapshot: { task_id: 't-fail', command: 'false', exit_code: 1, completed: true },
    })
    const part = taskMsgs()[0].parts[0] as Part & { ok: boolean; exitCode: number }
    expect(part.ok).toBe(false)
    expect(part.exitCode).toBe(1)
  })

  it('流式期间 task_completed 缓冲，turn_completed 后 flush 到消息流末尾', () => {
    textChunk('正在处理另一个问题')
    update({
      sessionUpdate: 'task_completed',
      task_snapshot: { task_id: 't-buf', command: 'sleep 5', exit_code: 0, completed: true },
    })
    // streaming 中：不插入
    expect(taskMsgs()).toHaveLength(0)
    textChunk('回答继续')
    update({ sessionUpdate: 'turn_completed' })
    // idle 后 flush，且位于消息流末尾
    const msgs = messageStore.getVisibleMessages(SID)
    expect(taskMsgs()).toHaveLength(1)
    expect(msgs[msgs.length - 1].info.id).toBe('msg_tasknotif_t-buf')
    // 通知内容没有混进 assistant 消息
    const assistantParts = msgs[0].parts.filter(p => p.type === 'task-completion')
    expect(assistantParts).toHaveLength(0)
  })

  it('同 taskId 重复帧 upsert 幂等（双路帧 / 回放重放）', () => {
    const frame = {
      sessionUpdate: 'task_completed',
      task_snapshot: { task_id: 't-dup', command: 'echo hi', exit_code: 0, completed: true },
    }
    update(frame)
    update(frame)
    expect(taskMsgs()).toHaveLength(1)
    expect(taskMsgs()[0].parts).toHaveLength(1)
  })

  it('回放窗口内 task_completed 立即渲染，保持历史位置', () => {
    beginAcpReplay(SID)
    textChunk('历史问题', 'user_message_chunk')
    textChunk('历史回答一')
    update({
      sessionUpdate: 'task_completed',
      task_snapshot: { task_id: 't-replay', command: 'echo old', exit_code: 0, completed: true },
    })
    textChunk('唤醒后的回复', 'user_message_chunk')
    textChunk('基于任务结果的回答')
    finishAcpReplay(SID)

    const msgs = messageStore.getVisibleMessages(SID)
    const notifIdx = msgs.findIndex(m => m.info.id === 'msg_tasknotif_t-replay')
    expect(notifIdx).toBeGreaterThan(0)
    // 位于历史中段（后面还有消息），而非堆到末尾
    expect(notifIdx).toBeLessThan(msgs.length - 1)
  })

  it('turn_completed 收尾后新 chunk 开新 assistant 消息', () => {
    textChunk('第一轮回答')
    update({ sessionUpdate: 'turn_completed' })
    textChunk('第二轮回答')
    const assistants = messageStore
      .getVisibleMessages(SID)
      .filter(m => m.info.role === 'assistant')
    expect(assistants).toHaveLength(2)
  })

  // ── 6b. auto-wake 唤醒轮 = 独立 assistant 消息（msg_wake_*），
  //        通知卡作为其第一个 part（will_wake=true 时 hold 到唤醒轮注入）──

  /** 发一条 task-completed 唤醒轮的隐藏 user chunk（真实 wire：_meta 在 update 级） */
  function wakeChunk(taskId: string, extra = '') {
    update({
      sessionUpdate: 'user_message_chunk',
      content: {
        type: 'text',
        text: `<system-reminder>\nBackground task "${taskId}" completed (exit code: 0).\nCommand: sleep 5 | Duration: 5s${extra}\n</system-reminder>`,
      },
      _meta: { hideFromScrollback: true, modelId: 'test-model', promptIndex: 3 },
    })
  }

  const wakeMsgs = () =>
    messageStore.getVisibleMessages(SID).filter(m => m.info.id.startsWith('msg_wake_'))

  it('will_wake=true：通知卡 hold，作为唤醒消息第一个 part，后跟模型输出', () => {
    update({
      sessionUpdate: 'task_completed',
      task_snapshot: { task_id: 't-wake', command: 'sleep 5', exit_code: 0, completed: true },
      will_wake: true,
    })
    // hold：不出独立卡
    expect(taskMsgs()).toHaveLength(0)
    wakeChunk('t-wake')
    textChunk('任务完成了，输出符合预期。')
    textChunk('继续思考', 'agent_thought_chunk')
    textChunk('结论：一切正常。')
    update({ sessionUpdate: 'turn_completed', prompt_id: 'task-completed-t-wake', stop_reason: 'end_turn' })

    // 只有唤醒回复一条消息；无独立通知消息
    const msgs = messageStore.getVisibleMessages(SID)
    expect(msgs.map(m => m.info.id)).toEqual(['msg_wake_t-wake'])
    // 第一个 part 是通知卡，其后 text → reasoning → text 保序
    expect(msgs[0].parts.map(p => p.type)).toEqual(['task-completion', 'text', 'reasoning', 'text'])
    const card = msgs[0].parts[0] as Part & { taskId: string; command: string; ok: boolean }
    expect(card.taskId).toBe('t-wake')
    expect(card.command).toBe('sleep 5')
    expect(card.ok).toBe(true)
    expect((msgs[0].parts[1] as Part & { text: string }).text).toBe('任务完成了，输出符合预期。')
    // turn_completed 补发 idle：唤醒消息已定稿，session 不滞留 streaming
    expect(msgs[0].info.time.completed).not.toBeNull()
    expect(messageStore.getIsStreaming(SID)).toBe(false)
  })

  it('唤醒轮内 tool call 是唤醒消息上的普通 tool part（卡片仍居首）', () => {
    update({
      sessionUpdate: 'task_completed',
      task_snapshot: { task_id: 't-wt', command: 'sleep 1', exit_code: 0, completed: true },
      will_wake: true,
    })
    wakeChunk('t-wt')
    textChunk('再验证一下')
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'wc-1',
      title: 'bash',
      status: 'in_progress',
      rawInput: { command: 'echo verify' },
    })
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'wc-1',
      status: 'completed',
      rawOutput: 'verify',
    })
    update({ sessionUpdate: 'turn_completed', prompt_id: 'task-completed-t-wt', stop_reason: 'end_turn' })

    expect(wakeMsgs()).toHaveLength(1)
    expect(wakeMsgs()[0].parts[0].type).toBe('task-completion')
    const tool = wakeMsgs()[0].parts.find(p => p.type === 'tool') as ToolPart
    expect(tool).toBeDefined()
    expect(tool.callID).toBe('wc-1')
    expect(tool.state.status).toBe('completed')
    expect(tool.state.output).toBe('verify')
  })

  it('用户 turn streaming 中任务完成（will_wake）：hold 穿越 turn 边界进唤醒消息', () => {
    // 用户 turn streaming 中任务完成 → hold（不进缓冲，不出独立卡）
    textChunk('用户问题的回答')
    update({
      sessionUpdate: 'task_completed',
      task_snapshot: { task_id: 't-bufwake', command: 'sleep 2', exit_code: 0, completed: true },
      will_wake: true,
    })
    expect(taskMsgs()).toHaveLength(0)
    update({ sessionUpdate: 'turn_completed' })
    // turn 结束 flush 也不带出 hold 的卡
    expect(taskMsgs()).toHaveLength(0)
    wakeChunk('t-bufwake')
    textChunk('后台任务好了')
    update({ sessionUpdate: 'turn_completed', prompt_id: 'task-completed-t-bufwake', stop_reason: 'end_turn' })

    expect(taskMsgs()).toHaveLength(0)
    const wake = wakeMsgs()[0]
    expect(wake.parts.map(p => p.type)).toEqual(['task-completion', 'text'])
    expect((wake.parts[1] as Part & { text: string }).text).toBe('后台任务好了')
  })

  it('通知帧丢失时唤醒轮合成卡片进唤醒消息', () => {
    // 无 task_completed 帧，直接来唤醒轮（重连丢帧场景）
    wakeChunk('t-lost')
    textChunk('直接反应')
    update({ sessionUpdate: 'turn_completed', prompt_id: 'task-completed-t-lost', stop_reason: 'end_turn' })

    const msgs = messageStore.getVisibleMessages(SID)
    expect(msgs.map(m => m.info.id)).toEqual(['msg_wake_t-lost'])
    // 从 reminder 文本合成的最小记录，作为第一个 part
    const part = msgs[0].parts[0] as Part & { command: string; exitCode?: number }
    expect(part.type).toBe('task-completion')
    expect(part.command).toBe('sleep 5')
    expect(part.exitCode).toBe(0)
  })

  it('will_wake 重复帧 upsert 到 wake 消息（双路帧幂等）', () => {    const frame = {
      sessionUpdate: 'task_completed',
      task_snapshot: { task_id: 't-dupw', command: 'echo hi', exit_code: 0, output: 'hi', completed: true },
      will_wake: true,
    }
    update(frame)
    wakeChunk('t-dupw')
    textChunk('看到了')
    // wake 轮进行中重复帧到达
    update(frame)
    update({ sessionUpdate: 'turn_completed', prompt_id: 'task-completed-t-dupw', stop_reason: 'end_turn' })

    expect(taskMsgs()).toHaveLength(0)
    const wake = wakeMsgs()[0]
    // 卡片 part 只有一个（同 id upsert）
    expect(wake.parts.filter(p => p.type === 'task-completion')).toHaveLength(1)
    expect((wake.parts[0] as Part & { output?: string }).output).toBe('hi')
  })

  it('hold 中用户抢先发 prompt：降级为独立卡，turn 结束后 flush', () => {
    update({
      sessionUpdate: 'task_completed',
      task_snapshot: { task_id: 't-held', command: 'sleep 4', exit_code: 0, completed: true },
      will_wake: true,
    })
    expect(taskMsgs()).toHaveLength(0)
    // 模拟 acpPrompt 发出 genuine prompt（后端消费 deferred，唤醒不再发生）
    demoteHeldTaskNotifications(SID)
    textChunk('新问题的回答')
    update({ sessionUpdate: 'turn_completed' })
    // turn 结束 flush 为独立卡
    expect(taskMsgs()).toHaveLength(1)
    expect(taskMsgs()[0].info.id).toBe('msg_tasknotif_t-held')
  })

  it('唤醒识别失败兜底：hold 的卡在 task-completed turn_completed 时 flush 为独立卡', () => {
    update({
      sessionUpdate: 'task_completed',
      task_snapshot: { task_id: 't-unrec', command: 'sleep 6', exit_code: 0, completed: true },
      will_wake: true,
    })
    // 唤醒轮 reminder 文案未被识别（无 wakeChunk），模型输出按普通消息渲染
    textChunk('对任务结果的反应（未识别）')
    update({ sessionUpdate: 'turn_completed', prompt_id: 'task-completed-t-unrec', stop_reason: 'end_turn' })

    // 卡片以独立消息兜底渲染，内容不丢
    expect(taskMsgs()).toHaveLength(1)
    expect(taskMsgs()[0].info.id).toBe('msg_tasknotif_t-unrec')
    expect(wakeMsgs()).toHaveLength(0)
  })

  it('回放中带 will_wake 的唤醒轮同样并入且顺序保持', () => {
    beginAcpReplay(SID)
    textChunk('历史问题', 'user_message_chunk')
    textChunk('历史回答')
    update({
      sessionUpdate: 'task_completed',
      task_snapshot: { task_id: 't-rw', command: 'echo old', exit_code: 0, completed: true },
      will_wake: true,
    })
    wakeChunk('t-rw')
    textChunk('历史唤醒回复')
    update({ sessionUpdate: 'turn_completed', prompt_id: 'task-completed-t-rw', stop_reason: 'end_turn' })
    textChunk('后来的问题', 'user_message_chunk')
    textChunk('后来的回答')
    finishAcpReplay(SID)

    const msgs = messageStore.getVisibleMessages(SID)
    expect(taskMsgs()).toHaveLength(0)
    const wakeIdx = msgs.findIndex(m => m.info.id === 'msg_wake_t-rw')
    expect(wakeIdx).toBeGreaterThan(0)
    expect(msgs[wakeIdx].parts.map(p => p.type)).toEqual(['task-completion', 'text'])
    expect((msgs[wakeIdx].parts[1] as Part & { text: string }).text).toBe('历史唤醒回复')
    // 后来的对话在唤醒消息之后正常展开
    expect(wakeIdx).toBeLessThan(msgs.length - 1)
  })

  it('迟到的后台任务 tool_call_update（终态+全量输出）被吞，不挂错消息', () => {
    // 第一回合：模型启动后台任务（Bash tool_call 正常终态收尾）
    textChunk('好的，任务已在后台运行')
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'bg-call',
      title: 'bash',
      status: 'completed',
      rawInput: { command: 'sleep 10; echo done', run_in_background: true },
      rawOutput: 'backgrounded',
    })
    update({ sessionUpdate: 'turn_completed' })
    const firstMsg = messageStore.getVisibleMessages(SID)[0]
    const partCountBefore = firstMsg.parts.length

    // 第二回合：用户新对话进行中
    textChunk('新回合的回答')
    // 任务真正退出：后端对原始 callId 补发 completed + 全量输出（wait_background_completion）
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'bg-call',
      status: 'completed',
      rawOutput: 'done\n(full output)',
    })

    // 迟到帧被吞：旧消息 part 数不变，新消息没有多出 tool part
    const msgs = messageStore.getVisibleMessages(SID)
    expect(msgs[0].parts.length).toBe(partCountBefore)
    expect(msgs.flatMap(m => m.parts).filter(p => p.type === 'tool')).toHaveLength(1)
    const tool = msgs[0].parts.find(p => p.type === 'tool') as ToolPart
    expect(tool.state.output).toBe('backgrounded') // 原始输出未被覆盖
  })

  it('wake 轮进行中另一任务完成（will_wake=false）→ 缓冲到 wake 收尾后 flush', () => {
    update({
      sessionUpdate: 'task_completed',
      task_snapshot: { task_id: 't-a', command: 'sleep 1', exit_code: 0, completed: true },
      will_wake: true,
    })
    wakeChunk('t-a')
    textChunk('处理任务 A 的结果')
    // wake 轮进行中任务 B 完成（不唤醒）
    update({
      sessionUpdate: 'task_completed',
      task_snapshot: { task_id: 't-b', command: 'sleep 9', exit_code: 0, completed: true },
    })
    expect(taskMsgs()).toHaveLength(0) // B 缓冲中；A 在 wake 消息里
    update({ sessionUpdate: 'turn_completed', prompt_id: 'task-completed-t-a', stop_reason: 'end_turn' })
    // wake 收尾后 B flush 到末尾
    expect(taskMsgs()).toHaveLength(1)
    const msgs = messageStore.getVisibleMessages(SID)
    expect(msgs[msgs.length - 1].info.id).toBe('msg_tasknotif_t-b')
  })

  it('wake 轮中用户插队打断：运行中工具收敛取消态，消息定稿', () => {
    update({
      sessionUpdate: 'task_completed',
      task_snapshot: { task_id: 't-int', command: 'sleep 3', exit_code: 0, completed: true },
      will_wake: true,
    })
    wakeChunk('t-int')
    textChunk('让我检查')
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'wc-int',
      title: 'bash',
      status: 'in_progress',
      rawInput: { command: 'sleep 100' },
    })
    // send_now 打断 → 被打断轮发 cancelled turn_completed
    update({ sessionUpdate: 'turn_completed', prompt_id: 'task-completed-t-int', stop_reason: 'cancelled' })

    const wake = wakeMsgs()[0]
    expect(wake.parts[0].type).toBe('task-completion')
    const tool = wake.parts.find(p => p.type === 'tool') as ToolPart
    expect(tool.state.status).toBe('error')
    expect(tool.state.output).toBe('Cancelled')
    expect(messageStore.getIsStreaming(SID)).toBe(false)
  })

  it('wake 轮进行中插队发新 prompt：新回答开新消息，不 upsert 进旧 wake 消息', () => {
    update({
      sessionUpdate: 'task_completed',
      task_snapshot: { task_id: 't-mix', command: 'sleep 3', exit_code: 0, completed: true },
      will_wake: true,
    })
    wakeChunk('t-mix')
    textChunk('唤醒回复进行中')
    // 用户插队：cancel 已发，但唤醒轮是后端驱动的，pendingPrompts 等不到它，
    // cancelled turn_completed 也可能晚于新 prompt 到达——acpPrompt 通过
    // prepareTurnForPrompt 强制清理残留 wake 状态
    prepareTurnForPrompt(SID, 'msg_u_interject')
    textChunk('新问题的回答')

    const wake = wakeMsgs()[0]
    // 旧 wake 消息内容冻结：卡片 + 被打断前的文本，没有新回答混入
    expect(wake.parts.map(p => p.type)).toEqual(['task-completion', 'text'])
    expect((wake.parts[1] as Part & { text: string }).text).toBe('唤醒回复进行中')
    // 新回答在新的普通 assistant 消息上
    const normal = messageStore
      .getVisibleMessages(SID)
      .filter(m => m.info.role === 'assistant' && !m.info.id.startsWith('msg_wake_') && !m.info.id.startsWith('msg_tasknotif_'))
    expect(normal).toHaveLength(1)
    expect((normal[0].parts[0] as Part & { text: string }).text).toBe('新问题的回答')
  })

  it('唤醒轮先于上一回合 prompt settle 开始：不劈裂、不卡 idle（竞态回归）', () => {
    // 用户回合在途：prepareTurnForPrompt 置 promptInFlight（真实 acpPrompt 先置再等 RPC 返回）
    prepareTurnForPrompt(SID, 'msg_u_race')
    textChunk('用户回合的回答')

    // 唤醒轮在上一回合 RPC settle 之前开始（后台任务自动回复「接上去」）
    update({
      sessionUpdate: 'task_completed',
      task_snapshot: { task_id: 't-race', command: 'sleep 1', exit_code: 0, completed: true },
      will_wake: true,
    })
    wakeChunk('t-race')
    textChunk('后台任务完成了')

    // 关键：上一回合的 RPC settle 此时才到达——在 beginWakeTurn 已置位 wakeTaskId 之后。
    // 若 settle 无条件 finalizeTurn，会清掉 wakeTaskId，把唤醒回复劈成两段
    // 且后续 turn_completed 的 wasWake=false 漏发 idle → 卡 streaming。
    settlePromptTurn(SID)
    textChunk('唤醒回复的剩余部分')
    update({ sessionUpdate: 'turn_completed', prompt_id: 'task-completed-t-race', stop_reason: 'end_turn' })

    // 唤醒回复必须是完整的一条 msg_wake_*，不劈裂
    expect(wakeMsgs()).toHaveLength(1)
    const wake = wakeMsgs()[0]
    expect(wake.parts.map(p => p.type)).toEqual(['task-completion', 'text'])
    expect((wake.parts[1] as Part & { text: string }).text).toBe('后台任务完成了唤醒回复的剩余部分')
    // 没有劈出来的额外普通 assistant 消息：唯一的普通 assistant 是上一回合的回答，内容不变
    const normal = messageStore
      .getVisibleMessages(SID)
      .filter(m => m.info.role === 'assistant' && !m.info.id.startsWith('msg_wake_') && !m.info.id.startsWith('msg_tasknotif_'))
    expect(normal).toHaveLength(1)
    expect((normal[0].parts[0] as Part & { text: string }).text).toBe('用户回合的回答')
    // 定稿：不再卡 streaming
    expect(messageStore.getIsStreaming(SID)).toBe(false)
    expect(wake.info.time.completed).not.toBeNull()
  })

  it('monitor 唤醒文案同样被识别', () => {
    update({
      sessionUpdate: 'task_completed',
      task_snapshot: { task_id: 'mon-1', command: 'npm run dev', exit_code: 0, completed: true },
      will_wake: true,
    })
    update({
      sessionUpdate: 'user_message_chunk',
      content: {
        type: 'text',
        text: 'Monitor "mon-1" ended: [monitor ended: process exited].\nCommand: npm run dev',
        _meta: { hideFromScrollback: true },
      },
    })
    textChunk('dev server 退出了')
    update({ sessionUpdate: 'turn_completed', prompt_id: 'task-completed-mon-1', stop_reason: 'end_turn' })

    expect(wakeMsgs()).toHaveLength(1)
    expect(wakeMsgs()[0].info.id).toBe('msg_wake_mon-1')
    expect(wakeMsgs()[0].parts[0].type).toBe('task-completion')
    expect((wakeMsgs()[0].parts[1] as Part & { text: string }).text).toBe('dev server 退出了')
  })

  it('ownerSessionId / description 从 snapshot 透传到 part', () => {
    update({
      sessionUpdate: 'task_completed',
      task_snapshot: {
        task_id: 't-meta',
        command: 'cargo build',
        exit_code: 0,
        completed: true,
        owner_session_id: 'owner-123',
        description: '编译后端',
      },
    })
    const part = taskMsgs()[0].parts[0] as Part & { ownerSessionId?: string; description?: string }
    expect(part.ownerSessionId).toBe('owner-123')
    expect(part.description).toBe('编译后端')
  })

  it('非 wake 的隐藏 reminder 不置 wake 状态（识别范围控制）', () => {
    // 普通隐藏 reminder（无 Background task/Monitor 文案）
    update({
      sessionUpdate: 'user_message_chunk',
      content: {
        type: 'text',
        text: '<system-reminder>\nSome other reminder content\n</system-reminder>',
        _meta: { hideFromScrollback: true },
      },
    })
    // 之后的输出照常建 assistant 消息（现状行为）
    textChunk('正常回答')
    const msgs = messageStore.getVisibleMessages(SID)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].info.role).toBe('assistant')
    expect(msgs[0].parts[0].type).toBe('text')
  })

  it('system-reminder 回显不进入聊天流，cron prompt 剥框架后保留', () => {
    // 模型侧注入的 reminder 整块隐藏
    textChunk('<system-reminder>\nBackground task done. Use get_output(...)\n</system-reminder>', 'user_message_chunk')
    expect(parts()).toHaveLength(0)

    // cron 框架剥离后保留真正的用户 prompt
    textChunk(
      '<system-reminder>\nThis is a scheduled task execution...\n</system-reminder>\n\n检查部署状态',
      'user_message_chunk',
    )
    const texts = parts().filter(p => p.type === 'text') as Array<Part & { text: string }>
    expect(texts.some(p => p.text === '检查部署状态')).toBe(true)
    expect(texts.some(p => p.text.includes('system-reminder'))).toBe(false)
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
