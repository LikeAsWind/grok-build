// ============================================
// ACP Bridge — grok ACP WebSocket ↔ OpenCodeUI 事件桥
//
// 职责：
// 1. 管理唯一的 ACP 连接（fetch /config → WS → initialize → authenticate）
// 2. 把 ACP session/update 流转译成 OpenCodeUI 的 SSE 事件格式，
//    注入 events.ts 的 broadcastEvent（messageStore 等下游逻辑零改动）
// 3. 提供 prompt / cancel / createSession / models 给各 api 模块调用
// ============================================

// 连接/回合状态是模块级单例：HMR 热更会分裂出第二份实例（WS 帧写新实例、
// UI 绑旧实例，消息"到了却看不见"），必须整页刷新。
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload())

import { AcpClient } from './acp'
import { injectGlobalEvent, setAcpConnectionState } from './events'
import { sessionCwdForWire } from './sessionCwd'
import { serverStore } from '../store/serverStore'
import { childSessionStore } from '../store/childSessionStore'
import { TASK_NOTIFICATION_MESSAGE_ID_PREFIX, WAKE_REPLY_MESSAGE_ID_PREFIX } from '../features/message/taskNotification'
import { persistSynthMessage } from '../features/message/synthNotifPersist'
import { QUEUED_MESSAGE_ID_PREFIX } from '../features/message/queuedMessage'
import { getMessageText } from '../types/message'
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

// ── 自动重连（意外断开时指数退避）────────────────────────────────
let _reconnectAttempt = 0
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null

function cancelReconnect() {
  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer)
    _reconnectTimer = null
  }
  _reconnectAttempt = 0
}

function scheduleReconnect() {
  if (_reconnectTimer) return
  const delay = Math.min(30_000, 1_000 * 2 ** _reconnectAttempt)
  _reconnectAttempt++
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null
    void ensureAcp()
      .then(() => {
        // 断线窗口内的通知已丢失；由 useSessionManager 监听此事件
        // 重新拉取当前会话快照补齐
        window.dispatchEvent(new CustomEvent('acp:reconnected'))
      })
      .catch(() => {
        scheduleReconnect()
      })
  }, delay)
}

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
        // 必须 reject 全部在途 RPC（否则在途 session/prompt 永不 settle，
        // pendingPrompts 留着死 promise，该会话后续消息全部排队夯死）。
        // close() 幂等：主动断开路径（disconnectAcpBridge）已清空 pending。
        client.close()
        if (_client === client) {
          _client = null
          _connectPromise = null
          setStatus('disconnected', 'WebSocket 连接已断开')
          scheduleReconnect()
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
      _reconnectAttempt = 0
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
  cancelReconnect()
  // 先摘 _client 再 close：onclose 里 `_client === client` 判假，
  // 主动断开不会触发自动重连（onclose 可能同步或异步触发）
  const client = _client
  _client = null
  _connectPromise = null
  client?.close()
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
  /** 非空 = 当前 turn 是 task-completed 唤醒轮（回复消息用确定性 id，收尾补 idle） */
  wakeTaskId: string | null
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
// auto-wake 唤醒轮（模型对任务结果的反应）渲染为一条正常的独立
// assistant 消息（msg_wake_<taskId>，与普通对话回合同构），紧跟通知
// 卡片之后；TurnState.wakeTaskId 标记当前 turn 是唤醒轮。
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
  ownerSessionId?: string
  description?: string
  /** wire 帧顶层 will_wake：true = 该任务会触发唤醒轮（卡片并入 wake 消息） */
  willWake?: boolean
}

/** 后台子 agent 完成通知（subagent_finished → agent-completion part） */
interface PendingAgentNotification {
  taskId: string
  /** 子 agent 标识（subagent_id，可能为空串） */
  command: string
  ok: boolean
  output?: string
  /** 任务描述（spawned 时的 description/command） */
  description?: string
  agentType?: string
  childSessionId?: string
  turns?: number
  toolCalls?: number
  durationMs?: number
  /** 前端收到通知帧的时间（epoch ms） */
  receivedAt: number
  /** 不参与唤醒轮（WAKE_REMINDER_RE 不识别子 agent 唤醒轮） */
  willWake?: false
}

/** 通知的权威数据源：task_completed / subagent_finished 帧建记录（upsert 幂等 + 丢帧兜底合成） */
interface TaskNotifRecord {
  data: PendingTaskNotification | PendingAgentNotification
  /**
   * 卡片渲染位置：null = 未渲染（缓冲/hold 中）；
   * 'standalone' = 独立系统消息（msg_tasknotif_）；
   * 'wake' = 作为 wake 消息（msg_wake_）的第一个 part
   */
  placement: 'standalone' | 'wake' | null
  /** placement === 'wake' 时的宿主消息 id，供重复帧重发定位 */
  wakeMessageId?: string
}

const taskNotifRegistry = new Map<string, Map<string, TaskNotifRecord>>()

/** subagent_spawned 帧携带 description/subagent_type，finished 帧不含这两个字段，需缓存跨帧传递 */
const subagentMeta = new Map<string, Map<string, { description?: string; agentType?: string }>>()

/** 判别通知是子 agent 完成（agent-completion）还是 bash 任务（task-completion） */
function isAgentNotification(n: PendingTaskNotification | PendingAgentNotification): n is PendingAgentNotification {
  return 'agentType' in n
}

