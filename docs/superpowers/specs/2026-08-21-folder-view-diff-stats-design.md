# 文件夹式最近记录 + Diff 统计设计

**日期**：2026-08-21  
**状态**：已完成——全部 13 个任务落地，两阶段审查（规格符合性 + 代码质量）全部通过，前端 770 测试 / 后端全部相关测试通过，浏览器手动验证通过  
**相关分支**：`feat/sessions-hub-redesign`

---

## 概述

为 SessionHubPanel 增加两个独立的视图模式：
1. **列表视图**（已有）：按时间倒序的扁平会话列表
2. **文件夹视图**（新增）：按项目目录分组的会话列表，显示分支名、状态圆点、Git diff 统计

同时为每个会话显示代码改动统计（`+N/-N/Nf`）：
- **活跃会话**：实时查询 hunk-tracker（`isLive: true`）
- **历史会话**：显示关闭时落盘的快照（`isLive: false`，灰色提示）

---

## 设计 - 第一节：架构总览

### 核心决策

| 问题 | 最终决定 |
|------|----------|
| 视图组织 | 两套独立视图（列表 / 文件夹），顶部图标切换 |
| 视图切换 | localStorage 持久化，跨会话保持 |
| 文件夹折叠 | 默认展开当前工作目录，用户手动折叠后永久尊重 |
| Diff 历史数据 | Summary 落盘（会话关闭时捕获 hunk-tracker 统计） |
| Diff 活跃数据 | hunk-tracker 实时查询（`x.ai/hunk-tracker/get-summary`） |
| 实时查询失败 | fallback 到落盘快照，标记 `isLive: false` |
| 快照缺失 | 不显示 Diff 行 |
| 关闭落盘 | 正常关闭 + idle unload |
| Crash | 允许丢失（预期行为，不属于 bug） |
| 查询优化 | FolderView 层统一并行查询（而非每个 SessionListItem 各自查询） |
| SessionListItem | 纯展示，不负责查询 |
| Store | useSyncExternalStore + 稳定 snapshot |

### 数据流架构

```
                 ┌─ 活跃会话 ──→ hunk-tracker 实时查询
                 │
Session
                 │
                 └─ 历史会话 ──→ Summary 落盘快照
                         │
                         ↓
                    RosterEntry
                         │
                         ↓
                ┌─────────────────┐
                │ Folder View      │
                │                 │
                │ Project Group   │
                │  ├ branch       │
                │  ├ status       │
                │  └ sessions     │
                │      └ diff     │
                └─────────────────┘
```

---

## 设计 - 第二节：后端改动

### 1. 数据结构扩展

**`Summary` 结构体**（`crates/codegen/xai-grok-shell/src/session/persistence.rs:914`）新增三个可选字段：

```rust
pub struct Summary {
    // ... 现有字段 ...
    
    /// 会话期间代码增加的行数（hunk-tracker accepted + pending）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub additions: Option<usize>,
    
    /// 会话期间代码删除的行数（hunk-tracker accepted + pending）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deletions: Option<usize>,
    
    /// 会话期间修改的文件数（hunk-tracker files_modified 近似）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<usize>,
}
```

**`RosterEntry` 结构体**（`crates/codegen/xai-grok-shell/src/agent/roster.rs:55`）同步新增：

```rust
pub struct RosterEntry {
    // ... 现有字段 ...
    
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub additions: Option<usize>,
    
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deletions: Option<usize>,
    
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<usize>,
}
```

### 2. 会话关闭时捕获统计

**修改位置**：`crates/codegen/xai-grok-shell/src/session/lifecycle.rs`（`close_active_session` 或 `end_local_session` 路径）

**逻辑**：在 `drop_session` 之前调用 hunk-tracker 获取统计并写入 `Summary`

```rust
// 伪代码示意（具体实现需要看现有代码结构）
async fn close_active_session(session_id: &str, ops: &WorkspaceOps) -> Result<()> {
    // 1. 获取 session 引用（在 drop 之前）
    let session = ops.workspace_handle().session(session_id)
        .ok_or_else(|| anyhow!("session not found"))?;
    
    // 2. 捕获 hunk-tracker 统计
    let hunk_summary = session.hunk_tracker().get_session_summary().await;
    let additions = hunk_summary.stats.accepted_lines_added + hunk_summary.pending_lines_added;
    let deletions = hunk_summary.stats.accepted_lines_removed + hunk_summary.pending_lines_removed;
    let files = hunk_summary.files_modified;
    
    // 3. 更新 Summary 并保存（需要调用 Summary 的持久化方法）
    update_summary(session_id, |summary| {
        summary.additions = Some(additions);
        summary.deletions = Some(deletions);
        summary.files = Some(files);
    })?;
    
    // 4. 继续原有关闭流程（drop_session 等）
    ops.end_local_session(session_id).await?;
    Ok(())
}
```

**空闲卸载路径**：同样在 `resident registry` 的空闲卸载逻辑里加类似捕获（具体位置待确认，应该在 `agent_ops.rs` 或 `roster.rs` 的卸载函数里）

### 3. roster 接口回填

**修改位置**：`crates/codegen/xai-grok-shell/src/agent/roster.rs:109`（`merge_roster` 函数）

```rust
// 在 merge_roster 里，从 Summary 读取三个字段并填到 RosterEntry
entries.extend(by_id.into_values().map(|summary| RosterEntry {
    // ... 现有字段 ...
    additions: summary.additions,
    deletions: summary.deletions,
    files: summary.files,
    // ... 
}));
```

**向后兼容**：三个字段都是 `Option<usize>`，旧会话（没有这三个字段）反序列化时自动为 `None`，前端显示为空或 `--`

### 关键决策点

1. **统计语义**：`additions/deletions` = `accepted + pending`（不含 rejected），`files` = `files_modified`（只含 agent 归属的文件，不含纯 external）
2. **捕获时机**：正常关闭 + 空闲卸载，进程崩溃丢失
3. **数据类型**：`Option<usize>`，缺省时为 `None`（而非 `0`），前端能区分"没有数据"和"真的是 0"

