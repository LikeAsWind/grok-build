// ============================================
// ACP Bridge — grok ACP WebSocket ↔ OpenCodeUI 事件桥
//
// 职责：
// 1. 管理唯一的 ACP 连接（fetch /config → WS → initialize → authenticate）
// 2. 把 ACP session/update 流转译成 OpenCodeUI 的 SSE 事件格式，
//    注入 events.ts 的 broadcastEvent（messageStore 等下游逻辑零改动）
// 3. 提供 prompt / cancel / createSession / models 给各 api 模块调用
// ============================================

import { AcpClient } from './acp'
import { injectGlobalEvent, setAcpConnectionState } from './events'
import { sessionCwdForWire } from './sessionCwd'
import { serverStore } from '../store/serverStore'
import { TASK_NOTIFICATION_MESSAGE_ID_PREFIX } from '../features/message/taskNotification'
import type { GlobalEvent } from '../types/api/event'
import type { ModelInfo } from './types'

// ── 连接状态（AcpContext 订阅用）───────────────────────────────────

export type AcpStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

let _status: AcpStatus = 'disconnected'
let _statusError: string | null = null
const _statusListeners = new Set<() => void>()

function setStatus(status: AcpStatus, error?: string) {
  _status = status
  _statusError = error ?? null
  const connState = status === 'connecting' ? 'connecting' : status === 'connected' ? 'connected' : status === 'error' ? 'error' : 'disconnected'
  setAcpConnectionState(connState, error)
  _statusListeners.forEach(fn => fn())
}

export function getAcpStatus(): AcpStatus {
  return _status
}

export function getAcpStatusError(): string | null {
  return _statusError
}

export function subscribeAcpStatus(fn: () => void): () => void {
  _statusListeners.add(fn)
  return () => {
    _statusListeners.delete(fn)
  }
}

// ── Secret 读取（#key=... → sessionStorage）─────────────────────────

const SECRET_STORAGE_KEY = 'grok-secret'

export function readSecret(): string | null {
  const hash = window.location.hash
  if (hash) {
    const params = new URLSearchParams(hash.slice(1))
    const key = params.get('key')
    if (key) {
      sessionStorage.setItem(SECRET_STORAGE_KEY, key)
      const url = new URL(window.location.href)
      url.hash = ''
      window.history.replaceState(null, '', url.toString())
      return key
    }
  }
  return sessionStorage.getItem(SECRET_STORAGE_KEY)
}

// ── 后端地址/密钥解析（服务器面板可配置，默认同源）──────────────────

/** 当前生效的后端 base URL（不含尾斜杠），来自服务器面板选中的服务器 */
export function getBackendBaseUrl(): string {
  return serverStore.getActiveBaseUrl().replace(/\/+$/, '')
}

/**
 * 当前后端的 server-key：
 * 服务器面板里该服务器的 password 字段 → URL #key / sessionStorage（同源默认场景）
 */
function resolveSecret(): string | null {
  const auth = serverStore.getActiveAuth()
  if (auth?.password) return auth.password
  return readSecret()
}

/** 是否已具备连接所需的密钥（AcpProvider 自动连接判断用） */
export function hasAcpSecret(): boolean {
  return resolveSecret() !== null
}

/** 当前后端的 server-key（受保护的 HTTP 端点如 /config-file 使用） */
export function getAcpSecret(): string | null {
  return resolveSecret()
}

// ── 连接单例 ─────────────────────────────────────────────────────

interface AcpModelEntry {
  modelId: string
  name: string
  description?: string
  _meta?: Record<string, unknown>
}

interface AcpModelState {
  currentModelId: string
  availableModels: AcpModelEntry[]
}