function getTaskNotifRecord(sessionId: string, taskId: string): TaskNotifRecord | undefined {
  return taskNotifRegistry.get(sessionId)?.get(taskId)
}

function setTaskNotifRecord(sessionId: string, taskId: string, record: TaskNotifRecord) {
  let map = taskNotifRegistry.get(sessionId)
  if (!map) {
    map = new Map()
    taskNotifRegistry.set(sessionId, map)
  }
  map.set(taskId, record)
}

/** 缓冲中的通知（taskId 列表；权威数据在 taskNotifRegistry） */
const pendingTaskNotifications = new Map<string, string[]>()

// 回放窗口标记：session/load 期间的事件流与 live turn 无法从流内容区分。
// 回放中必须立即按事件流顺序渲染通知（保历史位置），而非缓冲堆到末尾——
// 回放内容会置位 turn.assistantId，不打标会把全部历史通知误判为 busy。
const replayingSessions = new Set<string>()

export function beginAcpReplay(sessionId: string) {
  replayingSessions.add(sessionId)
}

export function finishAcpReplay(sessionId: string) {
  replayingSessions.delete(sessionId)
  // 兜底：回放结束后不该再有未渲染的通知——hold 中的（wake chunk 没等到，
  // 如唤醒被打断后刷新）降级为独立卡，连同缓冲一起 flush
  demoteHeldTaskNotifications(sessionId)
  flushPendingTaskNotifications(sessionId)
}

function flushPendingTaskNotifications(sessionId: string) {
  const list = pendingTaskNotifications.get(sessionId)
  if (!list?.length) return
  // 再检查：插队 prompt 在途 / 新 wake 轮已开——暂缓，下一个 settle/turn_completed 再试。
  // 否则被打断唤醒轮的 cancelled turn_completed 会把通知插到新对话中间。
  const turn = turns.get(sessionId)
  if (turn && (turn.promptInFlight || turn.wakeTaskId != null)) return
  pendingTaskNotifications.delete(sessionId)
  for (const taskId of list) {
    const record = getTaskNotifRecord(sessionId, taskId)
    if (record) emitTaskNotification(sessionId, record)
  }
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
  taskNotifRegistry.delete(sessionId)
  pendingTaskNotifications.delete(sessionId)
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
      wakeTaskId: null,
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
  // 唤醒轮：确定性 id（msg_wake_<taskId>）→ 回放/双路帧 upsert 幂等，
  // UI 侧据前缀渲染"后台任务自动回复"标识
  const id = turn.wakeTaskId
    ? `${WAKE_REPLY_MESSAGE_ID_PREFIX}${turn.wakeTaskId}`
    : newId('msg_a')
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
  turn.wakeTaskId = null
}

/**
 * 新 prompt 发出前搭建回合状态（acpPrompt 调用；导出供测试）。
 * 后端驱动的 turn（唤醒轮）没有 pendingPrompts 记录，acpPrompt 等不到它——
 * 若其状态未收尾（turn_completed 尚未到达），必须先清干净：不清 wakeTaskId
 * 的话，新回合的回答会经 ensureAssistant 的确定性 id upsert 进旧的
 * msg_wake_ 消息（新回答接在唤醒回复末尾）。
 */
export function prepareTurnForPrompt(sessionId: string, userMessageId: string) {
  const turn = getTurn(sessionId)
  if (turn.assistantId || turn.wakeTaskId) {
    cancelDanglingTools(sessionId, turn)
    finalizeTurn(turn)
  }
  turn.lastUserMessageId = userMessageId
  turn.promptInFlight = true
}

/**
 * session/prompt RPC 返回时的收尾（acpPrompt 调用；导出供测试）。
 *
 * 后端驱动的唤醒轮可能在上一回合 RPC settle 之前就开始了——隐藏 wake chunk
 * 先到、beginWakeTurn 已置位 wakeTaskId。此时若无条件 finalizeTurn 会清掉
 * wakeTaskId，把唤醒回复劈成两段（后半落到新 msg_a），且其 turn_completed 的
 * wasWake=false 漏发 idle → 消息永远 isStreaming、发送按钮卡「停止」、新消息排队。
 *
 * 因此：回合已被唤醒轮接管（wakeTaskId 已置位）时，只复位 promptInFlight——
 * 定稿交给唤醒轮自己的 turn_completed 补发 idle，不抢跑。
 */
export function settlePromptTurn(sessionId: string) {
  const turn = getTurn(sessionId)
  turn.promptInFlight = false
  if (turn.wakeTaskId != null) {
    // 回合已被唤醒轮接管：不 finalize（会清 wakeTaskId 把唤醒回复劈成两段）、
    // 不发 idle（wake 轮仍在跑，session 尚未真正空闲）——定稿交给唤醒轮自己的
    // turn_completed（wasWake 分支补发 idle）。
    traceIdle(sessionId, 'settlePromptTurn', false, 'wake turn took over')
    return
  }
  cancelDanglingTools(sessionId, turn)
  finalizeTurn(turn)
  flushPendingTaskNotifications(sessionId)
  emit('session.status', { sessionID: sessionId, status: { type: 'idle' } }, sessionId)
  emit('session.idle', { sessionID: sessionId }, sessionId)
  traceIdle(sessionId, 'settlePromptTurn', true, '')
}