---

## 设计 - 第三节：前端数据层

### 1. 类型定义扩展

**`web/src/types/api/session.ts`** 中的 `ApiSession` 接口新增三个可选字段：

```typescript
export interface ApiSession {
  // ... 现有字段 ...
  
  /** 会话期间代码增加的行数（来自 hunk-tracker 或落盘快照）*/
  additions?: number
  /** 会话期间代码删除的行数 */
  deletions?: number
  /** 会话期间修改的文件数 */
  files?: number
}
```

### 2. roster 接口映射

**`web/src/api/session.ts`** 的 `mapRosterToSession` 函数回填三个字段（保留 undefined 语义）：

```typescript
function mapRosterToSession(entry: RosterEntry): ApiSession {
  const ts = entry.lastChangeUnixMs ?? Date.now()
  return {
    id: entry.sessionId,
    directory: entry.cwd,
    title: entry.title ?? '',
    version: '',
    time: { created: ts, updated: ts },
    // 保留 undefined（不强制转 0），前端能区分"无数据"和"真的是 0"
    additions: entry.additions,
    deletions: entry.deletions,
    files: entry.files,
  } as unknown as ApiSession
}
```

### 3. 活跃会话实时查询 hook

新增 `web/src/features/sessions-hub/useSessionDiffStats.ts`：

```typescript
import { useEffect, useState } from 'react'
import { acpExtRequest } from '../../api/acpBridge'
import type { ApiSession } from '../../types/api/session'

interface SessionDiffStats {
  additions: number
  deletions: number
  files: number
  /** true = 来自实时查询；false = 来自落盘快照（可能过时）*/
  isLive: boolean
}

type QueryState = 
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: SessionDiffStats }
  | { status: 'error' }

/**
 * 对活跃会话（resident: true）实时查询 hunk-tracker 统计，
 * 历史会话返回已落盘的快照。
 * 
 * 状态流：
 * - 活跃会话：loading → success (isLive: true) | error → fallback 到快照 (isLive: false)
 * - 历史会话：直接返回快照 (isLive: false)
 */
export function useSessionDiffStats(
  session: ApiSession,
  isResident: boolean,
): SessionDiffStats | null {
  const [queryState, setQueryState] = useState<QueryState>({ status: 'idle' })

  useEffect(() => {
    // 历史会话：不查询
    if (!isResident) {
      setQueryState({ status: 'idle' })
      return
    }

    // 活跃会话：调 hunk-tracker 实时查询
    setQueryState({ status: 'loading' })
    let mounted = true
    
    // 注意：请求体字段名是 sessionId（camelCase）。后端 GetSummaryRequest
    // 带 #[serde(rename_all = "camelCase")]，传 session_id 会被当未知字段
    // 忽略、静默变成 None，请求必然失败但不报错——之前的实现踩过这个坑。
    acpExtRequest('x.ai/hunk-tracker/get-summary', { sessionId: session.id })
      .then((resp: any) => {
        if (!mounted) return
        const summary = resp // SessionSummaryWire
        const additions = 
          (summary.stats?.acceptedLinesAdded ?? 0) + (summary.pendingLinesAdded ?? 0)
        const deletions = 
          (summary.stats?.acceptedLinesRemoved ?? 0) + (summary.pendingLinesRemoved ?? 0)
        const files = summary.filesModified ?? 0
        setQueryState({ 
          status: 'success', 
          data: { additions, deletions, files, isLive: true }
        })
      })
      .catch(() => {
        if (!mounted) return
        // 查询失败，标记为 error，让下面 fallback 到快照
        setQueryState({ status: 'error' })
      })

    return () => {
      mounted = false
    }
  }, [session.id, isResident])

  // 返回逻辑：优先实时查询，失败或非活跃时回退到快照
  if (queryState.status === 'success') {
    return queryState.data
  }

  // Fallback：活跃会话查询失败，或历史会话，使用落盘快照
  if (session.additions != null || session.deletions != null || session.files != null) {
    return {
      additions: session.additions ?? 0,
      deletions: session.deletions ?? 0,
      files: session.files ?? 0,
      isLive: false, // 快照，不是实时数据
    }
  }

  return null // 无数据
}
```

### 4. 视图切换状态管理

**新增 `web/src/store/sessionHubViewStore.ts`**：

```typescript
export type SessionHubViewMode = 'list' | 'folder'

const STORAGE_KEY = 'sessionHubViewMode'
const EXPANDED_PROJECTS_KEY = 'sessionHubExpandedProjects'
const MANUALLY_TOUCHED_KEY = 'sessionHubManuallyTouched'

class SessionHubViewStore {
  private _viewMode: SessionHubViewMode = 'list'
  private _expandedProjects: Set<string> = new Set()
  private _manuallyTouched: Set<string> = new Set()
  private _snapshot = this.createSnapshot()
  private listeners = new Set<() => void>()

  constructor() {
    // 从 localStorage 恢复
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'folder') this._viewMode = 'folder'
    
    try {
      const expandedJson = localStorage.getItem(EXPANDED_PROJECTS_KEY)
      if (expandedJson) {
        this._expandedProjects = new Set(JSON.parse(expandedJson))
      }
      
      const touchedJson = localStorage.getItem(MANUALLY_TOUCHED_KEY)
      if (touchedJson) {
        this._manuallyTouched = new Set(JSON.parse(touchedJson))
      }
    } catch {}
    
    this._snapshot = this.createSnapshot()
  }

  get viewMode() {
    return this._viewMode
  }

  setViewMode(mode: SessionHubViewMode) {
    this._viewMode = mode
    localStorage.setItem(STORAGE_KEY, mode)
    this._snapshot = this.createSnapshot()
    this.notify()
  }

  toggleViewMode() {
    this.setViewMode(this._viewMode === 'list' ? 'folder' : 'list')
  }

  /**
   * 用户点击展开/折叠项目
   */
  toggleProject(projectId: string) {
    // 标记为"用户手动操作过"
    this._manuallyTouched.add(projectId)
    this.saveManuallyTouched()
    
    // 切换展开状态
    if (this._expandedProjects.has(projectId)) {
      this._expandedProjects.delete(projectId)
    } else {
      this._expandedProjects.add(projectId)
    }
    this.saveExpandedProjects()
    this._snapshot = this.createSnapshot()
    this.notify()
  }

  /**
   * 首次默认展开当前工作目录——仅在用户未手动操作过该项目时生效
   */
  ensureDefaultExpanded(projectId: string) {
    // 如果用户手动操作过，不覆盖用户意图
    if (this._manuallyTouched.has(projectId)) return
    
    // 如果还没展开，默认展开
    if (!this._expandedProjects.has(projectId)) {
      this._expandedProjects.add(projectId)
      this.saveExpandedProjects()
      this._snapshot = this.createSnapshot()
      this.notify()
    }
  }

  private saveExpandedProjects() {
    localStorage.setItem(
      EXPANDED_PROJECTS_KEY,
      JSON.stringify([...this._expandedProjects]),
    )
  }

  private saveManuallyTouched() {
    localStorage.setItem(
      MANUALLY_TOUCHED_KEY,
      JSON.stringify([...this._manuallyTouched]),
    )
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private notify() {
    this.listeners.forEach(fn => fn())
  }

  // 使用稳定 snapshot，避免每次返回新对象
  private createSnapshot() {
    return {
      viewMode: this._viewMode,
      expandedProjects: new Set(this._expandedProjects),
    }
  }

  getSnapshot = () => this._snapshot
}

export const sessionHubViewStore = new SessionHubViewStore()
```

