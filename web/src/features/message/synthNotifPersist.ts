/**
 * localStorage 持久化合成通知消息（msg_tasknotif_* / msg_wake_*）。
 * 后端 session/load 不重放这些异步侧信道帧，页面刷新后需从本地恢复。
 *
 * 回放消息的 id / time.created 是前端接收时现打的（不稳定），无法按时间戳
 * 排序还原——持久化时额外记录触发时刻最后一条用户消息的文本 + 它是第几条
 * 用户消息（序数），恢复时插回该轮次之后（见 messageStore.injectSynthMessages）。
 * 序数用于消除重复文本（「继续」「ok」）的歧义：回放按事件流重建用户消息，
 * 序数跨刷新稳定。
 */
import type { Message } from '../../types/message'
import { childSessionStore } from '../../store/childSessionStore'

const KEY_PREFIX = 'grok:synth_notif:'
const MAX_PER_SESSION = 50
/** 锚点文本截断上限；达到该长度说明被截断，匹配时才允许前缀匹配 */
export const ANCHOR_TEXT_LIMIT = 300

export interface SynthNotifAnchor {
  /** 通知发出时会话里最后一条用户消息的文本（截断至 ANCHOR_TEXT_LIMIT） */
  userText?: string
  /** 该用户消息是会话里第几条用户消息（1-based），用于重复文本消歧 */
  userIndex?: number
}

export interface SynthNotifEntry {
  message: Message
  anchor?: SynthNotifAnchor
}

/** 存储条目：{ m, a?, i? } 紧凑格式；早期版本直接存 Message（含 info 字段） */
type StoredEntry = { m: Message; a?: string; i?: number } | Message

function isValidEntry(raw: unknown): raw is StoredEntry {
  if (typeof raw !== 'object' || raw === null) return false
  const obj = raw as Record<string, unknown>
  const msg = 'm' in obj ? obj.m : obj
  return (
    typeof msg === 'object' && msg !== null &&
    typeof (msg as Record<string, unknown>).info === 'object' && (msg as Record<string, unknown>).info !== null
  )
}

function entryOf(raw: StoredEntry): SynthNotifEntry {
  if ('m' in raw) {
    return {
      message: raw.m,
      anchor: raw.a || raw.i !== undefined ? { userText: raw.a, userIndex: raw.i } : undefined,
    }
  }
  return { message: raw }
}

function entryId(raw: StoredEntry): string {
  return ('m' in raw ? raw.m : raw).info.id
}

/** 读取 + 过滤非法条目；解析失败返回 null（调用方自愈） */
function readEntries(key: string): StoredEntry[] | null {
  const raw = localStorage.getItem(key)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    return parsed.filter(isValidEntry)
  } catch {
    return null
  }
}

export function persistSynthMessage(sessionId: string, message: Message, anchor?: SynthNotifAnchor): void {
  try {
    const key = KEY_PREFIX + sessionId
    // 解析失败（损坏数据）→ 丢弃重建，避免该会话持久化永久静默失效
    const entries: StoredEntry[] = readEntries(key) ?? []
    const idx = entries.findIndex(e => entryId(e) === message.info.id)
    const prev = idx >= 0 ? entries[idx] : undefined
    // 重复帧重发时保留最早记录的锚点：锚点语义是「首次发出时刻的位置」，
    // 之后重算只会漂移到更晚轮次
    const prevA = prev && 'm' in prev ? prev.a : undefined
    const prevI = prev && 'm' in prev ? prev.i : undefined
    const a = prevA ?? anchor?.userText?.slice(0, ANCHOR_TEXT_LIMIT)
    const i = prevI ?? anchor?.userIndex
    const stored: StoredEntry = {
      m: message,
      ...(a ? { a } : {}),
      ...(i !== undefined ? { i } : {}),
    }
    if (idx >= 0) {
      entries[idx] = stored
    } else {
      entries.push(stored)
      if (entries.length > MAX_PER_SESSION) entries.splice(0, entries.length - MAX_PER_SESSION)
    }
    try {
      localStorage.setItem(key, JSON.stringify(entries))
    } catch {
      // quota 满：丢弃最旧一半重试一次，仍失败则放弃本条
      entries.splice(0, Math.ceil(entries.length / 2))
      localStorage.setItem(key, JSON.stringify(entries))
    }
  } catch {
    // localStorage 不可用时静默降级
  }
}

export function loadSynthMessages(sessionId: string): SynthNotifEntry[] {
  try {
    const key = KEY_PREFIX + sessionId
    const entries = readEntries(key)
    if (entries === null) {
      // 损坏数据自愈：清掉坏 key，让后续持久化恢复工作
      localStorage.removeItem(key)
      return []
    }
    return entries.map(entryOf)
  } catch {
    return []
  }
}

/**
 * 从恢复的 agent-completion 通知重建 childSessionStore 映射。
 * subagent_spawned/finished 通知不回放，刷新后子会话记录为空——SubtaskPartView
 * 的状态徽章会误显「运行中」、Enter 跳转失效。completion 通知里带
 * childSessionId + ok，足以恢复已完成子代理的状态与跳转。
 */
export function restoreChildSessions(sessionId: string, entries: SynthNotifEntry[]): void {
  for (const { message } of entries) {
    for (const part of message.parts) {
      if (part.type !== 'agent-completion' || !part.childSessionId) continue
      childSessionStore.registerSubagent({
        id: part.childSessionId,
        parentID: sessionId,
        title: part.description || part.agentType,
        agent: part.agentType,
        createdAt: part.receivedAt,
      })
      if (part.ok) {
        childSessionStore.markIdle(part.childSessionId)
      } else {
        childSessionStore.markError(part.childSessionId)
      }
    }
  }
}

let allRestored = false

/**
 * 启动预热：扫描全部会话的持久化通知，一次性重建 childSessionStore。
 * 恢复逻辑若只挂在会话加载路径，侧栏首屏（尚未打开任何会话）就没有
 * 父子关系与标题数据——子会话先平级显示「未命名对话」，等选中会话
 * 加载后才归位。App 挂载时调用一次即可（幂等）。
 */
export function restoreAllChildSessions(): void {
  if (allRestored) return
  allRestored = true
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(KEY_PREFIX)) continue
      const sessionId = key.slice(KEY_PREFIX.length)
      restoreChildSessions(sessionId, loadSynthMessages(sessionId))
    }
  } catch {
    // localStorage 不可用时静默降级
  }
}