/**
 * idle 发射追踪：记录每次 settlePromptTurn / turn_completed 的 idle 决策，
 * 用于诊断「回复中...」状态不同步（卡住时看哪个路径没发射、原因是什么）。
 */
function traceIdle(sessionId: string, source: string, emitted: boolean, reason: string) {
  const w = window as unknown as { __idleLog?: Array<{ t: number; sessionId: string; source: string; emitted: boolean; reason: string }> }
  if (!w.__idleLog) w.__idleLog = []
  w.__idleLog.push({ t: performance.now(), sessionId, source, emitted, reason })
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
  // streaming 诊断：记录每条 delta 的时间戳和长度，供排查流式卡顿
  const w = window as unknown as {
    __deltaLog?: Array<{ t: number; len: number }>
    __streamDiag?: { sessionId: string; deltaCount: number; totalChars: number; startTime: number }
  }
  if (!w.__deltaLog) w.__deltaLog = []
  w.__deltaLog.push({ t: performance.now(), len: delta.length })
  // 按 turn 聚合统计
  if (!w.__streamDiag || w.__streamDiag.sessionId !== sessionId) {
    w.__streamDiag = { sessionId, deltaCount: 0, totalChars: 0, startTime: performance.now() }
  }
  w.__streamDiag.deltaCount++
  w.__streamDiag.totalChars += delta.length
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
    ownerSessionId: typeof snap?.owner_session_id === 'string' ? snap.owner_session_id : undefined,
    description: typeof snap?.description === 'string' ? snap.description : undefined,
    willWake: t.will_wake === true,
  }
}

/** 通知合成消息的 info + part（emit 与持久化共用同一构造） */
function buildTaskNotifMessage(sessionId: string, n: PendingTaskNotification | PendingAgentNotification) {
  const msgId = `${TASK_NOTIFICATION_MESSAGE_ID_PREFIX}${n.taskId}`
  const now = Date.now()
  const info = {
    id: msgId,
    sessionID: sessionId,
    role: 'assistant' as const,
    time: { created: now, completed: now },
    parentID: '',
    modelID: getCurrentAcpModelId(),
    providerID: 'xai',
    mode: '',
    agent: '',
    path: { cwd: _serverCwd, root: _serverCwd },
    cost: 0,
    tokens: emptyTokens(),
  }
  // subagent_finished → agent-completion part；其余 → task-completion part
  const part = isAgentNotification(n)
    ? {
        id: `${msgId}:task`,
        type: 'agent-completion' as const,
        taskId: n.taskId,
        command: n.command,
        description: n.description,
        agentType: n.agentType,
        childSessionId: n.childSessionId,
        ok: n.ok,
        output: n.output,
        turns: n.turns,
        toolCalls: n.toolCalls,
        durationMs: n.durationMs,
        receivedAt: n.receivedAt,
      }
    : { id: `${msgId}:task`, type: 'task-completion' as const, ...n }
  return { msgId, info, part }
}

/**
 * 持久化通知到 localStorage（页面刷新后 messageStore.injectSynthMessages 恢复）。
 * busy 缓冲 / willWake hold 中的通知也要持久化——否则 flush 前刷新会彻底丢失。
 * 锚点 = 触发时刻最后一条真实用户消息（文本 + 序数）：回放消息的 id/time 均为
 * 前端接收时现打（不稳定），恢复定位只能靠对话内容本身。
 */
function persistTaskNotifRecord(sessionId: string, record: TaskNotifRecord) {
  const { msgId, info, part } = buildTaskNotifMessage(sessionId, record.data)
  void import('../store/messageStore').then(({ messageStore }) => {
    const msgs = messageStore.getSessionState(sessionId)?.messages ?? []
    let anchor: { userText: string; userIndex: number } | undefined
    let userCount = 0
    for (const m of msgs) {
      if (m.info.role !== 'user' || m.info.id.startsWith(QUEUED_MESSAGE_ID_PREFIX)) continue
      userCount++
      const text = getMessageText(m)
      if (text) anchor = { userText: text, userIndex: userCount }
    }
    persistSynthMessage(sessionId, {
      info,
      parts: [{ ...part, sessionID: sessionId, messageID: msgId }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any, anchor)
  })
}

/**
 * 把完成通知作为独立的合成 assistant 消息注入消息流。
 * 消息 ID 确定性（msg_tasknotif_<taskId>）→ 回放/双路帧 upsert 幂等；
 * time.completed 即时定稿 → 不进 streaming 态；完全不触碰 TurnState。
 */
function emitTaskNotification(sessionId: string, record: TaskNotifRecord) {
  const { msgId, info, part } = buildTaskNotifMessage(sessionId, record.data)
  emit('message.updated', { info }, sessionId)
  emitPartUpdated(sessionId, msgId, part)
  persistTaskNotifRecord(sessionId, record)
  record.placement = 'standalone'
}

/** 通知卡作为 wake 消息的 part 注入（并入唤醒回复，placement = 'wake'） */
function emitWakeNotificationPart(sessionId: string, messageId: string, record: TaskNotifRecord) {
  emitPartUpdated(sessionId, messageId, {
    id: `${messageId}:task`,
    type: 'task-completion',
    ...record.data,
  })
  record.placement = 'wake'
  record.wakeMessageId = messageId
}

/** 从 pending 缓冲列表摘除一个 taskId（已被别的路径渲染时防重复 flush） */
function removeFromPendingList(sessionId: string, taskId: string) {
  const list = pendingTaskNotifications.get(sessionId)
  if (!list) return
  const idx = list.indexOf(taskId)
  if (idx >= 0) list.splice(idx, 1)
  if (list.length === 0) pendingTaskNotifications.delete(sessionId)
}

/**
 * 把 hold 中（willWake 且未渲染）的通知降级进 pending 缓冲。
 * 用户抢先发 genuine prompt 时后端会消费掉 deferred completion、唤醒轮不再
 * 发生——hold 的卡片若不降级会永久丢失；降级后按普通通知在 idle 时机 flush
 * 为独立卡。
 */
export function demoteHeldTaskNotifications(sessionId: string) {
  const map = taskNotifRegistry.get(sessionId)
  if (!map) return
  for (const [taskId, record] of map) {
    if (record.placement !== null || record.data.willWake !== true) continue
    record.data.willWake = false
    let list = pendingTaskNotifications.get(sessionId)
    if (!list) pendingTaskNotifications.set(sessionId, (list = []))
    if (!list.includes(taskId)) list.push(taskId)
  }
}

// ── auto-wake 唤醒轮识别 ────────────────────────────────────────

// 唤醒 prompt 首行：Background task "{id}" completed... / Monitor "{id}" ended...
// （bash / monitor 两种；subagent-completed- 等其他 synthetic 轮暂不识别）
const WAKE_REMINDER_RE = /^(?:Background task|Monitor)\s+"([^"]+)"/