### 关键修改说明

1. **活跃实时查询失败 fallback**：
   - 明确区分三种状态：`loading` / `success` / `error`
   - 查询成功返回 `isLive: true`
   - 查询失败或历史会话 fallback 到 `session.additions/deletions/files`，返回 `isLive: false`

2. **不强制 undefined → 0**：
   - `mapRosterToSession` 保留 `undefined`
   - hook 里的 fallback 逻辑：只有当至少有一个字段存在时才返回对象，否则返回 `null`

3. **getSnapshot 稳定性**：
   - `_snapshot` 在状态变更时更新，`getSnapshot()` 返回同一个引用
   - `createSnapshot()` 返回浅拷贝的 `Set`，防止外部修改

4. **不暴露可变 Set**：
   - 移除了 `expandedProjects` getter
   - 组件统一通过 `useSyncExternalStore(sessionHubViewStore.subscribe, sessionHubViewStore.getSnapshot)` 读取

5. **ensureDefaultExpanded 语义收窄**：
   - Store 内部维护 `_manuallyTouched: Set<string>`
   - `toggleProject` 会自动把项目加入 `_manuallyTouched`
   - `ensureDefaultExpanded` 内部判断：如果用户手动操作过，什么都不做

---

## 设计 - 第四节：前端 UI 层

### 1. 组件结构总览

```
SessionHubPanel (已有，顶层容器)
├─ ViewToggleButton (新增：视图切换按钮)
├─ SessionHubListView (已有：扁平列表视图)
└─ SessionHubFolderView (新增：文件夹分组视图)
    ├─ ProjectGroup (新增：单个项目分组)
    │   ├─ ProjectGroupHeader (新增：项目头部)
    │   │   ├─ 项目名 + 分支名 (useVcsInfo)
    │   │   ├─ 状态圆点 (useBusySessions + useNotifications)
    │   │   └─ 折叠图标
    │   └─ SessionList (复用已有的会话列表逻辑)
    │       └─ SessionListItem (修改：增加 diff 统计显示)
    └─ (重复 ProjectGroup，每个项目一个)
```

### 2. 组件职责划分

**SessionHubPanel**（已有，需小幅修改）：
- 读取 `sessionHubViewStore.getSnapshot()` 判断当前视图模式
- 根据 `viewMode` 渲染 `SessionHubListView` 或 `SessionHubFolderView`
- 顶部添加 `ViewToggleButton`

**ViewToggleButton**（新增）：
- 显示当前视图模式的图标（列表图标 / 文件夹图标）
- 点击调用 `sessionHubViewStore.toggleViewMode()`
- 用 `useSyncExternalStore` 订阅 store 更新图标状态

**SessionHubFolderView**（新增，核心组件）：
- 接收 `sessions: ApiSession[]`（从 SessionContext 获取）
- 按 `session.directory` 分组，按每个项目下最近活跃会话的时间排序
- 组内会话按时间倒序排列（最新会话在顶部）
- 读取 `sessionHubViewStore.getSnapshot().expandedProjects` 判断哪些项目展开
- 首次渲染时调用 `ensureDefaultExpanded(currentDirectory)`（只执行一次，且仅在 `currentDirectory` 加载完成后）
- 渲染每个分组为 `ProjectGroup`

**ProjectGroup**（新增）：
- 接收 `projectId: string`（即 `directory`）、`sessions: ApiSession[]`、`isExpanded: boolean`、`diffStatsMap: Map<string, SessionDiffStats | null>`
- 渲染 `ProjectGroupHeader` + 条件渲染会话列表
- 点击头部调用 `sessionHubViewStore.toggleProject(projectId)`

**ProjectGroupHeader**（新增）：
- 显示项目名（从 `directory` 提取最后一段路径，或用 `getDirectoryName` 工具函数）
- 调用 `useVcsInfo(directory)` 获取分支名，显示在项目名旁边（格式：`项目名 · 分支名`）
- 调用自定义 hook `useProjectStatus(directory, sessions)` 获取状态圆点（忙碌/等待权限/已完成）
- 显示折叠图标（展开时向下箭头，折叠时向右箭头）

**SessionListItem**（已有，需修改）：
- 新增 `diffStats?: SessionDiffStats | null` prop（从父组件传入）
- 在现有的标题/时间行下方，增加一行显示 diff 统计：
  - 格式：`+N  -N  Nf`（绿色/红色/灰色，等宽字体）
  - 如果 `diffStats.isLive === false`，整行用灰色 + 可选的虚线边框提示"数据可能过时"
  - 如果 `diffStats === null`，不显示这一行

