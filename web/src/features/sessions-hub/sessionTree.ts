// 父子会话单层嵌套：ACP roster（x.ai/sessions/list）不带 parentID 字段，父子关系
// 由调用方通过 getParentId（读 childSessionStore）解析后传入——本模块本身是纯函数，
// 不依赖 React 或任何 store，只负责把「扁平 sessions + 父子映射」整形成「顶层 + 子级」。
//
// 单层嵌套，与旧 SidePanel 的 topLevelSessions/inlineChildSessions 行为对齐：
// 只有当某个 session 的父 id 本身是顶层 session 时才会被挂到该父下面，
// 这天然排除了「子的子」——祖孙关系不会被渲染，这是旧代码本来就有的限制。

import type { ApiSession } from '../../api'

export interface SessionTreeResult {
  topLevel: ApiSession[]
  childrenByParent: Map<string, ApiSession[]>
}

export interface BuildSessionTreeOptions {
  /** 对应设置面板「始终显示子会话」开关：开=展示全部已知子会话；关=仅展示忙碌中或当前选中的子会话 */
  showAllChildren: boolean
  selectedSessionId: string | null
  busySessionIds: Set<string>
  getParentId: (sessionId: string) => string | undefined
}

export function buildSessionTree(sessions: ApiSession[], opts: BuildSessionTreeOptions): SessionTreeResult {
  const { showAllChildren, selectedSessionId, busySessionIds, getParentId } = opts

  const allIds = new Set(sessions.map(s => s.id))
  const parentIds = new Map<string, string>()
  for (const s of sessions) {
    const pid = getParentId(s.id)
    if (pid) parentIds.set(s.id, pid)
  }

  // 顶层：没有可解析的父 id，或父 id 不在当前可见集合里——父被筛掉时子会话提升为顶层
  const topLevel = sessions.filter(s => {
    const pid = parentIds.get(s.id)
    return !(pid && allIds.has(pid))
  })

  const rootIds = new Set(topLevel.map(s => s.id))
  const childrenByParent = new Map<string, ApiSession[]>()
  for (const s of sessions) {
    const pid = parentIds.get(s.id)
    if (!pid || !rootIds.has(pid)) continue // 排除"子的子"：父本身不是顶层就不挂载

    const shouldShow = showAllChildren || busySessionIds.has(s.id) || s.id === selectedSessionId
    if (!shouldShow) continue

    const list = childrenByParent.get(pid)
    if (list) list.push(s)
    else childrenByParent.set(pid, [s])
  }

  return { topLevel, childrenByParent }
}

/**
 * 子会话刚 spawn 时 roster 里的 title 经常是空的（后端还没回写）。
 * 用 childSessionStore 里 spawn 时记录的真实描述兜底；title 已有值则原样返回同一个
 * 对象引用（不产生新对象，避免无意义重渲染）。
 */
export function resolveChildTitle(session: ApiSession, childInfo: { title?: string } | undefined): ApiSession {
  if (!session.title && childInfo?.title) {
    return { ...session, title: childInfo.title }
  }
  return session
}