let _client: AcpClient | null = null
let _connectPromise: Promise<AcpClient> | null = null
let _serverCwd = ''
let _modelState: AcpModelState | null = null
let _initMeta: Record<string, unknown> = {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

export function getServerCwd(): string {
  return _serverCwd
}

export function getInitMeta(): Record<string, unknown> {
  return _initMeta
}

export async function ensureAcp(): Promise<AcpClient> {
  if (_client) return _client
  if (_connectPromise) return _connectPromise

  _connectPromise = (async () => {
    setStatus('connecting')
    try {
      const secret = resolveSecret()
      if (!secret) throw new Error('缺少访问密钥：通过 #key=<secret> 打开页面，或在服务器面板为该后端填写密钥')

      const base = getBackendBaseUrl()
      const cfgResp = await fetch(`${base}/config`)
      if (!cfgResp.ok) throw new Error(`${base}/config 请求失败: ${cfgResp.status}`)
      const cfg = (await cfgResp.json()) as { wsPath: string; version: string; cwd: string }
      _serverCwd = cfg.cwd

      const baseUrl = new URL(base)
      const proto = baseUrl.protocol === 'https:' ? 'wss' : 'ws'
      const wsUrl = `${proto}://${baseUrl.host}${cfg.wsPath}`

      const client = await AcpClient.connect(wsUrl, secret, {
        onSessionUpdate: p => handleAcpSessionUpdate(p),
        onRequestPermission: (p, respond) => {
          window.dispatchEvent(new CustomEvent('acp:requestPermission', { detail: { params: p, respond } }))
        },
        onAskUserQuestion: (p, respond) => {
          window.dispatchEvent(new CustomEvent('acp:askUserQuestion', { detail: { params: p, respond } }))
        },
        onExitPlanMode: (p, respond) => {
          window.dispatchEvent(new CustomEvent('acp:exitPlanMode', { detail: { params: p, respond } }))
        },
        onExtNotification: (method, params) => handleExtNotification(method, params),
      })

      client.ws.onclose = () => {
        if (_client === client) {
          _client = null
          _connectPromise = null
          setStatus('disconnected', 'WebSocket 连接已断开')
        }
      }

      const init = await client.initialize()
      const meta = isRecord(init._meta) ? init._meta : {}
      _initMeta = meta

      if (isRecord(meta.modelState)) {
        _modelState = meta.modelState as unknown as AcpModelState
      }
      if (typeof meta.currentWorkingDirectory === 'string' && meta.currentWorkingDirectory) {
        _serverCwd = meta.currentWorkingDirectory
      }

      // 选择认证方式：defaultAuthMethodId → cached_token → 第一个。
      // 认证失败（如 OIDC 端点不可达）不阻塞连接：UI 照常加载，
      // 发消息时后端会返回 "Authentication required" 并显示在会话中。
      const methods = (Array.isArray(init.authMethods) ? init.authMethods : []) as { id: string; name?: string }[]
      const defaultId = typeof meta.defaultAuthMethodId === 'string' ? meta.defaultAuthMethodId : null
      const method = methods.find(m => m.id === defaultId) ?? methods.find(m => m.id === 'cached_token') ?? methods[0]
      if (method) {
        try {
          await client.authenticate(method.id)
        } catch (err) {
          console.warn('[ACP] authenticate 失败（继续连接）:', err instanceof Error ? err.message : err)
        }
      }

      _client = client
      setStatus('connected')
      return client
    } catch (err) {
      _connectPromise = null
      setStatus('error', err instanceof Error ? err.message : String(err))
      throw err
    }
  })()

  return _connectPromise
}

export function disconnectAcpBridge() {
  _client?.close()
  _client = null
  _connectPromise = null
  setStatus('disconnected')
}

// 服务器面板切换后端 → 断开旧连接、连到新地址
// （main.tsx 的 onServerChange 已负责清空 messageStore 等本地状态）
serverStore.onServerChange(() => {
  disconnectAcpBridge()
  _modelState = null
  _serverCwd = ''
  turns.clear()
  void ensureAcp().catch(() => {
    // 连接失败状态已由 setStatus('error') 呈现
  })
})

// ── 模型 ─────────────────────────────────────────────────────────

function metaBool(meta: Record<string, unknown> | undefined, key: string): boolean {
  return !!meta && meta[key] === true
}

function metaNum(meta: Record<string, unknown> | undefined, ...keys: string[]): number {
  if (!meta) return 0
  for (const key of keys) {
    const v = meta[key]
    if (typeof v === 'number') return v
  }
  return 0
}

export function mapAcpModels(state: AcpModelState | null): ModelInfo[] {
  if (!state) return []
  return state.availableModels.map(m => {
    const meta = isRecord(m._meta) ? m._meta : undefined
    // reasoningEfforts: [{id,value,label,description}] → variants: string[]
    const efforts = meta && Array.isArray(meta.reasoningEfforts) ? meta.reasoningEfforts : undefined
    const variants = efforts
      ? efforts.filter((e: unknown) => isRecord(e) && typeof (e as Record<string, unknown>).id === 'string')
               .map((e: unknown) => (e as Record<string, unknown>).id as string)
      : (meta && Array.isArray(meta.variants) ? (meta.variants as string[]).filter(v => typeof v === 'string') : [])
    return {
      id: m.modelId,
      name: m.name || m.modelId,
      providerId: 'xai',
      providerName: 'Grok',
      family: typeof meta?.family === 'string' ? (meta.family as string) : '',
      contextLimit: metaNum(meta, 'contextLimit', 'context_length', 'contextLength', 'totalContextTokens'),
      outputLimit: metaNum(meta, 'outputLimit', 'max_output_tokens'),
      supportsReasoning: metaBool(meta, 'supportsReasoning') || metaBool(meta, 'reasoning') || metaBool(meta, 'supportsReasoningEffort'),
      supportsImages: metaBool(meta, 'supportsImages') || metaBool(meta, 'vision'),
      supportsPdf: false,
      supportsAudio: false,
      supportsVideo: false,
      supportsToolcall: true,
      variants,
    }
  })
}

export async function getAcpActiveModels(): Promise<ModelInfo[]> {
  await ensureAcp()
  return mapAcpModels(_modelState)
}

export function getCurrentAcpModelId(): string {
  return _modelState?.currentModelId ?? ''
}

// ── 事件注入辅助 ─────────────────────────────────────────────────

const sessionDirs = new Map<string, string>()
/** 每个会话当前生效的模型（session/new 响应初始化，set_model 后更新） */
const sessionModelIds = new Map<string, string>()

function emit(type: string, properties: Record<string, unknown>, sessionId?: string) {
  const directory = (sessionId && sessionDirs.get(sessionId)) || _serverCwd
  injectGlobalEvent({ directory, payload: { type, properties } } as unknown as GlobalEvent)
}

// ── 流式转译状态机 ────────────────────────────────────────────────

type ToolStatus = 'pending' | 'running' | 'completed' | 'error'

interface ToolRec {
  partId: string
  callID: string
  tool: string
  /** 所属 assistant 消息 id——turn 收尾扫尾时补发终态 part 需要 */
  messageId: string
  state: {
    status: ToolStatus
    input: Record<string, unknown>
    output?: string
    title?: string
    metadata?: Record<string, unknown>
    time: { start: number; end?: number }
  }
}

interface TurnState {
  lastUserMessageId: string | null
  assistantId: string | null
  textPartId: string | null
  reasoningPartId: string | null
  partSeq: number
  tools: Map<string, ToolRec>
  promptInFlight: boolean
  replayUser: { messageId: string; partId: string } | null
}

const turns = new Map<string, TurnState>()

// 跨 turn 的工具调用终态注册表。finalizeTurn 会清空 turn.tools，此后迟到的
// tool_call_update（如后台任务在 task_completed 唤醒新 turn 之后才送达的最终
// 输出块）会走 handleToolCallUpdate 的 fallback 新建一张 running 卡片，把已
// 完成的调用"复活"成永远转圈。这里按 session 记录已进入终态的 toolCallId，
// 让迟到的非终态更新直接被忽略。
const terminalToolCalls = new Map<string, Set<string>>()

function markToolCallTerminal(sessionId: string, callId: string) {
  let set = terminalToolCalls.get(sessionId)
  if (!set) {
    set = new Set()
    terminalToolCalls.set(sessionId, set)
  }
  set.add(callId)
}

function isToolCallTerminal(sessionId: string, callId: string): boolean {
  return terminalToolCalls.get(sessionId)?.has(callId) ?? false
}

// ── 后台任务完成通知（独立系统消息）──────────────────────────────
// task_completed 不再内联到当前 assistant 消息：streaming 期间缓冲，
// idle 时机 flush 成一条独立的合成消息（msg_tasknotif_<taskId>），
// 避免通知插进正在进行的对话输出或被顶上去找不到。
interface PendingTaskNotification {
  taskId: string
  command: string
  displayCommand?: string
  cwd?: string
  exitCode?: number
  signal?: string
  ok: boolean
  output?: string
  outputFile?: string
  truncated?: boolean
  outputTotalBytes?: number
  startTime?: number
  endTime: number
  receivedAt: number
}

const pendingTaskNotifications = new Map<string, PendingTaskNotification[]>()

// 回放窗口标记：session/load 期间的事件流与 live turn 无法从流内容区分。
// 回放中必须立即按事件流顺序渲染通知（保历史位置），而非缓冲堆到末尾——
// 回放内容会置位 turn.assistantId，不打标会把全部历史通知误判为 busy。
const replayingSessions = new Set<string>()

export function beginAcpReplay(sessionId: string) {
  replayingSessions.add(sessionId)
}

export function finishAcpReplay(sessionId: string) {
  replayingSessions.delete(sessionId)
  // 兜底：回放窗口内不该产生缓冲，但保险起见 flush 一次
  flushPendingTaskNotifications(sessionId)
}

function flushPendingTaskNotifications(sessionId: string) {
  const list = pendingTaskNotifications.get(sessionId)
  if (!list?.length) return
  pendingTaskNotifications.delete(sessionId)
  for (const n of list) emitTaskNotification(sessionId, n)
}

// 在途 prompt 的 RPC promise（按 session）。插队发送会在旧 turn 尚未收尾时调
// acpPrompt——必须等旧 prompt settle 后再搭建新回合状态，否则旧回调会清掉新
// 回合的 promptInFlight（用户消息回显去重失效 → 双气泡），并用旧 idle 覆盖新
// 回合的 streaming 状态（自动 drain 被提前放行）。
const pendingPrompts = new Map<string, Promise<void>>()

/** 切换/回放会话前重置该会话的流转状态 */
export function resetAcpTurnState(sessionId: string) {
  turns.delete(sessionId)
  pendingPrompts.delete(sessionId)
  terminalToolCalls.delete(sessionId)
}

function getTurn(sessionId: string): TurnState {
  let t = turns.get(sessionId)
  if (!t) {
    t = {
      lastUserMessageId: null,
      assistantId: null,
      textPartId: null,
      reasoningPartId: null,
      partSeq: 0,
      tools: new Map(),
      promptInFlight: false,
      replayUser: null,
    }
    turns.set(sessionId, t)
  }
  return t
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`
}

function contentBlockText(content: unknown): string {
  if (!isRecord(content)) return ''
  if (content.type === 'text' && typeof content.text === 'string') return content.text
  if (content.type === 'resource_link' && typeof content.uri === 'string') return content.uri
  return ''
}

function emptyTokens() {
  return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
}

/** 确保当前回合有一个 assistant 消息，返回其 id */
function ensureAssistant(sessionId: string, turn: TurnState): string {
  if (turn.assistantId) return turn.assistantId
  const id = newId('msg_a')
  turn.assistantId = id
  turn.textPartId = null
  turn.reasoningPartId = null
  emit(
    'message.updated',
    {
      info: {
        id,
        sessionID: sessionId,
        role: 'assistant',
        time: { created: Date.now() },
        parentID: turn.lastUserMessageId ?? '',
        modelID: getCurrentAcpModelId(),
        providerID: 'xai',
        mode: '',
        agent: '',
        path: { cwd: _serverCwd, root: _serverCwd },
        cost: 0,
        tokens: emptyTokens(),
      },
    },
    sessionId,
  )
  return id
}

/** 结束当前 assistant 消息的活跃文本/思考 part（下一段内容会新开 part，保持与工具卡片的顺序） */
function breakActiveParts(turn: TurnState) {
  turn.textPartId = null
  turn.reasoningPartId = null
}

function finalizeTurn(turn: TurnState) {
  turn.assistantId = null
  turn.textPartId = null
  turn.reasoningPartId = null
  turn.replayUser = null
  turn.tools.clear()
}

/**
 * turn 收尾时把仍未终态的工具卡片标记为取消（error + "Cancelled"）。
 * 后端 cancel 不会为在途工具补发终态 update——不扫的话卡片会永远转圈；
 * 而历史回放会把无终态的调用整个丢掉，这里让 live 视图先收敛到确定状态。
 */
function cancelDanglingTools(sessionId: string, turn: TurnState) {
  for (const rec of turn.tools.values()) {
    if (rec.state.status !== 'pending' && rec.state.status !== 'running') continue
    rec.state.status = 'error'
    rec.state.time.end = Date.now()
    rec.state.output ??= 'Cancelled'
    rec.state.title ??= rec.tool
    rec.state.metadata ??= {}
    markToolCallTerminal(sessionId, rec.callID)
    emitToolPart(sessionId, rec.messageId, rec)
  }
}

function emitPartUpdated(sessionId: string, messageId: string, part: Record<string, unknown>) {
  emit('message.part.updated', { sessionID: sessionId, part: { ...part, sessionID: sessionId, messageID: messageId } }, sessionId)
}

function emitTextDelta(sessionId: string, messageId: string, partId: string, delta: string) {
  emit('message.part.delta', { sessionID: sessionId, messageID: messageId, partID: partId, field: 'text', delta }, sessionId)
}

function handleAgentText(sessionId: string, turn: TurnState, text: string, kind: 'text' | 'reasoning') {
  if (!text) return
  const messageId = ensureAssistant(sessionId, turn)
  const activeKey = kind === 'text' ? 'textPartId' : 'reasoningPartId'
  let partId = turn[activeKey]
  if (!partId) {
    partId = `${messageId}:p${turn.partSeq++}`
    turn[activeKey] = partId
    // 另一种流打断当前流（text ↔ reasoning 交错时各自新开 part）
    if (kind === 'text') turn.reasoningPartId = null
    else turn.textPartId = null
    const base: Record<string, unknown> = { id: partId, type: kind, text: '' }
    if (kind === 'reasoning') base.time = { start: Date.now() }
    emitPartUpdated(sessionId, messageId, base)
  }
  emitTextDelta(sessionId, messageId, partId, text)
}

function mapToolStatus(status: unknown): ToolStatus {
  switch (status) {
    case 'pending':
      return 'pending'
    case 'in_progress':
      return 'running'
    case 'completed':
      return 'completed'
    case 'failed':
    case 'cancelled':
      return 'error'
    default:
      return 'running'
  }
}

function extractToolMeta(meta: unknown): { name?: string; kind?: string; label?: string } {
  if (!isRecord(meta)) return {}
  const toolMeta = meta['x.ai/tool']
  if (!isRecord(toolMeta)) return {}
  return {
    name: typeof toolMeta.name === 'string' ? toolMeta.name : undefined,
    kind: typeof toolMeta.kind === 'string' ? toolMeta.kind : undefined,
    label: typeof toolMeta.label === 'string' ? toolMeta.label : undefined,
  }
}

function extractToolOutput(content: unknown): { output?: string; metadata?: Record<string, unknown> } {
  if (!Array.isArray(content)) return {}
  const texts: string[] = []
  const metadata: Record<string, unknown> = {}
  for (const item of content) {
    if (!isRecord(item)) continue
    if (item.type === 'content') {
      const text = contentBlockText(item.content)
      if (text) texts.push(text)
    } else if (item.type === 'diff') {
      metadata.diff = { path: item.path, oldText: item.oldText, newText: item.newText }
      if (typeof item.path === 'string') texts.push(`[diff] ${item.path}`)
    }
  }
  const result: { output?: string; metadata?: Record<string, unknown> } = {}
  if (texts.length > 0) result.output = texts.join('\n')
  if (Object.keys(metadata).length > 0) result.metadata = metadata
  return result
}

function emitToolPart(sessionId: string, messageId: string, rec: ToolRec) {
  emitPartUpdated(sessionId, messageId, {
    id: rec.partId,
    type: 'tool',
    callID: rec.callID,
    tool: rec.tool,
    state: { ...rec.state, input: { ...rec.state.input }, metadata: rec.state.metadata ? { ...rec.state.metadata } : undefined },
  })
}

/** 防御性时间解析：epoch 秒/毫秒数字或可 Date.parse 的字符串 → epoch ms */
function toEpochMs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v > 1e12 ? v : v * 1000
  }
  if (typeof v === 'string') {
    const parsed = Date.parse(v)
    if (!Number.isNaN(parsed)) return parsed
  }
  return undefined
}

/** task_completed 帧 → PendingTaskNotification（snake_case 全字段 + 旧 camelCase 兜底） */
function parseTaskNotification(t: Record<string, unknown>, snap: Record<string, unknown> | undefined): PendingTaskNotification {
  const taskId = typeof t.taskId === 'string' ? t.taskId
    : typeof snap?.task_id === 'string' ? snap.task_id : 'unknown'
  const command = typeof snap?.command === 'string' ? snap.command
    : typeof t.message === 'string' ? t.message : ''
  const exitCode = typeof snap?.exit_code === 'number' ? snap.exit_code : undefined
  const signal = typeof snap?.signal === 'string' ? snap.signal : undefined
  const receivedAt = Date.now()
  return {
    taskId,
    command,
    displayCommand: typeof snap?.display_command === 'string' ? snap.display_command : undefined,
    cwd: typeof snap?.cwd === 'string' ? snap.cwd : undefined,
    exitCode,
    signal,
    ok: signal === undefined && (exitCode === undefined || exitCode === 0),
    output: typeof snap?.output === 'string' ? snap.output : undefined,
    outputFile: typeof snap?.output_file === 'string' ? snap.output_file : undefined,
    truncated: typeof snap?.truncated === 'boolean' ? snap.truncated : undefined,
    outputTotalBytes: typeof snap?.output_total_bytes === 'number' ? snap.output_total_bytes : undefined,
    startTime: toEpochMs(snap?.start_time),
    endTime: toEpochMs(snap?.end_time) ?? receivedAt,
    receivedAt,
  }
}

/**
 * 把完成通知作为独立的合成 assistant 消息注入消息流。
 * 消息 ID 确定性（msg_tasknotif_<taskId>）→ 回放/双路帧 upsert 幂等；
 * time.completed 即时定稿 → 不进 streaming 态；完全不触碰 TurnState。
 */
function emitTaskNotification(sessionId: string, n: PendingTaskNotification) {
  const msgId = `${TASK_NOTIFICATION_MESSAGE_ID_PREFIX}${n.taskId}`
  const now = Date.now()
  emit(
    'message.updated',
    {
      info: {
        id: msgId,
        sessionID: sessionId,
        role: 'assistant',
        time: { created: now, completed: now },
        parentID: '',
        modelID: getCurrentAcpModelId(),
        providerID: 'xai',
        mode: '',
        agent: '',
        path: { cwd: _serverCwd, root: _serverCwd },
        cost: 0,
        tokens: emptyTokens(),
      },
    },
    sessionId,
  )
  emitPartUpdated(sessionId, msgId, { id: `${msgId}:task`, type: 'task-completion', ...n })
}

function handleToolCall(sessionId: string, turn: TurnState, tc: Record<string, unknown>) {
  const messageId = ensureAssistant(sessionId, turn)
  breakActiveParts(turn)

  const callId = String(tc.toolCallId ?? '')
  if (!callId) return
  const meta = extractToolMeta(tc._meta)
  const wireTitle = typeof tc.title === 'string' ? tc.title : ''
  const toolName = meta.name || wireTitle || 'tool'
  // wire title 信息量最高（后端按工具生成 "Fetch: url" / "Read `path`" 等，
  // 与 TUI 头部行一致）；meta.label 只是展示名，仅作兜底。等于工具名时不设，
  // 避免 ToolPartView 渲染重复。
  const title = (wireTitle && wireTitle !== toolName) ? wireTitle
    : (meta.label && meta.label !== toolName) ? meta.label : undefined
  const rec: ToolRec = {
    partId: `${messageId}:tool:${callId}`,
    callID: callId,
    tool: toolName,
    messageId,
    state: {
      status: mapToolStatus(tc.status),
      input: isRecord(tc.rawInput) ? tc.rawInput : {},
      title,
      time: { start: Date.now() },
    },
  }
  // 历史回放会把一次调用合并成单条终态 tool_call（带 content/rawOutput，
  // 之后不再有 tool_call_update）——输出提取和完成态收敛在这里也要做，
  // 否则刷新页面后工具卡片丢输出。
  const { output, metadata } = extractToolOutput(tc.content)
  if (output !== undefined) rec.state.output = output
  if (tc.rawOutput != null && rec.state.output === undefined) {
    rec.state.output = typeof tc.rawOutput === 'string' ? tc.rawOutput : JSON.stringify(tc.rawOutput, null, 2)
  }
  if (metadata) rec.state.metadata = metadata
  if (rec.state.status === 'completed' || rec.state.status === 'error') {
    rec.state.time.end = Date.now()
    rec.state.output ??= ''
    rec.state.title ??= rec.tool
    rec.state.metadata ??= {}
    markToolCallTerminal(sessionId, callId)
  }
  turn.tools.set(callId, rec)
  emitToolPart(sessionId, messageId, rec)
}

function handleToolCallUpdate(sessionId: string, turn: TurnState, tc: Record<string, unknown>) {
  const callId = String(tc.toolCallId ?? '')
  if (!callId) return
  // 已终态的调用再收到非终态更新（如后台任务跨 turn 迟到的 in_progress 输出块）
  // → 忽略，避免 fallback 新建 running 卡片把已完成的调用"复活"成永远转圈。
  const incomingStatus = tc.status != null ? mapToolStatus(tc.status) : null
  if (isToolCallTerminal(sessionId, callId) && incomingStatus !== 'completed' && incomingStatus !== 'error') {
    return
  }
  const messageId = ensureAssistant(sessionId, turn)
  let rec = turn.tools.get(callId)
  if (!rec) {
    // update 先于 tool_call 到达（或跨重连），兜底创建
    rec = {
      partId: `${messageId}:tool:${callId}`,
      callID: callId,
      tool: 'tool',
      messageId,
      state: { status: 'running', input: {}, time: { start: Date.now() } },
    }
    turn.tools.set(callId, rec)
  }

  const meta = extractToolMeta(tc._meta)
  if (meta.name) rec.tool = meta.name
  if (tc.status != null) rec.state.status = mapToolStatus(tc.status)
  // title 只在和 tool 名不同时才设，避免 ToolPartView 渲染重复；
  // wire title 优先于 meta.label（同 handleToolCall）。
  const wireUpdateTitle = typeof tc.title === 'string' ? tc.title : undefined
  const updateTitle = (wireUpdateTitle && wireUpdateTitle !== rec.tool ? wireUpdateTitle : undefined)
    ?? (meta.label && meta.label !== rec.tool ? meta.label : undefined)
  if (updateTitle) rec.state.title = updateTitle
  if (isRecord(tc.rawInput)) rec.state.input = tc.rawInput

  const { output, metadata } = extractToolOutput(tc.content)
  if (output !== undefined) rec.state.output = output
  if (tc.rawOutput != null && rec.state.output === undefined) {
    rec.state.output = typeof tc.rawOutput === 'string' ? tc.rawOutput : JSON.stringify(tc.rawOutput, null, 2)
  }
  if (metadata) rec.state.metadata = { ...rec.state.metadata, ...metadata }

  if (rec.state.status === 'completed' || rec.state.status === 'error') {
    rec.state.time.end = Date.now()
    rec.state.output ??= ''
    rec.state.title ??= rec.tool
    rec.state.metadata ??= {}
    markToolCallTerminal(sessionId, callId)
  }

  emitToolPart(sessionId, messageId, rec)
}

/**
 * 模型侧注入的用户内容不进聊天流（对齐 TUI 的
 * user_message_hidden_from_scrollback）：hideFromScrollback 元数据、
 * `<system-reminder>` / `<monitor-event>` 块、monitor 汇总行、分隔线。
 * cron 定时任务的 prompt 例外——剥掉 reminder 框架后返回真正的用户 prompt。
 * 返回 null 表示整块隐藏。
 */
function visibleUserChunkText(content: unknown, text: string): string | null {
  if (isRecord(content) && isRecord(content._meta) && content._meta.hideFromScrollback === true) {
    return null
  }
  const t = text.trimStart()
  if (t.startsWith('<system-reminder>')) {
    // cron 框架：<system-reminder>…scheduled task execution…</system-reminder>\n\n<prompt>
    const endTag = '</system-reminder>'
    const close = t.indexOf(endTag)
    if (close >= 0 && t.slice(0, close).includes('scheduled task execution')) {
      const body = t.slice(close + endTag.length).trim()
      if (body) return body
    }
    return null
  }
  if (t.startsWith('<monitor-event')) return null
  if (t.trim() === '---') return null
  const first = t.split('\n', 1)[0]
  if (/^\d/.test(first) && first.includes(' monitor events from ') && first.includes(' (use ')) return null
  return text
}

function handleUserMessageChunk(sessionId: string, turn: TurnState, content: unknown) {
  // 本地发出的 prompt 已经合成过 user 消息，忽略回显
  if (turn.promptInFlight) return

  const text = visibleUserChunkText(content, contentBlockText(content))
  if (text === null) return
  // 历史回放：user chunk 开启新回合
  if (turn.assistantId) {
    finalizeTurn(turn)
  }
  if (!turn.replayUser) {
    const messageId = newId('msg_u')
    const partId = `${messageId}:text`
    turn.replayUser = { messageId, partId }
    turn.lastUserMessageId = messageId
    emit(
      'message.updated',
      {
        info: {
          id: messageId,
          sessionID: sessionId,
          role: 'user',
          time: { created: Date.now() },
          agent: '',
          model: { providerID: 'xai', modelID: getCurrentAcpModelId() },
        },
      },
      sessionId,
    )
    emitPartUpdated(sessionId, messageId, { id: partId, type: 'text', text: '' })
  }
  if (text) emitTextDelta(sessionId, turn.replayUser.messageId, turn.replayUser.partId, text)
}

function handlePlan(sessionId: string, plan: Record<string, unknown>) {
  const entries = Array.isArray(plan.entries) ? plan.entries : []
  const todos = entries.filter(isRecord).map(e => ({
    content: typeof e.content === 'string' ? e.content : '',
    status: typeof e.status === 'string' ? e.status : 'pending',
    priority: typeof e.priority === 'string' ? e.priority : 'medium',
  }))
  emit('todo.updated', { sessionID: sessionId, todos }, sessionId)
}

// 会话级附加状态（后续步骤使用）
const availableCommands = new Map<string, unknown[]>()
const currentModes = new Map<string, string>()

export function getAvailableCommands(sessionId: string): unknown[] {
  return availableCommands.get(sessionId) ?? []
}

export function getCurrentMode(sessionId: string): string {
  return currentModes.get(sessionId) ?? ''
}

/** ACP session/update → OpenCodeUI 事件转译入口（连接回调 + 单元测试使用） */
export function handleAcpSessionUpdate(params: Record<string, unknown>) {
  const sessionId = String(params.sessionId ?? '')
  if (!sessionId) return
  const update = params.update
  if (!isRecord(update)) return
  const turn = getTurn(sessionId)

  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      turn.replayUser = null
      handleAgentText(sessionId, turn, contentBlockText(update.content), 'text')
      break
    }
    case 'user_message_chunk': {
      handleUserMessageChunk(sessionId, turn, update.content)
      break
    }
    case 'agent_thought_chunk': {
      turn.replayUser = null
      handleAgentText(sessionId, turn, contentBlockText(update.content), 'reasoning')
      break
    }
    case 'tool_call': {
      turn.replayUser = null
      handleToolCall(sessionId, turn, update)
      break
    }
    case 'tool_call_update': {
      handleToolCallUpdate(sessionId, turn, update)
      break
    }
    case 'plan': {
      handlePlan(sessionId, update)
      break
    }
    case 'available_commands_update': {
      if (Array.isArray(update.availableCommands)) {
        availableCommands.set(sessionId, update.availableCommands)
      }
      break
    }
    case 'current_mode_update': {
      if (typeof update.currentModeId === 'string') {
        currentModes.set(sessionId, update.currentModeId)
      }
      break
    }
    case 'turn_completed': {
      // turn 结束（含被取消的 turn）——把仍在转圈的工具卡片收敛到取消态。
      // finalizeTurn 复位 assistantId：后端 wake turn（前端无 promptInFlight，
      // 不会走 acpPrompt 收尾）结束后不复位的话，后续空闲期的 task_completed
      // 会被误判 busy 而滞留缓冲。随后 flush 缓冲的完成通知到消息流末尾。
      cancelDanglingTools(sessionId, turn)
      finalizeTurn(turn)
      flushPendingTaskNotifications(sessionId)
      break
    }
    case 'model_changed': {
      // 后端 x.ai/session_notification model_changed 推送（多客户端同步）
      const mc = update as Record<string, unknown>
      if (typeof mc.modelId === 'string') {
        sessionModelIds.set(sessionId, mc.modelId)
      }
      break
    }
    case 'session_info_update': {
      if (typeof update.title === 'string' && update.title) {
        emit(
          'session.updated',
          { info: { id: sessionId, title: update.title, directory: sessionDirs.get(sessionId) ?? _serverCwd, time: { created: Date.now(), updated: Date.now() } } },
          sessionId,
        )
      }
      break
    }
    case 'retry_state': {
      // 后端 RetryState 推送（failed/exhausted 是终态错误）。
      // XaiSessionUpdate::RetryState 序列化为 flat JSON：
      //   { sessionUpdate: "retry_state", type: "failed", error_type: "...", message: "..." }
      const up = update as Record<string, unknown>
      // 兼容两种格式：flat（x.ai/session_notification）和 nested（acp session/update）
      const rs = (up.retryState as Record<string, unknown> | undefined) ?? up
      const kind = rs.type ? String(rs.type) : ''
      const message = String(rs.message ?? rs.reason ?? '采样失败')
      const errorType = String(rs.error_type ?? rs.errorType ?? 'unknown')
      if (kind === 'failed' || kind === 'exhausted') {
        turn.promptInFlight = false
        // 把错误作为 RetryPart 内联到 assistant 消息中，
        // 由 RetryPartView 渲染为可展开的结构化错误卡片。
        const assistantId = ensureAssistant(sessionId, turn)
        breakActiveParts(turn)
        const attempt = typeof rs.attempt === 'number' ? rs.attempt
          : typeof rs.attempts === 'number' ? rs.attempts
          : 1
        const retryPartId = `${assistantId}:retry:${Date.now()}`
        emitPartUpdated(sessionId, assistantId, {
          id: retryPartId,
          type: 'retry',
          attempt,
          error: {
            name: 'APIError',
            data: {
              message,
              isRetryable: kind === 'exhausted',
              metadata: { errorType, kind },
            },
          },
          time: { created: Date.now() },
        })
        finalizeTurn(turn)
        flushPendingTaskNotifications(sessionId)
        // 保留 loadError 供无消息时的 fallback 显示（ChatArea 的 MessageErrorView）
        import('../store/messageStore').then(({ messageStore }) => {
          messageStore.setLoadError(sessionId, {
            name: 'APIError',
            data: {
              message,
              isRetryable: kind === 'exhausted',
              metadata: { errorType, kind },
            },
          })
        })
        emit(
          'session.error',
          { sessionID: sessionId, name: errorType, data: { message, kind } },
          sessionId,
        )
        emit('session.status', { sessionID: sessionId, status: { type: 'idle' } }, sessionId)
        emit('session.idle', { sessionID: sessionId }, sessionId)
      }
      break
    }
    case 'task_completed': {
      // 后台任务完成 → 独立系统消息（不内联进当前 assistant 消息）。
      // wire 形态（x.ai/task_completed 帧）：update.task_snapshot 为 TaskSnapshot
      // （snake_case：task_id / command / exit_code / signal…）。
      // streaming 期间缓冲（前端发起的 turn：promptInFlight；后端 wake turn：
      // assistantId 置位），idle 时机 flush 到消息流末尾；回放窗口内一律
      // 立即渲染以保持历史位置。
      const t = update as Record<string, unknown>
      const snap = isRecord(t.task_snapshot) ? t.task_snapshot : undefined
      const n = parseTaskNotification(t, snap)
      const busy = turn.promptInFlight || turn.assistantId != null
      if (busy && !replayingSessions.has(sessionId)) {
        let list = pendingTaskNotifications.get(sessionId)
        if (!list) pendingTaskNotifications.set(sessionId, (list = []))
        list.push(n)
      } else {
        emitTaskNotification(sessionId, n)
      }
      break
    }
    // ── Subagent 生命周期 ──────────────────────────────────────────
    case 'subagent_spawned': {
      const sa = update as Record<string, unknown>
      const subagentType = typeof sa.subagentType === 'string' ? sa.subagentType : 'agent'
      const desc = typeof sa.description === 'string' ? sa.description : ''
      const msg = `🤖 Subagent started: **${subagentType}**${desc ? ` — ${desc}` : ''}`
      const id = ensureAssistant(sessionId, turn)
      breakActiveParts(turn)
      emitPartUpdated(sessionId, id, { id: `${id}:sub:${Date.now()}`, type: 'text', text: msg })
      break
    }
    case 'subagent_finished': {
      const sf = update as Record<string, unknown>
      const subagentType = typeof sf.subagentType === 'string' ? sf.subagentType : 'agent'
      const tokens = typeof sf.tokensUsed === 'number' ? sf.tokensUsed : 0
      const msg = `✅ Subagent finished: **${subagentType}**${tokens ? ` (${tokens} tokens)` : ''}`
      const id = ensureAssistant(sessionId, turn)
      breakActiveParts(turn)
      emitPartUpdated(sessionId, id, { id: `${id}:sub:${Date.now()}`, type: 'text', text: msg })
      break
    }
    // subagent_progress: high-frequency ticks, don't emit UI parts
    case 'subagent_progress':
      break
    // ── Compaction 通知 ────────────────────────────────────────────
    case 'auto_compact_started': {
      const ac = update as Record<string, unknown>
      const pct = typeof ac.percentage === 'number' ? ac.percentage : 0
      const id = ensureAssistant(sessionId, turn)
      breakActiveParts(turn)
      emitPartUpdated(sessionId, id, { id: `${id}:compact:${Date.now()}`, type: 'text', text: `🔄 Compacting context (${pct}% used)...` })
      break
    }
    case 'auto_compact_completed': {
      const acc = update as Record<string, unknown>
      const after = typeof acc.tokensAfter === 'number' ? acc.tokensAfter : 0
      const id = ensureAssistant(sessionId, turn)
      breakActiveParts(turn)
      emitPartUpdated(sessionId, id, { id: `${id}:compact:${Date.now()}`, type: 'text', text: `✅ Context compacted (${after} tokens)` })
      break
    }
    case 'auto_compact_failed':
    case 'auto_compact_cancelled':
      // log-only for now
      break
    default:
      break
  }
}

function handleExtNotification(method: string, params: unknown) {
  if (method === 'x.ai/models/update' && isRecord(params)) {
    _modelState = params as unknown as AcpModelState
    return
  }
  // x.ai/session_notification 携带 RetryState 等 xAI 扩展更新，
  // 结构与 session/update 兼容（{ sessionId, update: { sessionUpdate, ... } }），
  // 走同一个转译入口以触发 session.error / messageStore.setLoadError。
  if (method === 'x.ai/session_notification' && isRecord(params)) {
    handleAcpSessionUpdate(params)
    return
  }
  // x.ai/task_completed：后台任务完成帧（SessionNotification 同构序列化），
  // 复用同一转译入口渲染完成卡片——不路由的话 task_completed 卡片永远不出现
  if (method === 'x.ai/task_completed' && isRecord(params)) {
    handleAcpSessionUpdate(params)
    return
  }
  window.dispatchEvent(new CustomEvent('acp:extNotification', { detail: { method, params } }))
}

// ── 会话操作 ─────────────────────────────────────────────────────

export interface AcpSessionInfo {
  id: string
  directory: string
  title: string
  time: { created: number; updated: number }
}

export async function acpNewSession(directory?: string): Promise<AcpSessionInfo> {
  const client = await ensureAcp()
  // cwd 保持后端原生斜杠方向（Windows 反斜杠），不得强转成正斜杠——
  // 否则新建会话会落到与 TUI/原生会话不同的编码目录，造成割裂。
  // 见 sessionCwd.ts 的根因注释。
  const cwd = sessionCwdForWire(directory || _serverCwd)
  const resp = (await client.rpc.request('session/new', { cwd, mcpServers: [] })) as Record<string, unknown>
  const sessionId = String(resp.sessionId ?? '')
  if (!sessionId) throw new Error('session/new 未返回 sessionId')
  if (isRecord(resp.models)) {
    _modelState = resp.models as unknown as AcpModelState
    const current = (resp.models as Record<string, unknown>).currentModelId
    if (typeof current === 'string') sessionModelIds.set(sessionId, current)
  }
  sessionDirs.set(sessionId, cwd)
  const now = Date.now()
  return { id: sessionId, directory: cwd, title: '', time: { created: now, updated: now } }
}

export interface AcpPromptParams {
  sessionId: string
  text: string
  modelId?: string
  agent?: string
  variant?: string
  mode?: string
}

/**
 * 发送 prompt：本地合成 user 消息 → 发起 session/prompt →
 * 流式回复经 handleSessionUpdate 转译 → 完成后注入 session.idle
 */
export async function acpPrompt(params: AcpPromptParams): Promise<void> {
  const client = await ensureAcp()
  const { sessionId, text } = params

  // 等上一个在途 prompt 收尾（插队场景：cancel 已发出，旧 RPC 会带着
  // cancelled stopReason 很快返回）。收尾包括 promptInFlight 复位和 idle
  // 事件广播——必须发生在新回合状态搭建之前。
  const prior = pendingPrompts.get(sessionId)
  if (prior) await prior

  const turn = getTurn(sessionId)
  const now = Date.now()

  // ACP 的模型是会话级状态：所选模型与会话当前模型不一致时先切换
  if (params.modelId) {
    const current = sessionModelIds.get(sessionId)
    if (current !== params.modelId) {
      await client.setModel(sessionId, params.modelId)
      sessionModelIds.set(sessionId, params.modelId)
    }
  }
  // 模式切换（default / plan / ask）
  if (params.mode) {
    await client.setMode(sessionId, params.mode).catch(() => {
      // 模式切换失败不阻塞 prompt
    })
  }

  // 合成 user 消息（ACP 不回显在途 prompt）
  const userMessageId = newId('msg_u')
  turn.lastUserMessageId = userMessageId
  turn.assistantId = null
  turn.textPartId = null
  turn.reasoningPartId = null
  turn.promptInFlight = true

  // 先设 streaming（在发 prompt 之前），避免 prompt 响应先到时 idle 被后到的 setStreaming 覆盖
  const { messageStore } = await import('../store/messageStore')
  messageStore.setStreaming(sessionId, true)
  emit('session.status', { sessionID: sessionId, status: { type: 'busy' } }, sessionId)

  emit(
    'message.updated',
    {
      info: {
        id: userMessageId,
        sessionID: sessionId,
        role: 'user',
        time: { created: now },
        agent: params.agent ?? '',
        model: { providerID: 'xai', modelID: params.modelId || getCurrentAcpModelId(), variant: params.variant },
      },
    },
    sessionId,
  )
  emitPartUpdated(sessionId, userMessageId, { id: `${userMessageId}:text`, type: 'text', text })

  const settled = client.rpc
    .request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })
    .then(() => {
      turn.promptInFlight = false
      cancelDanglingTools(sessionId, turn)
      finalizeTurn(turn)
      flushPendingTaskNotifications(sessionId)
      emit('session.status', { sessionID: sessionId, status: { type: 'idle' } }, sessionId)
      emit('session.idle', { sessionID: sessionId }, sessionId)
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      turn.promptInFlight = false
      cancelDanglingTools(sessionId, turn)
      finalizeTurn(turn)
      flushPendingTaskNotifications(sessionId)
      // 在 UI 中显示错误消息
      import('../store/messageStore').then(({ messageStore }) => {
        messageStore.setLoadError(sessionId, { name: 'APIError', data: { message: msg, isRetryable: true, metadata: { errorType: 'prompt_failure' } } })
      })
      emit('session.status', { sessionID: sessionId, status: { type: 'idle' } }, sessionId)
      emit(
        'session.error',
        { sessionID: sessionId, name: 'UnknownError', data: { message: msg } },
        sessionId,
      )
    })
  pendingPrompts.set(sessionId, settled)
  void settled.finally(() => {
    if (pendingPrompts.get(sessionId) === settled) pendingPrompts.delete(sessionId)
  })
}

export async function acpCancel(sessionId: string): Promise<void> {
  const client = await ensureAcp()
  await client.cancel(sessionId)
}

export async function acpLoadSession(sessionId: string): Promise<void> {
  const client = await ensureAcp()
  // 回放窗口：load 期间的 task_completed 立即按事件流顺序渲染（保历史位置），
  // 调用方（useSessionManager.loadSession）在回放 settle 后 finishAcpReplay。
  beginAcpReplay(sessionId)
  // cwd 必须保持后端原生斜杠方向（Windows 反斜杠），不得强转——
  // 否则 session/load 会因目录编码不匹配而找不到会话（Path not found）。
  // 见 sessionCwd.ts 的根因注释。
  const cwd = sessionCwdForWire(_serverCwd)
  await client.loadSession(sessionId, cwd)
}

/**
 * ACP 扩展方法请求，自动解包 JSON-RPC `result` 外衣。
 * 后端 ext 响应形如 `{ result: { sessions: [...] } }` — 这里返回 `result` 内容。
 */
export async function acpExtRequest(method: string, params?: unknown): Promise<unknown> {
  const client = await ensureAcp()
  const raw = await client.extRequest(method, params ?? {})
  if (isRecord(raw) && 'result' in raw) return raw.result
  return raw
}