### 3. 数据流与性能优化

**关键问题**：活跃会话需要实时查询 hunk-tracker，避免每个 `SessionListItem` 各自查询造成性能问题。

**优化策略**：

1. **在 `SessionHubFolderView` 层并行查询活跃会话**（而非在每个 `SessionListItem` 里各自查询）：

```typescript
// 伪代码示意
function SessionHubFolderView({ sessions }: { sessions: ApiSession[] }) {
  const roster = useRoster() // 从 SessionContext 获取 roster 信息
  
  const residentSessionIds = useMemo(
    () => roster.filter(r => r.resident).map(r => r.sessionId),
    [roster]
  )
  
  // 并行查询活跃会话的 diff 统计
  // 注意：这不是真正的"batch API"，而是并行发起多个单会话请求
  const diffStatsMap = useResidentSessionDiffStats(residentSessionIds, sessions)
  
  // 按 directory 分组，并按最近活跃时间排序
  const grouped = useMemo(() => {
    const groups = groupBy(sessions, s => s.directory)
    return sortGroupsByRecentActivity(groups)
  }, [sessions])
  
  // ... 渲染逻辑，把 diffStatsMap 传给子组件
}
```

2. **`useResidentSessionDiffStats` hook**（新增，命名明确表示"并行查询多个活跃会话"）：

```typescript
/**
 * 并行查询多个活跃会话的 diff 统计（不是真正的 batch API）。
 * 
 * 注意：这不是后端的 batch-summary 接口，而是前端并行发起多个
 * x.ai/hunk-tracker/get-summary 请求。每个会话一个独立请求。
 * 
 * 状态流：
 * - 进入文件夹视图时触发一次查询
 * - resident session 列表变化时重新查询
 * - 暂不实现自动轮询刷新（等实际需求再加）
 */
function useResidentSessionDiffStats(
  residentIds: string[],
  sessions: ApiSession[]
): Map<string, SessionDiffStats> {
  const [statsMap, setStatsMap] = useState<Map<string, SessionDiffStats>>(new Map())

  // sessions 数组几乎每次 roster 刷新都会换新引用（即使内容不变）。
  // 用 ref 存最新快照，effect 内部读取、不放进依赖数组——一个 useMemo(
  // [sessions]) 包出来的 Map 不解决任何问题：sessions 引用一变，这个
  // useMemo 照样重算出新引用，依赖它的 effect 照样重跑。真正需要稳定
  // 的是 effect 的触发条件，不是"传给 effect 的数据"。
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions

  // residentIds 数组引用同样会抖动，用逗号拼接成字符串才能让
  // useEffect 的依赖比较落在"内容相同"上（P0：sessions/residentIds
  // 引用变化但内容相同时不应重复查询）。
  const residentIdsKey = residentIds.join(',')

  useEffect(() => {
    const ids = residentIdsKey ? residentIdsKey.split(',') : []

    if (ids.length === 0) {
      setStatsMap(prev => (prev.size === 0 ? prev : new Map()))
      return
    }

    let cancelled = false

    // 并行查询所有活跃会话（每个会话一个独立请求）
    // 注意：字段名是 sessionId（camelCase），后端 GetSummaryRequest 带
    // #[serde(rename_all = "camelCase")]，传 session_id 会被当未知字段
    // 忽略、静默变 None，查询必然失败但不报错。
    const promises = ids.map(id =>
      acpExtRequest('x.ai/hunk-tracker/get-summary', { sessionId: id })
        .then(resp => ({ id, data: parseSessionSummary(resp), success: true }))
        .catch(() => ({ id, data: null, success: false }))
    )
    
    Promise.all(promises).then(results => {
      if (cancelled) return

      const sessionById = new Map(sessionsRef.current.map(s => [s.id, s]))
      const map = new Map<string, SessionDiffStats>()
      
      results.forEach(({ id, data, success }) => {
        const session = sessionById.get(id)
        if (!session) return
        
        if (success && data) {
          map.set(id, { ...data, isLive: true })
        } else {
          // 查询失败，回退到落盘快照，标记为 stale（isLive: false）
          if (session.additions != null || session.deletions != null || session.files != null) {
            map.set(id, {
              additions: session.additions ?? 0,
              deletions: session.deletions ?? 0,
              files: session.files ?? 0,
              isLive: false,
            })
          } else {
            // Map 中没有数据时，不放这个 key（返回 undefined）
            // UI 层统一转换：const diffStats = diffStatsMap.get(session.id) ?? null
          }
        }
      })
      
      setStatsMap(map)
    })

    return () => {
      cancelled = true
    }
  }, [residentIdsKey])
  
  return statsMap
}
```

3. **`SessionListItem` 只消费已经准备好的数据**：

```typescript
<SessionListItem
  session={session}
  diffStats={diffStatsMap.get(session.id) ?? null}
  // ... 其它 props
/>
```

**优点**：
- 所有活跃会话的查询并行发起，而非逐个串行
- 只在 `SessionHubFolderView` 层查询一次，避免重复
- `SessionListItem` 保持纯展示组件，不处理异步逻辑
- 依赖 `sessionById` Map 而非 `sessions` 数组，避免引用变化导致重复查询

**刷新策略**：
- 进入文件夹视图时查询一次
- resident session 列表变化时重新查询
- 暂不实现自动轮询刷新（等实际需求明确后再加，避免过度设计）

### 4. 状态圆点逻辑

**`useProjectStatus` hook**（新增）：