/**
 * 识别 task-completed 唤醒轮的隐藏 user chunk，返回 taskId。
 * 真实 wire 上 hideFromScrollback 在 update 级 _meta（updateMeta）；
 * content 级 _meta 为兼容保留。无 meta 时退回纯文本判定
 * （<system-reminder> 开头 + Background task/Monitor 文案）。
 * 识别失败返回 null（退化为现状：唤醒回复按普通消息渲染，只是缺标识）。
 */
function detectWakeTaskId(content: unknown, updateMeta: unknown, text: string): string | null {
  const hidden =
    (isRecord(updateMeta) && updateMeta.hideFromScrollback === true) ||
    (isRecord(content) && isRecord(content._meta) && content._meta.hideFromScrollback === true)
  let t = text.trimStart()
  const isReminder = t.startsWith('<system-reminder>')
  if (!hidden && !isReminder) return null
  if (isReminder) t = t.slice('<system-reminder>'.length).trimStart()
  const m = WAKE_REMINDER_RE.exec(t)
  return m ? m[1] : null
}

/**
 * 唤醒轮开始：置位 turn 状态（丢帧时合成最小记录兜底）。
 * 通知卡片作为 wake 消息（msg_wake_<taskId>）的第一个 part 注入——
 * 唤醒回复消息内部：标识 → 通知卡 → 模型汇报。
 * 唤醒轮后续内容（文本/思考/工具）走普通 handler，落在同一条消息上
 * （ensureAssistant 特判确定性 id）。
 * 例外：卡片已作为独立消息渲染过（早期 flush / will_wake 误报）→ 保持独立卡。
 */
function beginWakeTurn(sessionId: string, turn: TurnState, taskId: string, reminderText: string) {
  // 旧 turn 未收尾的防御（正常 turn_completed 已 finalize）
  if (turn.assistantId) finalizeTurn(turn)
  turn.wakeTaskId = taskId
  let record = getTaskNotifRecord(sessionId, taskId)
  if (!record) {
    // task_completed 帧丢失（重连等）：从 reminder 文本合成最小记录
    const cmdMatch = /Command:\s*([^\n|]+)/.exec(reminderText)
    const exitMatch = /exit code:\s*(-?\d+)/.exec(reminderText)
    const exitCode = exitMatch ? Number(exitMatch[1]) : undefined
    const now = Date.now()
    record = {
      data: {
        taskId,
        command: cmdMatch ? cmdMatch[1].trim() : '',
        exitCode,
        ok: exitCode === undefined || exitCode === 0,
        endTime: now,
        receivedAt: now,
      },
      placement: null,
    }
    setTaskNotifRecord(sessionId, taskId, record)
  }
  if (record.placement === null) {
    // hold / 缓冲中：从缓冲列表摘除，作为 wake 消息第一个 part 注入
    removeFromPendingList(sessionId, taskId)
    const messageId = ensureAssistant(sessionId, turn)
    breakActiveParts(turn)
    emitWakeNotificationPart(sessionId, messageId, record)
  }
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
  // 回放窗口：subtask 卡片 live 时由 subagent_spawned 通知产出，该通知不回放——
  // 从 spawn 工具的入参重建，紧跟工具卡之后（live 时不走这里，避免双卡）
  if (replayingSessions.has(sessionId) && isSpawnSubagentTool(toolName)) {
    emitReplaySubtaskPart(sessionId, messageId, callId, tc.rawInput)
  }
}

/** spawn_subagent 及其 legacy alias（对齐 TUI tracker 的 Task-family 判定） */
function isSpawnSubagentTool(name: string): boolean {
  return name === 'spawn_subagent' || name === 'task' || name === 'Task'
}