```typescript
function useProjectStatus(
  directory: string,
  sessions: ApiSession[]
): { dot: string; label: string; pulse: boolean } | null {
  const busySessions = useBusySessions()
  const notifications = useNotifications()
  
  return useMemo(() => {
    // 使用项目已有的路径规范化/比较函数（不在此 feature 里自己造）
    const dirBusy = busySessions.filter(b => 
      isSameDirectory(b.directory, directory) // 复用项目现有的 directory 比较逻辑
    )
    
    if (dirBusy.length > 0) {
      // 优先级：权限 > 问题 > 重试 > 工作中
      const hasPermission = dirBusy.some(b => b.pendingAction?.type === 'permission')
      const hasQuestion = dirBusy.some(b => b.pendingAction?.type === 'question')
      const hasRetry = dirBusy.some(b => b.status.type === 'retry')
      
      if (hasPermission) {
        return { dot: 'bg-warning-100', label: '等待权限', pulse: false }
      }
      if (hasQuestion) {
        return { dot: 'bg-info-100', label: '等待回答', pulse: false }
      }
      if (hasRetry) {
        return { dot: 'bg-warning-100', label: '重试中', pulse: false }
      }
      return { dot: 'bg-success-100', label: '工作中', pulse: true }
    }
    
    // 没有 busy 状态时，检查是否有未读完成通知
    const hasUnreadCompleted = notifications.some(n =>
      n.type === 'completed' &&
      !n.read &&
      isSameDirectory(n.directory, directory)
    )
    
    if (hasUnreadCompleted) {
      return { dot: 'bg-accent-main-100', label: '已完成', pulse: false }
    }
    
    return null
  }, [directory, busySessions, notifications])
}
```

### 5. 首次默认展开逻辑（修复版）

**在 `SessionHubFolderView` 的 `useEffect` 里执行一次**：

```typescript
function SessionHubFolderView({ sessions }: { sessions: ApiSession[] }) {
  const { currentDirectory } = useDirectory()
  const viewStore = sessionHubViewStore
  const hasCalledEnsureDefault = useRef(false)
  
  useEffect(() => {
    // 只有真正拿到 currentDirectory 后，才执行默认展开并设置 ref
    if (!currentDirectory) return
    if (hasCalledEnsureDefault.current) return
    
    hasCalledEnsureDefault.current = true
    viewStore.ensureDefaultExpanded(currentDirectory)
  }, [currentDirectory, viewStore])
  
  // ... 渲染逻辑
}
```

### 6. 项目分组排序逻辑

**按每个项目下最近活跃会话的时间排序**：

```typescript
function sortGroupsByRecentActivity(
  groups: Map<string, ApiSession[]>
): Array<[string, ApiSession[]]> {
  return Array.from(groups.entries())
    .map(([directory, sessions]) => {
      // 每组内已按时间倒序（最新会话在前）
      const sortedSessions = sessions.sort((a, b) => 
        b.time.updated - a.time.updated
      )
      // 组的排序依据：该组最新会话的时间
      const mostRecentTime = sortedSessions[0]?.time.updated ?? 0
      return [directory, sortedSessions, mostRecentTime] as const
    })
    .sort((a, b) => b[2] - a[2]) // 按最新会话时间倒序
    .map(([directory, sessions]) => [directory, sessions])
}
```

### 关键修改说明

1. **"batch query" 改称"并行查询多个活跃会话"**：
   - Hook 命名从 `useSessionDiffStatsBatch` 改为 `useResidentSessionDiffStats`
   - 注释明确说明：这不是后端的 batch API，而是前端并行发起多个 `get-summary` 请求

2. **查询不因普通 render 重复触发**：
   - **修正**：早期版本设想"依赖 `sessionById`（基于 `sessions` 的 `useMemo`）能避免重复查询"，经审查证实不成立——`useMemo([sessions])` 在 `sessions` 换新引用时同样会重新计算，产出新的 `Map` 引用，依赖它的 effect 照样重跑。真正生效的做法：用 `sessionsRef`（`useRef`）存最新快照并在 effect 内部读取（不放进依赖数组），`useEffect` 的依赖改为 `residentIds.join(',')` 这种按内容比较的字符串，而不是数组本身
   - 只在 `residentIds` 的**内容**变化时触发查询（引用变化但内容相同不触发）

3. **刷新策略明确**：
   - 进入文件夹视图时查询一次
   - resident session 列表变化时重新查询
   - 暂不实现自动轮询（等实际需求再加）

4. **默认展开修复**：
   - `hasCalledEnsureDefault.current = true` 放在 `if (!currentDirectory) return` 之后
   - 只有真正拿到 `currentDirectory` 后才执行并设置 ref

5. **项目组排序规则明确**：
   - 按该项目下最近活跃会话的时间排序
   - 组内会话按时间倒序排列

6. **统一使用已有 directory normalization**：
   - `isSameDirectory` 复用项目现有的路径比较逻辑，不自己造

7. **`useVcsInfo` 缓存确认**：
   - 假设现有 `useVcsInfo` 已有缓存/共享查询机制
   - 如果后续发现性能问题，再考虑优化

---

## 设计 - 第五节：测试策略

### 1. 后端测试范围

**单元测试**（Rust）：

**`Summary` 结构体序列化/反序列化**：
- 测试新增的三个可选字段（`additions` / `deletions` / `files`）的序列化/反序列化
- 验证向后兼容性：旧的 JSON（不含这三个字段）能正常反序列化为 `None`
- 验证 `skip_serializing_if = "Option::is_none"` 生效（字段为 `None` 时不出现在 JSON 里）

**hunk-tracker 捕获逻辑**：
- 模拟会话关闭场景，验证能正确调用 `session.hunk_tracker().get_session_summary()`
- 验证统计计算逻辑：`additions = accepted + pending`，`deletions = accepted + pending`，`files = files_modified`
- 验证空闲卸载路径同样触发捕获

**`RosterEntry` 映射**：
- 验证 `merge_roster` 正确从 `Summary` 读取三个字段并填到 `RosterEntry`
- 验证缺省时返回 `None`（而非 panic 或空字符串）

**集成测试**（Rust）：

**会话关闭 → 落盘 → roster 查询**（端到端）：
- 创建会话 → 模拟代码改动（触发 hunk-tracker 记录）→ 关闭会话 → 查询 roster
- 验证返回的 `RosterEntry` 包含正确的 `additions` / `deletions` / `files`
- 验证进程重启后，落盘的统计仍能从 roster 读到

**活跃会话实时查询**：
- 对一个 resident 会话调用 `x.ai/hunk-tracker/get-summary`
- 验证返回的 `SessionSummaryWire` 结构正确
- 验证对不存在的会话返回 `SessionNotFound` 错误

### 2. 前端测试范围

**单元测试**（Jest + React Testing Library）：

**`sessionHubViewStore` 状态管理**：
```typescript
describe('sessionHubViewStore', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  test('默认视图模式为 list', () => {
    const snapshot = sessionHubViewStore.getSnapshot()
    expect(snapshot.viewMode).toBe('list')
  })

  test('切换视图模式并持久化到 localStorage', () => {
    sessionHubViewStore.toggleViewMode()
    expect(sessionHubViewStore.getSnapshot().viewMode).toBe('folder')
    expect(localStorage.getItem('sessionHubViewMode')).toBe('folder')
  })

  test('toggleProject 标记为 manuallyTouched', () => {
    sessionHubViewStore.toggleProject('project-a')
    expect(sessionHubViewStore.getSnapshot().expandedProjects.has('project-a')).toBe(true)
    
    // 验证 manuallyTouched：用户手动折叠后，ensureDefaultExpanded 不再生效
    sessionHubViewStore.toggleProject('project-a') // 用户折叠
    sessionHubViewStore.ensureDefaultExpanded('project-a') // 系统尝试默认展开
    expect(sessionHubViewStore.getSnapshot().expandedProjects.has('project-a')).toBe(false)
  })

  test('getSnapshot 返回稳定引用', () => {
    const snapshot1 = sessionHubViewStore.getSnapshot()
    const snapshot2 = sessionHubViewStore.getSnapshot()
    expect(snapshot1).toBe(snapshot2) // 引用相等
    
    sessionHubViewStore.toggleViewMode()
    const snapshot3 = sessionHubViewStore.getSnapshot()
    expect(snapshot1).not.toBe(snapshot3) // 状态变更后引用不同
  })
})
```

**`useResidentSessionDiffStats` hook**（并行查询多个活跃会话）：
```typescript
describe('useResidentSessionDiffStats', () => {
  test('活跃会话查询成功返回 isLive: true', async () => {
    const mockSessions = [{ id: 's1', additions: 10, deletions: 5, files: 2 }]
    mockAcpExtRequest.mockResolvedValue({
      stats: { acceptedLinesAdded: 20, acceptedLinesRemoved: 10 },
      pendingLinesAdded: 5,
      pendingLinesRemoved: 3,
      filesModified: 3,
    })
    
    const { result, waitForNextUpdate } = renderHook(() =>
      useResidentSessionDiffStats(['s1'], mockSessions)
    )
    
    await waitForNextUpdate()
    
    const stats = result.current.get('s1')
    expect(stats).toEqual({
      additions: 25, // 20 + 5
      deletions: 13,  // 10 + 3
      files: 3,
      isLive: true,
    })
  })

  test('查询失败回退到落盘快照并标记 isLive: false', async () => {
    const mockSessions = [{ id: 's1', additions: 10, deletions: 5, files: 2 }]
    mockAcpExtRequest.mockRejectedValue(new Error('查询失败'))
    
    const { result, waitForNextUpdate } = renderHook(() =>
      useResidentSessionDiffStats(['s1'], mockSessions)
    )
    
    await waitForNextUpdate()
    
    const stats = result.current.get('s1')
    expect(stats).toEqual({
      additions: 10,
      deletions: 5,
      files: 2,
      isLive: false, // 标记为 stale
    })
  })

  test('无落盘数据时 Map 不包含该 session（返回 undefined）', async () => {
    const mockSessions = [{ id: 's1' }] // 无 additions/deletions/files
    
    const { result } = renderHook(() =>
      useResidentSessionDiffStats([], mockSessions)
    )
    
    // null/undefined 语义统一：Map 中没有数据时，不放这个 key
    expect(result.current.has('s1')).toBe(false)
    expect(result.current.get('s1')).toBeUndefined()
  })

  test('sessions 引用变化但内容相同时不重复查询（性能优化验证）', async () => {
    // 注意：residentIds 和 sessions 都各自换新数组引用，但内容相同——
    // 早期设计误以为 useMemo([sessions]) 能吸收这种抖动，实测不成立。
    // 真正生效的是 hook 内部把 residentIds 拼成字符串做依赖比较。
    const mockSessions1 = [{ id: 's1', additions: 10 }]
    const mockSessions2 = [{ id: 's1', additions: 10 }] // 内容相同，引用不同
    const residentIds1 = ['s1']
    const residentIds2 = ['s1'] // 内容相同，引用不同
    
    mockAcpExtRequest.mockResolvedValue({
      stats: { acceptedLinesAdded: 10, acceptedLinesRemoved: 0 },
      pendingLinesAdded: 0,
      pendingLinesRemoved: 0,
      filesModified: 1,
    })
    
    const { rerender } = renderHook(
      ({ residentIds, sessions }) => useResidentSessionDiffStats(residentIds, sessions),
      { initialProps: { residentIds: residentIds1, sessions: mockSessions1 } }
    )
    
    await waitFor(() => expect(mockAcpExtRequest).toHaveBeenCalledTimes(1))
    
    rerender({ residentIds: residentIds2, sessions: mockSessions2 })
    
    // residentIdsKey（join(',') 后的字符串）内容相同，effect 不重跑
    expect(mockAcpExtRequest).toHaveBeenCalledTimes(1)
  })

  test('部分查询失败不影响其它会话（P0 关键测试）', async () => {
    const mockSessions = [
      { id: 's1', additions: 10, deletions: 5, files: 2 },
      { id: 's2', additions: 20, deletions: 10, files: 3 },
      { id: 's3', additions: 30, deletions: 15, files: 4 },
    ]
    
    // s1 成功，s2 失败，s3 成功
    mockAcpExtRequest
      .mockResolvedValueOnce({ // s1
        stats: { acceptedLinesAdded: 12, acceptedLinesRemoved: 6 },
        pendingLinesAdded: 0,
        pendingLinesRemoved: 0,
        filesModified: 2,
      })
      .mockRejectedValueOnce(new Error('s2 查询失败')) // s2
      .mockResolvedValueOnce({ // s3
        stats: { acceptedLinesAdded: 35, acceptedLinesRemoved: 18 },
        pendingLinesAdded: 0,
        pendingLinesRemoved: 0,
        filesModified: 5,
      })
    
    const { result, waitForNextUpdate } = renderHook(() =>
      useResidentSessionDiffStats(['s1', 's2', 's3'], mockSessions)
    )
    
    await waitForNextUpdate()
    
    // s1: 实时查询成功
    expect(result.current.get('s1')).toEqual({
      additions: 12,
      deletions: 6,
      files: 2,
      isLive: true,
    })
    
    // s2: 查询失败，回退到落盘快照
    expect(result.current.get('s2')).toEqual({
      additions: 20,
      deletions: 10,
      files: 3,
      isLive: false,
    })
    
    // s3: 实时查询成功
    expect(result.current.get('s3')).toEqual({
      additions: 35,
      deletions: 18,
      files: 5,
      isLive: true,
    })
  })
})
```