/** 回放时从 spawn_subagent 的 rawInput 重建 subtask part（字段与 subagent_spawned 路径同构） */
function emitReplaySubtaskPart(sessionId: string, messageId: string, callId: string, rawInput: unknown) {
  if (!isRecord(rawInput)) return
  const subagentType = typeof rawInput.subagent_type === 'string' ? rawInput.subagent_type : 'agent'
  const desc = typeof rawInput.description === 'string' ? rawInput.description : ''
  const prompt = typeof rawInput.prompt === 'string' ? rawInput.prompt : desc || subagentType
  const modelId = typeof rawInput.model === 'string' ? rawInput.model : undefined
  emitPartUpdated(sessionId, messageId, {
    id: `${messageId}:sub:${callId}`,
    type: 'subtask',
    prompt,
    description: desc,
    agent: subagentType,
    ...(modelId ? { model: { providerID: 'grok', modelID: modelId } } : {}),
  })
}

function handleToolCallUpdate(sessionId: string, turn: TurnState, tc: Record<string, unknown>) {
  const callId = String(tc.toolCallId ?? '')
  if (!callId) return
  const incomingStatus = tc.status != null ? mapToolStatus(tc.status) : null
  if (isToolCallTerminal(sessionId, callId)) {
    // 已终态且不在当前 turn（turn 已 finalize，tools 已清空）：任何迟到帧一律吞掉。
    // 后台任务真正退出时后端会对原始 callId 补发 completed + 全量输出
    // （wait_background_completion），不拦会走 fallback 新建卡片把任务输出
    // 挂进无关的 assistant 消息；输出由 task_completed 通知卡片承载
    // （对齐 TUI 的 bg_tool_call_to_task 引流）。
    if (!turn.tools.has(callId)) return
    // 仍在当前 turn：只放行终态补全（如 completed 后补 content），拦非终态复活
    if (incomingStatus !== 'completed' && incomingStatus !== 'error') return
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
function visibleUserChunkText(content: unknown, text: string, updateMeta?: unknown): string | null {
  if (isRecord(updateMeta) && updateMeta.hideFromScrollback === true) {
    return null
  }
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

function handleUserMessageChunk(sessionId: string, turn: TurnState, content: unknown, updateMeta?: unknown) {
  const rawText = contentBlockText(content)
  // 唤醒轮识别须在 promptInFlight 早退之前：wake chunk 不是本地 prompt 回显，
  // 且 RPC settle 与通知帧存在边缘竞态，提前检测更稳。
  const wakeTaskId = detectWakeTaskId(content, updateMeta, rawText)
  if (wakeTaskId) {
    beginWakeTurn(sessionId, turn, wakeTaskId, rawText)
    return
  }

  // 本地发出的 prompt 已经合成过 user 消息，忽略回显
  if (turn.promptInFlight) return

  const text = visibleUserChunkText(content, rawText, updateMeta)
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
      // update 级 _meta 携带 hideFromScrollback（真实 wire 位置）
      handleUserMessageChunk(sessionId, turn, update.content, update._meta)
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
        window.dispatchEvent(
          new CustomEvent('acp:modeChanged', {
            detail: { sessionId, modeId: update.currentModeId },
          }),
        )
      }
      break
    }
    case 'turn_completed': {
      // turn 结束（含被取消的 turn）：把仍在转圈的工具卡片收敛到取消态。
      // finalizeTurn 复位 assistantId/wakeTaskId：后端驱动的 turn（前端无
      // promptInFlight，不走 acpPrompt 收尾）结束后不复位的话，后续空闲期的
      // task_completed 会被误判 busy 而滞留缓冲。随后 flush 缓冲的完成通知。
      //
      // usage 回填 message.info.tokens/cost：finalizeTurn 会清空
      // turn.assistantId，这里先存一份。turn_completed 的 usage 是"这个回合
      // 总共消耗多少"（PromptUsage，可能覆盖多轮工具调用），跟 response_completed
      // 的"单次 model 调用消耗多少"是不同粒度——sessionStatsCompute.ts 的左下角
      // 用量进度条读的是 info.tokens，在这条线路接上之前它一直是 ensureAssistant
      // 写的空值，导致进度条整段退化成按消息字符数 /4 估算，跟 step-finish 显示的
      // 真实 token 数对不上。
      const assistantIdForUsage = turn.assistantId
      const turnUsage = update.usage as Record<string, unknown> | undefined
      if (assistantIdForUsage && turnUsage) {
        const inputTokensIncludingCache = Number(turnUsage.inputTokens ?? 0)
        const cachedRead = Number(turnUsage.cachedReadTokens ?? 0)
        const costTicks = typeof turnUsage.costUsdTicks === 'number' ? turnUsage.costUsdTicks : null
        const newTokens = {
          // inputTokens 口径含缓存读（PromptUsageModel 注释："including cache reads"）；
          // 减去 cachedRead 换算成 uncached，跟 StepFinishPartView 的
          // input + cache.read 求和口径对齐，避免缓存部分被重复计入 totalTokens。
          input: Math.max(0, inputTokensIncludingCache - cachedRead),
          output: Number(turnUsage.outputTokens ?? 0),
          reasoning: Number(turnUsage.reasoningTokens ?? 0),
          cache: {
            read: cachedRead,
            write: Number(turnUsage.cacheCreationTokens ?? 0),
          },
        }
        const newCost = costTicks != null ? costTicks / 1e10 : 0
        void import('../store/messageStore').then(({ messageStore }) => {
          const msgs = messageStore.getSessionState(sessionId)?.messages ?? []
          const msg = msgs.find(m => m.info.id === assistantIdForUsage)
          if (!msg || msg.info.role !== 'assistant') return
          emit('message.updated', { info: { ...msg.info, tokens: newTokens, cost: newCost } }, sessionId)
        })
      }
      const promptId = typeof update.prompt_id === 'string' ? update.prompt_id : ''
      if (!turn.wakeTaskId && promptId.startsWith('task-completed-')) {
        // 唤醒轮识别失败（reminder 文案漂移？）——内容已按普通消息渲染，
        // 只是缺"后台任务自动回复"标识。hold 中的通知卡永远等不到注入，
        // flush 为独立卡（内容不丢），并留诊断
        console.warn('[ACP] wake turn 未被识别，已按普通消息渲染:', promptId)
        const taskId = promptId.slice('task-completed-'.length)
        const record = getTaskNotifRecord(sessionId, taskId)
        if (record && record.placement === null) {
          record.data.willWake = false
          emitTaskNotification(sessionId, record)
        }
      }
      const wasWake = turn.wakeTaskId != null
      cancelDanglingTools(sessionId, turn)
      finalizeTurn(turn)
      flushPendingTaskNotifications(sessionId)
      if (wasWake && !turn.promptInFlight) {
        // 后端驱动的唤醒轮没有 acpPrompt settle 路径——这里补发 idle，
        // 让 messageStore 给 msg_wake_ 消息定稿（补 time.completed、退 streaming）
        emit('session.status', { sessionID: sessionId, status: { type: 'idle' } }, sessionId)
        emit('session.idle', { sessionID: sessionId }, sessionId)
        traceIdle(sessionId, 'turn_completed', true, 'wake turn')
      } else {
        traceIdle(sessionId, 'turn_completed', false, wasWake ? 'promptInFlight still true' : 'not a wake turn')
      }
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
    case 'response_completed': {
      // 每次 model response 完成（XaiSessionUpdate::ResponseCompleted）都会
      // 带一份这次调用自己的 token/cost 用量——构造成 step-finish part 挂到
      // 当前 assistant 消息末尾，供 StepFinishPartView 渲染"Step 完成信息"。
      // 一条消息内多轮 tool-call 循环会触发多次，各自产出独立的 part（id 带
      // 时间戳），不会互相覆盖。
      const usage = update.usage as Record<string, unknown> | undefined
      if (usage) {
        const assistantId = ensureAssistant(sessionId, turn)
        const costTicks = typeof usage.cost_usd_ticks === 'number' ? usage.cost_usd_ticks : null
        emitPartUpdated(sessionId, assistantId, {
          id: `${assistantId}:step-finish:${Date.now()}`,
          type: 'step-finish',
          reason: typeof update.stop_reason === 'string' ? update.stop_reason : '',
          // ticks → USD：1e10 ticks = $1（对应后端 USD_TICKS_PER_USD）。
          // costTicks 为 null 表示 provider 未上报 cost（不是免费），
          // StepFinishPartView 里 cost > 0 才显示，落到 0 等价于"不显示"。
          cost: costTicks != null ? costTicks / 1e10 : 0,
          tokens: {
            input: Number(usage.input_tokens ?? 0),
            output: Number(usage.output_tokens ?? 0),
            reasoning: Number(usage.reasoning_tokens ?? 0),
            cache: {
              read: Number(usage.cache_read_input_tokens ?? 0),
              write: Number(usage.cache_creation_input_tokens ?? 0),
            },
          },
        })
      }
      break
    }
    case 'task_completed': {
      // 后台任务完成（x.ai/task_completed 帧，update.task_snapshot 为 snake_case
      // TaskSnapshot）。分流：
      // - will_wake=true → hold：只存 registry，等唤醒轮把卡片作为 wake 消息的
      //   第一个 part 注入（beginWakeTurn）。唤醒被取消的兜底见
      //   demoteHeldTaskNotifications / turn_completed 识别失败分支。
      // - will_wake=false → 独立系统消息：streaming 期间缓冲，idle 时机 flush
      //   到消息流末尾；回放窗口内一律立即渲染以保持历史位置。
      const t = update as Record<string, unknown>
      const snap = isRecord(t.task_snapshot) ? t.task_snapshot : undefined
      // 后端对每个后台任务无条件下发完成帧（TUI 滚动行/持久化需要），
      // 但 block_waited=true 表示模型已同步等到结果（等效前台执行）、
      // explicitly_killed=true 表示任务被显式 kill——这两类对用户而言
      // 都不是「后台任务完成」，渲染独立卡会造成误导，直接跳过。
      if (snap?.block_waited === true || snap?.explicitly_killed === true) break
      const n = parseTaskNotification(t, snap)
      const existing = getTaskNotifRecord(sessionId, n.taskId)
      const record: TaskNotifRecord = existing
        ? { ...existing, data: n }
        : { data: n, placement: null }
      setTaskNotifRecord(sessionId, n.taskId, record)
      if (record.placement === 'wake' && record.wakeMessageId) {
        // 已并入 wake 消息（双路帧重复投递）：重发 part 刷新数据
        emitWakeNotificationPart(sessionId, record.wakeMessageId, record)
        break
      }
      if (n.willWake && record.placement === null) {
        // hold：等唤醒轮注入（回放流里 wake chunk 紧随其后，同样 hold）。
        // 注入前刷新会丢——先持久化；恢复形态为独立卡紧贴 wake 回复之前
        persistTaskNotifRecord(sessionId, record)
        break
      }
      const busy = turn.promptInFlight || turn.assistantId != null || turn.wakeTaskId != null
      if (busy && !replayingSessions.has(sessionId)) {
        if (record.placement === null) {
          let list = pendingTaskNotifications.get(sessionId)
          if (!list) pendingTaskNotifications.set(sessionId, (list = []))
          if (!list.includes(n.taskId)) list.push(n.taskId)
          // 缓冲中刷新会丢——先持久化（flush 时 emit 会再 upsert，同 id 幂等）
          persistTaskNotifRecord(sessionId, record)
        } else {
          // 已渲染独立卡（双路帧重复投递）：直接重发刷新数据
          emitTaskNotification(sessionId, record)
        }
      } else {
        emitTaskNotification(sessionId, record)
      }
      break
    }
    // ── Subagent 生命周期 ──────────────────────────────────────────
    // wire 字段为 snake_case（Rust struct 直接序列化，rename_all 只作用 enum tag）。
    // 驱动 childSessionStore + 产出 `subtask` part → SubtaskPartView 渲染。
    case 'subagent_spawned': {
      const sa = update as Record<string, unknown>
      const childId = typeof sa.child_session_id === 'string' ? sa.child_session_id : undefined
      const subagentType = typeof sa.subagent_type === 'string' ? sa.subagent_type : 'agent'
      const desc = typeof sa.description === 'string' ? sa.description : ''
      const prompt = typeof sa.command === 'string' ? sa.command : desc || subagentType
      const modelId = typeof sa.model === 'string' ? sa.model : undefined
      if (childId) {
        childSessionStore.registerSubagent({
          id: childId,
          parentID: sessionId,
          title: desc || subagentType,
          agent: subagentType,
        })
      }
      // 缓存 spawned 帧的 description/agentType，finished 帧不含这两个字段
      const subagentId = typeof sa.subagent_id === 'string' ? sa.subagent_id : (childId ?? '')
      if (subagentId) {
        let sessionMeta = subagentMeta.get(sessionId)
        if (!sessionMeta) subagentMeta.set(sessionId, (sessionMeta = new Map()))
        sessionMeta.set(subagentId, { description: desc || undefined, agentType: subagentType !== 'agent' ? subagentType : undefined })
      }
      const id = ensureAssistant(sessionId, turn)
      breakActiveParts(turn)
      emitPartUpdated(sessionId, id, {
        // 稳定 id：同一子 agent 只产出一个 part；spawned 前 dispatch 子 session，
        // 后续 finish 由 store 驱动 UI，不重发 part。
        id: `${id}:sub:${sa.subagent_id ?? childId ?? Date.now()}`,
        type: 'subtask',
        prompt,
        description: desc,
        agent: subagentType,
        ...(modelId ? { model: { providerID: 'grok', modelID: modelId } } : {}),
      })
      break
    }
    case 'subagent_finished': {
      const sf = update as Record<string, unknown>
      const childId = typeof sf.child_session_id === 'string' ? sf.child_session_id : undefined
      const status = typeof sf.status === 'string' ? sf.status : 'completed'
      if (childId) {
        if (status === 'failed' || status === 'cancelled') {
          childSessionStore.markError(childId)
        } else {
          childSessionStore.markIdle(childId)
        }
      }
      // 独立通知卡（复用 task_completed 的缓冲/分发机制）
      // will_wake 不做 hold：WAKE_REMINDER_RE 不识别子 agent 唤醒轮，hold 只会拖到降级才显示
      const subagentId = typeof sf.subagent_id === 'string' ? sf.subagent_id : (childId ?? 'unknown')
      const taskId = `subagent:${subagentId}`
      const ok = status === 'completed'
      const now = Date.now()
      // description/agentType 来自 spawned 帧缓存（finished 帧不含这两个字段）
      const cachedMeta = subagentMeta.get(sessionId)?.get(subagentId)
      subagentMeta.get(sessionId)?.delete(subagentId)
      const n: PendingAgentNotification = {
        taskId,
        command: subagentId,
        ok,
        output: typeof sf.output === 'string' ? sf.output : undefined,
        receivedAt: now,
        willWake: false,
        description: cachedMeta?.description,
        agentType: cachedMeta?.agentType,
        childSessionId: childId,
        turns: typeof sf.turns === 'number' ? sf.turns : undefined,
        toolCalls: typeof sf.tool_calls === 'number' ? sf.tool_calls : undefined,
        durationMs: typeof sf.duration_ms === 'number' ? sf.duration_ms : undefined,
      }
      const saExisting = getTaskNotifRecord(sessionId, taskId)
      const saRecord: TaskNotifRecord = saExisting ? { ...saExisting, data: n } : { data: n, placement: null }
      setTaskNotifRecord(sessionId, taskId, saRecord)
      const saBusy = turn.promptInFlight || turn.assistantId != null || turn.wakeTaskId != null
      if (saBusy && !replayingSessions.has(sessionId)) {
        if (saRecord.placement === null) {
          let list = pendingTaskNotifications.get(sessionId)
          if (!list) pendingTaskNotifications.set(sessionId, (list = []))
          if (!list.includes(taskId)) list.push(taskId)
          // 缓冲中刷新会丢——先持久化（flush 时 emit 会再 upsert，同 id 幂等）
          persistTaskNotifRecord(sessionId, saRecord)
        } else {
          emitTaskNotification(sessionId, saRecord)
        }
      } else {
        emitTaskNotification(sessionId, saRecord)
      }
      break
    }
    // subagent_progress: high-frequency ticks, don't emit UI parts
    case 'subagent_progress':
      break
    // ── Compaction 通知 ────────────────────────────────────────────
    // 手动 /compact 和自动 auto-compact 共用这四个通知类型，走同一个固定
    // part id（不带时间戳）：started 先挂一个 running 态的 compaction part，
    // completed/failed/cancelled 用同一个 id 原地更新，UI 上表现为一条分隔线
    // 从"正在压缩"平滑过渡到终态，而不是先后出现两条互不相关的消息。
    case 'auto_compact_started': {
      const ac = update as Record<string, unknown>
      const pct = typeof ac.percentage === 'number' ? ac.percentage : 0
      const id = ensureAssistant(sessionId, turn)
      breakActiveParts(turn)
      emitPartUpdated(sessionId, id, { id: `${id}:compaction`, type: 'compaction', status: 'running', percentage: pct })
      break
    }
    case 'auto_compact_completed': {
      const acc = update as Record<string, unknown>
      // wire 字段是 snake_case（SessionUpdate 枚举整体 rename_all = "snake_case"
      // 只转 variant 名，struct variant 内部字段名原样透传）——历史上这里错读成
      // camelCase 的 tokensAfter，永远读不到值，UI 一直显示 0 tokens。
      const after = typeof acc.tokens_after === 'number' ? acc.tokens_after : 0
      const before = typeof acc.tokens_before === 'number' ? acc.tokens_before : undefined
      const elapsedMs = typeof acc.elapsed_ms === 'number' ? acc.elapsed_ms : undefined
      const id = ensureAssistant(sessionId, turn)
      breakActiveParts(turn)
      emitPartUpdated(sessionId, id, {
        id: `${id}:compaction`,
        type: 'compaction',
        status: 'completed',
        tokensBefore: before,
        tokensAfter: after,
        elapsedMs,
      })
      break
    }
    case 'auto_compact_failed': {
      const id = ensureAssistant(sessionId, turn)
      breakActiveParts(turn)
      emitPartUpdated(sessionId, id, { id: `${id}:compaction`, type: 'compaction', status: 'failed' })
      break
    }
    case 'auto_compact_cancelled': {
      const id = ensureAssistant(sessionId, turn)
      breakActiveParts(turn)
      emitPartUpdated(sessionId, id, { id: `${id}:compaction`, type: 'compaction', status: 'cancelled' })
      break
    }
    default:
      break
  }
}

export function handleExtNotification(method: string, params: unknown) {
  if (method === 'x.ai/models/update' && isRecord(params)) {
    _modelState = params as unknown as AcpModelState
    return
  }
  // x.ai/session_notification 携带 RetryState 等 xAI 扩展更新，结构与
  // session/update 兼容（{ sessionId, update: { sessionUpdate, ... } }），
  // 走同一个转译入口以触发 session.error / messageStore.setLoadError。
  //
  // x.ai/session/update 是同一类通知的另一个 method 名——leader/replay 路径
  // （mvp_agent/replay.rs 的 forward_raw_replay_line）固定用这个名字转发
  // updates.jsonl 里持久化的 xAI 通知（TUI 侧 acp/mod.rs::is_session_update_ext_method
  // 早就把这两个名字当同义词处理）。此前这里只认 session_notification，
  // session/load 回放期间到达的 turn_completed/response_completed 全部落进
  // default 分支的 acp:extNotification，从未经过 handleAcpSessionUpdate——
  // 页面刷新后历史消息的 token/cost 回填因此丢失，只是从未被注意到。
  if ((method === 'x.ai/session_notification' || method === 'x.ai/session/update') && isRecord(params)) {
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
  prepareTurnForPrompt(sessionId, userMessageId)

  // genuine user prompt 会让后端消费掉 deferred completion、唤醒轮不再发生——
  // hold 中的通知（等唤醒轮注入的）降级进缓冲，本回合结束后 flush 为独立卡
  demoteHeldTaskNotifications(sessionId)

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
      settlePromptTurn(sessionId)
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      // 错误路径同样复用 settle（含 wake 竞态守卫）；仅额外广播错误提示。
      settlePromptTurn(sessionId)
      // 在 UI 中显示错误消息
      import('../store/messageStore').then(({ messageStore }) => {
        messageStore.setLoadError(sessionId, { name: 'APIError', data: { message: msg, isRetryable: true, metadata: { errorType: 'prompt_failure' } } })
      })
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
  // Two envelope shapes on the wire:
  //   1. `{result: <payload>}`  — standard ext handler returns the payload directly.
  //   2. `{result: {result: <payload>}}` — handlers wrapped via
  //      `crate::extensions::to_ext_response` add an inner `result` field per
  //      the xai protocol envelope. Unwrap one extra level when present so
  //      callers always see the payload.
  if (isRecord(raw) && 'result' in raw) {
    const inner = raw.result
    if (isRecord(inner) && 'result' in inner && !('error' in inner)) return inner.result
    return inner
  }
  return raw
}

/** ACP 扩展通知（fire-and-forget，如 x.ai/yolo_mode_changed 运行时权限模式切换） */
export async function acpExtNotify(method: string, params?: unknown): Promise<void> {
  const client = await ensureAcp()
  client.extNotify(method, params ?? {})
}