**`SessionListItem` diff 统计显示**：
```typescript
describe('SessionListItem diff stats', () => {
  test('显示实时统计（isLive: true）', () => {
    const diffStats = { additions: 10, deletions: 5, files: 2, isLive: true }
    const { getByText } = render(
      <SessionListItem session={mockSession} diffStats={diffStats} />
    )
    
    expect(getByText('+10')).toBeInTheDocument()
    expect(getByText('-5')).toBeInTheDocument()
    expect(getByText('2f')).toBeInTheDocument()
    // 验证没有 stale 提示样式
  })

  test('显示落盘快照并用灰色提示（isLive: false）', () => {
    const diffStats = { additions: 10, deletions: 5, files: 2, isLive: false }
    const { container, getByText } = render(
      <SessionListItem session={mockSession} diffStats={diffStats} />
    )
    
    expect(getByText('+10')).toBeInTheDocument()
    // 验证有灰色样式
    const diffLine = container.querySelector('[data-testid="diff-stats"]')
    expect(diffLine).toHaveClass('text-muted')
  })

  test('无统计数据时不显示 diff 行（UI 层 null 转换）', () => {
    // UI 层：const diffStats = diffStatsMap.get(session.id) ?? null
    const { container } = render(
      <SessionListItem session={mockSession} diffStats={null} />
    )
    
    expect(container.querySelector('[data-testid="diff-stats"]')).toBeNull()
  })
})
```

**`ProjectGroupHeader` 状态圆点**：
```typescript
describe('ProjectGroupHeader status dot', () => {
  test('显示权限等待状态（最高优先级）', () => {
    const mockBusySessions = [
      { directory: '/project-a', pendingAction: { type: 'permission' } }
    ]
    mockUseBusySessions.mockReturnValue(mockBusySessions)
    
    const { getByText } = render(
      <ProjectGroupHeader directory="/project-a" sessions={[]} />
    )
    
    expect(getByText('等待权限')).toBeInTheDocument()
  })

  test('无 busy 状态时显示已完成通知', () => {
    mockUseBusySessions.mockReturnValue([])
    const mockNotifications = [
      { type: 'completed', directory: '/project-a', read: false }
    ]
    mockUseNotifications.mockReturnValue(mockNotifications)
    
    const { getByText } = render(
      <ProjectGroupHeader directory="/project-a" sessions={[]} />
    )
    
    expect(getByText('已完成')).toBeInTheDocument()
  })

  test('无状态时不显示圆点', () => {
    mockUseBusySessions.mockReturnValue([])
    mockUseNotifications.mockReturnValue([])
    
    const { container } = render(
      <ProjectGroupHeader directory="/project-a" sessions={[]} />
    )
    
    expect(container.querySelector('[data-testid="status-dot"]')).toBeNull()
  })
})
```

**集成测试**（Playwright / Cypress）：

**文件夹视图完整流程**：
1. 打开侧栏，点击视图切换按钮，验证切换到文件夹视图
2. 验证项目按最近活跃时间排序
3. 验证当前工作目录的项目默认展开
4. 点击项目头部折叠/展开，验证状态持久化到 localStorage
5. 验证活跃会话显示实时 diff 统计（`isLive: true`）
6. 验证历史会话显示落盘快照（`isLive: false`，灰色样式）
7. 验证状态圆点显示正确（权限 > 问题 > 重试 > 工作中 > 已完成）

### 3. 手动验证清单

**后端验证**：
- [ ] 创建会话 → 修改文件 → 关闭会话 → 重启进程 → 查询 roster，验证统计仍在
- [ ] 对活跃会话调用 `x.ai/hunk-tracker/get-summary`，验证返回实时统计
- [ ] 对已关闭会话调用 `x.ai/hunk-tracker/get-summary`，验证返回 `SessionNotFound`

**前端验证**：
- [ ] 切换到文件夹视图，验证 UI 正确渲染（分组 + 分支名 + 状态圆点）
- [ ] 刷新页面，验证视图模式和折叠状态从 localStorage 恢复
- [ ] 手动折叠一个项目，关闭侧栏再打开，验证仍保持折叠状态
- [ ] 对活跃会话，验证 diff 统计显示为实时数据（绿色/红色，无灰色提示）
- [ ] 对历史会话，验证 diff 统计显示为落盘快照（灰色提示"数据可能过时"）
- [ ] 验证状态圆点优先级：创建一个等待权限的会话，验证圆点显示"等待权限"而非"工作中"

### 4. 回归测试

**确保不影响现有功能**：
- [ ] 扁平列表视图仍正常工作（不显示 diff 统计，只有基本信息）
- [ ] 新建会话对话框功能不受影响
- [ ] 会话删除/选择/切换功能不受影响
- [ ] 子会话树状嵌套显示不受影响

### 5. 性能验证

**并行查询性能**：
- 模拟 10 个活跃会话，验证并行查询的总耗时（应接近单次查询时间，而非 10 倍）
- 验证查询失败不阻塞其它会话（部分成功、部分失败场景）—— **已提升到 P0 单元测试**

**渲染性能**：
- 模拟 50 个会话分布在 10 个项目，验证文件夹视图渲染时间（应 < 500ms）
- 验证折叠/展开动画流畅（60fps）

### 关键测试优先级

**P0（阻塞发布）**：
1. 后端会话关闭 → 落盘 → roster 查询端到端测试
2. 前端 `sessionHubViewStore` 状态管理测试
3. 前端 `useResidentSessionDiffStats` 并行查询测试（**包含以下关键场景**）：
   - residentIds 内容不变时不重复查询（`residentIdsKey` 字符串比较，而非 `sessionById` useMemo——后者已证实无效）
   - **部分查询失败不影响其它会话**（s1 成功 + s2 失败 + s3 成功 → 三个会话都有结果）
4. 集成测试：文件夹视图完整流程

**P1（发布前完成）**：
5. `SessionListItem` diff 统计显示测试
6. `ProjectGroupHeader` 状态圆点测试
7. 手动验证清单全部完成
8. 回归测试全部通过

**P2（后续迭代）**：
9. 性能验证（大数据量场景，50+ 会话）
10. **边界情况测试**：
   - 网络异常（请求超时、断网重连）
   - **进程崩溃后统计丢失**（这是预期行为，不属于 bug）—— 建议文档化而非作为阻塞测试

### 关键修改说明

**① null/undefined 语义统一**：
- `Map.get('s1')` 返回 `undefined` 表示"没有这个 session 的数据"
- UI 层统一转换：`const diffStats = diffStatsMap.get(session.id) ?? null`
- `SessionListItem` 接收 `null` 时不显示 diff 行

**② 内容稳定的依赖比较**（P0 测试，实施后修订）：
- 测试验证：`residentIds`/`sessions` 引用变化但内容相同时，不重复查询
- **原方案已证实无效**：`useMemo(() => new Map(...), [sessions])` 无法吸收 `sessions` 的引用抖动——`sessions` 一换新引用，`useMemo` 照样重算出新 `Map` 引用，依赖它的 `useEffect` 照样重跑
- **实际实现**：`useEffect` 依赖改为 `residentIds.join(',')`（按内容比较的字符串）；`sessions` 快照通过 `useRef` 存储、在 effect 内部读取、不放进依赖数组

**③ 部分查询失败提升到 P0**：
- 测试场景：s1 成功、s2 失败、s3 成功 → 三个会话都有结果
- 保护实现：`Promise.all` + 单个请求 `.catch()` 确保一个失败不影响其它

**④ 进程崩溃丢数据是预期行为**（P2，不阻塞发布）：
- 产品决策：正常关闭 + idle unload 落盘，进程崩溃允许丢失
- 测试策略：文档化为预期行为，而非作为需要修复的 bug

---

## 实施计划

设计文档已完成并通过审查，现在开始实施。实施顺序遵循自底向上原则：后端 → 前端数据层 → 前端 UI 层 → 测试。

**后续步骤**：
1. 后端改动（Rust）
2. 前端数据层（TypeScript）
3. 前端 UI 层（React 组件）
4. 测试（单元测试 + 集成测试）
5. 手动验证
6. 文档更新（CLAUDE.md）

---

## 实施修订记录

### 2026-08-21：resident 数据源 + 两处规格审查问题修正

**resident 判断数据源**（实施 SessionHubFolderView 时发现的设计缺口）：
设计文档原文未明确"活跃会话"（resident）的判断依据。实施时发现后端
`RosterEntry`（`crates/codegen/xai-grok-shell/src/agent/roster.rs:76-77`）
已有 `resident: bool` 字段（语义：进程内是否仍有 actor 驱动该会话，不论
busy/idle），只是前端映射层未接。修正：
- `web/src/api/session.ts` 的本地 `RosterEntry` 接口 + `mapRosterToSession`
  补上 `resident` 字段回填
- `web/src/types/api/session.ts` 新增 `SessionLocalExtensions` 接口
  （`additions`/`deletions`/`files`/`resident`），`Session = SDKSession &
  SessionLocalExtensions`，让这些字段有真正的类型定义（此前只是运行时塞值，
  靠 `as unknown as ApiSession` 强转绕过类型检查）
- `SessionHubFolderView.tsx` 的 `residentIds` 改为 `sessions.filter(s =>
  s.resident)`，不使用 `useBusySessions()`（其语义是"忙碌中"，会漏判"活跃
  但当前空闲"的会话）

**规格审查发现并修正的两个问题**（详见对应 commit）：

1. **ext 请求字段名错误**：`{ session_id: id }` 应为 `{ sessionId: id }`。
   后端 `GetSummaryRequest` 带 `#[serde(rename_all = "camelCase")]`，
   snake_case 字段会被当未知字段忽略、`#[serde(default)]` 静默变
   `None`，导致查询恒失败但不报错——`isLive: true` 在原实现下永远无法
   触发。本文档第三节、第四节的伪代码已同步修正。

2. **"sessionById useMemo 避免重复查询"论断不成立**：`useMemo(() => new
   Map(...), [sessions])` 在 `sessions` 换新引用时同样重新计算，产出新
   `Map` 引用，依赖它的 `useEffect` 照样重跑。这不满足设计文档原定的
   P0 验收标准（"sessions 引用变化但内容相同时不应重复查询"）。修正：
   `useEffect` 依赖改为 `residentIds.join(',')`（按内容比较的字符串），
   `sessions` 快照通过 `useRef` 存储、在 effect 内部读取、不放进依赖数组。
   本文档第三节、第四节、第五节的伪代码与测试用例已同步修正。
