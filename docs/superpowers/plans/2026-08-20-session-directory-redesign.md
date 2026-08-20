# 会话与目录管理重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把侧栏从「目录过滤的会话列表」重构为参考 Claude Code 桌面端的「全局会话列表 + 新建对话框 + 状态徽章 + worktree 创建」，并删除旧 SidePanel 组件族。

**Architecture:** 数据层先行——SessionContext 全量化、DirectoryContext 去手动管理、worktree.ts 从 SDK stub 重接 ACP ext；然后新建 `features/sessions-hub/` 组件族；最后切换挂载点并删除旧组件。新旧不互相牵制，全部现有测试保持通过。

**Tech Stack:** React 19 + TypeScript + Tailwind CSS v4 + vitest + @testing-library/react；ACP JSON-RPC over WebSocket（`acpExtRequest` / `acpExtNotify` / ext notification）。

**Spec:** `docs/superpowers/specs/2026-08-20-session-directory-redesign-design.md`

---

## 已核实的关键事实（写代码前必读）

1. **后端 roster 是全局的**：`x.ai/sessions/list` 返回「所有常驻 + 最近落盘」的会话，**不按 cwd 过滤**（[handlers/session.rs:48-58](crates/codegen/xai-grok-shell/src/agent/handlers/session.rs)）。前端的目录过滤完全是自己加的。全局列表 = 删掉前端过滤即可，**后端不用动**。
2. **RosterEntry 字段**：`{ sessionId, title, cwd, lastChangeUnixMs }`（[web/src/api/session.ts:36-41](web/src/api/session.ts)）。`getSessions()` 忽略所有查询参数。
3. **ACP ext 响应有 envelope**：`ExtMethodResult` 序列化为 `{ result, error }`；`acpExtRequest` 已自动解包 `result`（[acpBridge.ts:1728-1733](web/src/api/acpBridge.ts)）。**但** `x.ai/git/git_repo_root` 用 `to_raw_response`（无 envelope 裸对象，见 [extensions/mod.rs:69-73](crates/codegen/xai-grok-shell/src/extensions/mod.rs)），直接返回 `{ gitRoot }` 或 `{ status: "notGitRepo" }`——用 `acpExtRequest` 调它没问题，**别** 手动再取一层 `.result`。
4. **worktree 创建正确顺序**（TUI 实测路径，[effects/mod.rs:380-500](crates/codegen/xai-grok-pager/src/app/effects/mod.rs)）：
   a. 先调 `x.ai/git/worktree/create_from_worktree_sync`，params = `{ sourceWorktreePath, newSessionId, copyMode: "dirty"|"clean", label?, gitRef? }`。`newSessionId` 是一个 **worktree id 不是 session id**——TUI 用 `format!("pager-{uuid前12位}")` 生成。同步返回 `{ status, newSessionId, worktreePath, commit?, sourceGitRoot? }`。
   b. 再 `session/new`，cwd = worktreePath（如果源目录在 git root 子目录下，用 `sourceGitRoot` 拼相对子路径）。
5. **`session/new` 已有 ACP 桥**：`acpNewSession(directory?)` 内部做 `sessionCwdForWire` 编码（Windows 反斜杠）并回填 `sessionDirs`——**不要绕过它直接调 `client.rpc.request('session\new')`**（[acpBridge.ts:1594-1611](web/src/api/acpBridge.ts)）。
6. **会话状态来源（前端推断，无后端字段）**：`activeSessionStore` 的 `statusMap`（busy/retry，[store/activeSessionStore.ts:39-53](web/src/store/activeSessionStore.ts)）+ `pendingAction`（未回复的 permission/question）+ `notificationStore` 的 `NotificationEntry { type: 'permission'|'question'|'completed'|'error', sessionId }`。
7. **`getCurrentProject` / `getVcsInfo` / `listWorktrees` / `createWorktree`（web/src/api/worktree.ts）都是死代码**：走 `getSDKClient()` 安全 stub（[sdk.ts:39-46](web/src/api/sdk.ts)），永远返回 `{ data: undefined }`。isGit 检测**不能**用它们。
8. **通知广播总线已存在**：未识别的 ext notification 走 `window.dispatchEvent(new CustomEvent('acp:extNotification', { detail: { method, params } }))`（[acpBridge.ts:1564-1585](web/src/api/acpBridge.ts)）。`worktreeStatusStore` 在这里订阅 `x.ai/git/worktree/status`。
9. **前端测试基础**：104 个 test 文件；`SessionContext.test.tsx` 用 `vi.hoisted` + 模块级 mock（[web/src/contexts/SessionContext.test.tsx](web/src/contexts/SessionContext.test.tsx)）——新测试沿用此模式。
10. **App.tsx 里 `savedDirectories` 有独立用途**：喂给 `collectActiveDirectories` → `useGlobalEvents(activeDirectories)` 作为跨目录事件订阅范围（[App.tsx:109-119](web/src/App.tsx)）。**不能删掉这个字段**，改用 `recentProjects` 的 key 喂给它（语义等价，目录集合自动维护）。
11. **`currentDirectory` 是 URL 驱动的**（`useRouter`），pane 路由靠它。全局列表后它仍有职责：新建会话默认目录 + Header 显示。**保留字段，只改消费者**。
12. **`Sidebar.tsx` 有三处 `<SidePanel>`**（desktop docked / mobile overlay / mobileInline，[Sidebar.tsx:285,340,376](web/src/features/chat/Sidebar.tsx)）+ 每处配一个 `ProjectDialog`。切换挂载点时三处都要换。

---

## 文件结构

**新增 `web/src/features/sessions-hub/`：**
| 文件 | 职责 |
|---|---|
| `status.ts` | 纯函数：从 statusMap/pendingRequests/notifications 派生 `SessionUiStatus` |
| `status.test.ts` | status.ts 的测试 |
| `worktreeStatusStore.ts` | 订阅 `acp:extNotification` 的 `x.ai/git/worktree/status`，按 sessionId 存进度；纯模块 store |
| `NewSessionDialog.tsx` | 新建对话框：最近目录 + 浏览 + worktree 开关 + 创建编排 |
| `DirectorySelector.tsx` | 最近目录列表 + 手动路径输入（被 NewSessionDialog 使用） |
| `SessionListItem.tsx` | 单条会话条目：徽章 + 标题 + 相对时间 + 目录名 + hover 操作（重命名内联、删除确认） |
| `SessionHubPanel.tsx` | 新侧栏主面板：搜索 + 筛选 + 分组 + 列表 + 页脚 |
| `SessionHubPanel.test.tsx` | 面板级集成测试 |

**修改：**
| 文件 | 改动 |
|---|---|
| `web/src/contexts/SessionContext.tsx` | 删除 currentDirectory 过滤；`createSession(title?, directory?)` |
| `web/src/contexts/SessionContext.shared.ts` | `createSession` 签名加 `directory?` |
| `web/src/contexts/DirectoryContext.shared.ts` | 删 `SavedDirectory`/`savedDirectories`/`addDirectory`/`removeDirectory`/`reorderDirectories` |
| `web/src/contexts/DirectoryContext.tsx` | 只留 recentProjects + touchDirectory + currentDirectory + sidebar 委托 |
| `web/src/contexts/useDirectory.ts` | 删 `useSavedDirectories` |
| `web/src/contexts/index.ts` | 删 `useSavedDirectories` 导出 |
| `web/src/hooks/index.ts` | 删 `useSavedDirectories` 导出 |
| `web/src/api/worktree.ts` | 重写为 ACP ext：gitRootFor / createIsolatedWorktree |
| `web/src/api/acpBridge.ts` | 无代码改动——通知经 `acp:extNotification` 广播，store 自行订阅 |
| `web/src/utils/activeScope.ts` | 无代码改动（接口已是字符串数组） |
| `web/src/App.tsx` | `savedDirectories` 改用 `recentProjects` keys；`openProject` 改为打开新建对话框；挂载点换新组件 |
| `web/src/features/chat/Sidebar.tsx` | 三处 SidePanel → SessionHubPanel；删除 ProjectDialog |
| `web/src/contexts/SessionContext.test.tsx` | 适配新语义（目录过滤断言删除/改写） |
| `web/src/locales/zh-CN/chat.json`、`web/src/locales/en/chat.json` | 新增 `sessionsHub` 命名空间键 |

**删除（Task 12）：** `web/src/features/chat/sidebar/` 下 `SidePanel.tsx`、`FolderRecentList.tsx`、`ActiveSessionItem.tsx`、`NotificationItem.tsx`、`projectGrouping.ts`、`activeSessionTree.ts`、`activeSessionTree.test.ts`、`sidebarUtils.ts`、`SessionChildrenSlot.tsx`、`FolderRecentList.test.tsx`（若存在）；`web/src/features/chat/ProjectDialog.tsx`、`ProjectDialog.test.tsx`；`web/src/features/sessions/`（`SessionList.tsx`、`SessionList.test.tsx`、`ProjectSelector.tsx`、`ProjectSelector.test.tsx`、`selectionRound.ts`）。**保留**：`web/src/features/chat/sidebar/DirBrowserModal.tsx`、`web/src/features/chat/sidebar/SidebarFooter.tsx`、`web/src/hooks/useGitWorkspaceCatalog.ts`（新侧栏暂不用，属缺口 #6 面板，先留）。

---

## 关键界面

```ts
// features/sessions-hub/status.ts
export type SessionUiStatus =
  | { kind: 'working' }
  | { kind: 'needs_input' }
  | { kind: 'completed' }
  | { kind: 'failed' }
  | { kind: 'idle' }

export function deriveSessionUiStatus(input: {
  id: string
  busy: boolean
  hasPendingAction: boolean
  latestNotification: { type: string; timestamp: number } | null
}): SessionUiStatus
```

```ts
// features/sessions-hub/worktreeStatusStore.ts
export interface WorktreeProgress { kind: 'progress' | 'created' | 'error'; message?: string; worktreePath?: string }
export const worktreeStatusStore: {
  subscribe(key: string, cb: (progress: WorktreeProgress) => void): () => void
  snapshot(key: string): WorktreeProgress | null
  onExtNotification(method: string, params: unknown): void
}

// api/worktree.ts（重写后）
export async function gitRootFor(cwd: string): Promise<string | null>
export async function createIsolatedWorktree(input: {
  sourcePath: string
  label?: string
  gitRef?: string
}): Promise<{ worktreePath: string; sessionCwd: string }>

// contexts/SessionContext.shared.ts（变化处）
createSession: (title?: string, directory?: string) => Promise<ApiSession>

// contexts/DirectoryContext.shared.ts（变化处）
export interface DirectoryContextValue {
  currentDirectory: string | undefined
  setCurrentDirectory: (directory: string | undefined) => void
  recentProjects: Record<string, number>
  touchDirectory: (path: string) => void
  pathInfo: ApiPath | null
  sidebarExpanded: boolean
  setSidebarExpanded: (expanded: boolean) => void
}
```

---

## Task 1: sessions-hub 状态派生纯函数 status.ts

**Files:**
- Create: `web/src/features/sessions-hub/status.ts`
- Test: `web/src/features/sessions-hub/status.test.ts`

- [ ] **Step 1: 写失败测试**

`web/src/features/sessions-hub/status.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { deriveSessionUiStatus } from './status'

describe('deriveSessionUiStatus', () => {
  it('忙碌会话是 working', () => {
    expect(
      deriveSessionUiStatus({ id: 's1', busy: true, hasPendingAction: false, latestNotification: null }),
    ).toEqual({ kind: 'working' })
  })

  it('忙碌 + 有未答复操作仍是 working（以忙碌为准）', () => {
    expect(
      deriveSessionUiStatus({ id: 's1', busy: true, hasPendingAction: true, latestNotification: null }),
    ).toEqual({ kind: 'working' })
  })

  it('未答复操作是 needs_input', () => {
    expect(
      deriveSessionUiStatus({ id: 's1', busy: false, hasPendingAction: true, latestNotification: null }),
    ).toEqual({ kind: 'needs_input' })
  })

  it('最近一条 error 通知是 failed', () => {
    expect(
      deriveSessionUiStatus({
        id: 's1',
        busy: false,
        hasPendingAction: false,
        latestNotification: { type: 'error', timestamp: 200 },
      }),
    ).toEqual({ kind: 'failed' })
  })

  it('completed 通知优先于 error（时间戳新者赢）', () => {
    expect(
      deriveSessionUiStatus({
        id: 's1',
        busy: false,
        hasPendingAction: false,
        latestNotification: { type: 'error', timestamp: 200 },
      }),
    ).toEqual({ kind: 'failed' })
    expect(
      deriveSessionUiStatus({
        id: 's2',
        busy: false,
        hasPendingAction: false,
        latestNotification: { type: 'completed', timestamp: 300 },
      }),
    ).toEqual({ kind: 'completed' })
  })

  it('没有任何信号是 idle', () => {
    expect(
      deriveSessionUiStatus({ id: 's1', busy: false, hasPendingAction: false, latestNotification: null }),
    ).toEqual({ kind: 'idle' })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd web && npx vitest run src/features/sessions-hub/status.test.ts`
Expected: FAIL，`Cannot find module './status'`

- [ ] **Step 3: 实现**

`web/src/features/sessions-hub/status.ts`：

```ts
export type SessionUiStatus =
  | { kind: 'working' }
  | { kind: 'needs_input' }
  | { kind: 'completed' }
  | { kind: 'failed' }
  | { kind: 'idle' }

export interface SessionUiStatusInput {
  id: string
  busy: boolean
  hasPendingAction: boolean
  latestNotification: { type: string; timestamp: number } | null
}

/**
 * 会话侧栏徽章状态，按优先级从本地信号派生：
 * busy（activeSessionStore.statusMap）→ 未答复的 permission/question
 * → 最近一条通知（error → failed，completed → completed）→ idle。
 */
export function deriveSessionUiStatus(input: SessionUiStatusInput): SessionUiStatus {
  if (input.busy) return { kind: 'working' }
  if (input.hasPendingAction) return { kind: 'needs_input' }
  const n = input.latestNotification
  if (n) {
    if (n.type === 'error') return { kind: 'failed' }
    if (n.type === 'completed') return { kind: 'completed' }
  }
  return { kind: 'idle' }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd web && npx vitest run src/features/sessions-hub/status.test.ts`
Expected: PASS（6 用例）

- [ ] **Step 5: 提交**

```bash
git add web/src/features/sessions-hub/status.ts web/src/features/sessions-hub/status.test.ts
git commit -m "feat(sessions-hub): 会话状态徽章派生纯函数"
```

---

## Task 2: SessionContext 全局化 + createSession 支持目录

**Files:**
- Modify: `web/src/contexts/SessionContext.tsx`
- Modify: `web/src/contexts/SessionContext.shared.ts`
- Test: `web/src/contexts/SessionContext.test.tsx`（适配）

- [ ] **Step 1: 改 `SessionContext.shared.ts` 签名**

`web/src/contexts/SessionContext.shared.ts` 中 `createSession` 行替换为：

```ts
  createSession: (title?: string, directory?: string) => Promise<ApiSession>
```

- [ ] **Step 2: 改 `SessionContext.tsx` —— 删除目录过滤**

a. 删除 import 中的 `isSameDirectory`（保留 `normalizeToForwardSlash` 用于 createSession 传参）；删 `const { currentDirectory } = useDirectory()` 与 `currentDirectoryRef` 两个 effect。

b. `fetchSessions` 中删除 `targetDir` 行，调用改为：

```ts
        const data = await getSessions({
          limit: currentLimitRef.current,
          search: search || undefined,
          ...queryParams,
        })
```

依赖数组从 `[currentDirectory, search]` 改为 `[search]`。

c. 删除 `matchesCurrentDirectory` 整个函数。SSE 订阅中三处 `matchesCurrentDirectory(session)` 分支全部删除：

- `onSessionCreated`：`if (session.parentID) return` 之后直接进搜索分支 / 插入逻辑。
- `onSessionUpdated`：保留 `if (session.parentID) return` 与搜索分支里的 `fetchSessionsRef.current()`；删除搜索分支里「不匹配 → 本地过滤」与主路径里「不匹配 → 从列表移除」的分支——主路径统一为 index 查找 + 插入头部。
- `onSessionDeleted` 不变。

d. `createSession` 改为：

```ts
  const createSession = useCallback(
    async (title?: string, directory?: string) => {
      const targetDir = directory ?? normalizeToForwardSlash(currentDirectoryRef.current) ?? undefined
      const newSession = await apiCreateSession({ title, directory: targetDir })
      markSessionFresh(newSession.id)
      return newSession
    },
    [],
  )
```

保留一个 `currentDirectoryRef` 的轻量同步（`useDirectory` 仍可读 currentDirectory 作为默认值）：

```ts
  const { currentDirectory } = useDirectory()
  const currentDirectoryRef = useRef(currentDirectory)
  useEffect(() => {
    currentDirectoryRef.current = currentDirectory
  }, [currentDirectory])
```

e. 删除 `useEffect(() => { if (searchTimerRef.current) ... }, [fetchSessions, search, currentDirectory])` 依赖数组里的 `currentDirectory`（保留 search）。

f. `deleteSession` 里删除 `targetDir` 行，改为 `await apiDeleteSession(id)`。

- [ ] **Step 3: 适配测试**

`web/src/contexts/SessionContext.test.tsx` 里，所有「目录不匹配不显示」的断言改为「出现在列表」。具体：把 `useDirectory` mock 返回值保留；查找 `matchesCurrentDirectory` 相关的用例（例如「ignores sessions outside current directory」类），改写为：`onSessionCreated` 回调里传入 `directory: '/other/dir'` 的 session，断言 `latestContext.sessions` 包含它。若某用例断言 `getSessionsMock` 收到的 `directory` 参数等于 mock 目录，改为断言该参数为 `undefined`。

- [ ] **Step 4: 运行测试**

Run: `cd web && npx vitest run src/contexts/SessionContext.test.tsx`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add web/src/contexts/SessionContext.tsx web/src/contexts/SessionContext.shared.ts web/src/contexts/SessionContext.test.tsx
git commit -m "refactor(sessions): SessionContext 全局化，createSession 支持显式目录"
```

---

## Task 3: DirectoryContext 瘦身（自动维护最近目录）

**Files:**
- Modify: `web/src/contexts/DirectoryContext.tsx`
- Modify: `web/src/contexts/DirectoryContext.shared.ts`
- Modify: `web/src/contexts/useDirectory.ts`
- Modify: `web/src/contexts/index.ts`
- Modify: `web/src/hooks/index.ts`

- [ ] **Step 1: 改 `DirectoryContext.shared.ts`**

全文替换为：

```ts
import { createContext } from 'react'
import type { ApiPath } from '../api'

export interface DirectoryContextValue {
  currentDirectory: string | undefined
  setCurrentDirectory: (directory: string | undefined) => void
  recentProjects: Record<string, number>
  touchDirectory: (path: string) => void
  pathInfo: ApiPath | null
  sidebarExpanded: boolean
  setSidebarExpanded: (expanded: boolean) => void
}

export const DirectoryContext = createContext<DirectoryContextValue | null>(null)
```

- [ ] **Step 2: 改 `DirectoryContext.tsx`**

a. 删除 `SavedDirectory` 相关：import 里的 `type SavedDirectory`、`STORAGE_KEY_SAVED`、`readSavedDirectories` 函数、`savedDirectories` state、保存 effect、`addDirectory`、`removeDirectory`、`reorderDirectories`、Tauri 相关 import（`isTauri`、`addDirectoryRef`、Tauri effect）。

b. `readRecentProjects` 保留。

c. 新增 `touchDirectory`：

```ts
  const touchDirectory = useCallback((path: string) => {
    setRecentProjects(prev => ({ ...prev, [normalizeToForwardSlash(path)]: Date.now() }))
  }, [])
```

（注意：`setRecentProjects` 已在 `setCurrentDirectory` 里同步写 timestamp；这里用统一入口，写盘交给已有 effect。）

d. `value` useMemo 改为只包含新接口字段，依赖数组同步精简。

- [ ] **Step 3: 改 `useDirectory.ts` 与导出**

`web/src/contexts/useDirectory.ts`：删除 `useSavedDirectories` 与 `SavedDirectory` import。
`web/src/contexts/index.ts`、`web/src/hooks/index.ts`：删除 `useSavedDirectories` 导出。

- [ ] **Step 4: 确认无残留引用**

Run: `cd web && grep -rn "savedDirectories\|useSavedDirectories\|addDirectory\|removeDirectory\|reorderDirectories" src --include="*.ts" --include="*.tsx" | grep -v "SidePanel.tsx\|FolderRecentList.tsx\|WorktreePanel.tsx\|ProjectDialog\|ChatPane.tsx\|Sidebar.tsx"`

Expected: 无输出（SidePanel/FolderRecentList/ProjectDialog 将在 Task 12 删除；WorktreePanel/ChatPane/Sidebar 是后续任务的修改对象）。若出现其他文件，逐个改为 `touchDirectory` 语义（只把目录记入最近列表）或删除调用。

- [ ] **Step 5: 运行 typecheck 与测试**

Run: `cd web && npm run typecheck`
Expected: 除 WorktreePanel/ChatPane/Sidebar/App.tsx 的既有引用报错外无新错（这些任务 9-11 修）。若 Task 4 grep 已清干净，此时应只剩那几处。

Run: `cd web && npm run test:run 2>&1 | tail -5`
Expected: 无新增失败（SessionContext.test 已在 Task 2 适配）。

- [ ] **Step 6: 提交**

```bash
git add web/src/contexts/ web/src/hooks/index.ts
git commit -m "refactor(directory): 移除手动项目列表，目录集合自动维护"
```

---

## Task 4: worktree API 重接 ACP ext

**Files:**
- Rewrite: `web/src/api/worktree.ts`
- Test: `web/src/api/worktree.test.ts`（新增）

- [ ] **Step 1: 写失败测试**

`web/src/api/worktree.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { acpExtRequestMock, acpNewSessionMock } = vi.hoisted(() => ({
  acpExtRequestMock: vi.fn(),
  acpNewSessionMock: vi.fn(),
}))

vi.mock('./acpBridge', () => ({
  acpExtRequest: (...args: unknown[]) => acpExtRequestMock(...args),
  acpNewSession: (...args: unknown[]) => acpNewSessionMock(...args),
  getServerCwd: () => 'C:\\repo',
}))

import { gitRootFor, createIsolatedWorktree } from './worktree'

describe('worktree ACP API', () => {
  beforeEach(() => {
    acpExtRequestMock.mockReset()
    acpNewSessionMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('gitRootFor 返回 git root', async () => {
    acpExtRequestMock.mockResolvedValue({ gitRoot: 'C:\\repo' })
    await expect(gitRootFor('C:\\repo\\sub')).resolves.toBe('C:\\repo')
    expect(acpExtRequestMock).toHaveBeenCalledWith('x.ai/git/git_repo_root', {
      currentWorkingDirectory: 'C:\\repo\\sub',
    })
  })

  it('gitRootFor 非 git 仓库返回 null', async () => {
    acpExtRequestMock.mockResolvedValue({ status: 'notGitRepo' })
    await expect(gitRootFor('C:\\plain')).resolves.toBeNull()
  })

  it('createIsolatedWorktree 走 create_from_worktree_sync + acpNewSession', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-20T00:00:00Z') })
    acpExtRequestMock.mockResolvedValue({
      status: 'created',
      newSessionId: 'pager-abcdef123456',
      worktreePath: 'C:\\repo\\.claude\\worktrees\\2026-08-20-abcdef123456',
      sourceGitRoot: 'C:\\repo',
    })
    const result = await createIsolatedWorktree({ sourcePath: 'C:\\repo\\sub', label: 'feature' })
    expect(acpExtRequestMock).toHaveBeenCalledWith('x.ai/git/worktree/create_from_worktree_sync', {
      sourceWorktreePath: 'C:\\repo\\sub',
      newSessionId: expect.stringMatching(/^pager-/),
      copyMode: 'dirty',
      label: 'feature',
    })
    expect(result.worktreePath).toBe('C:\\repo\\.claude\\worktrees\\2026-08-20-abcdef123456')
    // 源目录在 git root 的子目录下：sessionCwd 拼相对子路径
    expect(result.sessionCwd).toBe('C:\\repo\\.claude\\worktrees\\2026-08-20-abcdef123456\\sub')
  })

  it('gitRef 存在时 copyMode 为 clean', async () => {
    acpExtRequestMock.mockResolvedValue({
      status: 'created',
      newSessionId: 'x',
      worktreePath: 'C:\\repo\\.claude\\worktrees\\w',
    })
    await createIsolatedWorktree({ sourcePath: 'C:\\repo', gitRef: 'feature/x' })
    const [, params] = acpExtRequestMock.mock.calls[0]
    expect((params as { copyMode: string }).copyMode).toBe('clean')
    expect((params as { gitRef?: string }).gitRef).toBe('feature/x')
  })

  it('响应缺 worktreePath 时报错', async () => {
    acpExtRequestMock.mockResolvedValue({ status: 'error', message: 'disk full' })
    await expect(createIsolatedWorktree({ sourcePath: 'C:\\repo' })).rejects.toThrow(/worktreePath/)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd web && npx vitest run src/api/worktree.test.ts`
Expected: FAIL，`Cannot find module './worktree'` 或行为不符（旧实现走 SDK stub 永远 `{ data: undefined }`）。

- [ ] **Step 3: 重写 `web/src/api/worktree.ts`**

```ts
// ============================================
// Worktree API - 重接 ACP ext（替代已 stub 的 @opencode-ai/sdk）
//
// 后端 ext handler：crates/codegen/xai-grok-shell/src/extensions/worktree.rs、
// crates/codegen/xai-grok-shell/src/extensions/git.rs。
// 注意：x.ai/git/git_repo_root 用 to_raw_response（无 ExtMethodResult
// envelope），acpExtRequest 已按「有 result 才解包」处理，两种形状都兼容。
// ============================================

import { acpExtRequest } from './acpBridge'

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/**
 * 解析 git root。非 git 仓库返回 null。
 * 响应形状（raw，无 envelope）：{ gitRoot } | { status: "notGitRepo" }
 */
export async function gitRootFor(cwd: string): Promise<string | null> {
  const resp = await acpExtRequest('x.ai/git/git_repo_root', { currentWorkingDirectory: cwd })
  if (!isRecord(resp)) return null
  if (typeof resp.gitRoot === 'string' && resp.gitRoot) return resp.gitRoot
  return null
}

function worktreeIdFor(): string {
  return `pager-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}

export interface CreateIsolatedWorktreeInput {
  /** 源目录（工作目录，git root 或子目录） */
  sourcePath: string
  label?: string
  /** git ref（branch/tag/sha），缺省 = HEAD（copyMode dirty） */
  gitRef?: string
}

export interface CreateIsolatedWorktreeResult {
  worktreePath: string
  /** 新会话的工作目录：worktree root 或（源在子目录时）对应子路径 */
  sessionCwd: string
}

/**
 * 同步创建隔离 worktree（TUI 同款路径：create_from_worktree_sync）。
 * 响应：{ status, newSessionId, worktreePath, commit?, sourceGitRoot? }
 */
export async function createIsolatedWorktree(
  input: CreateIsolatedWorktreeInput,
): Promise<CreateIsolatedWorktreeResult> {
  const params: Record<string, unknown> = {
    sourceWorktreePath: input.sourcePath,
    newSessionId: worktreeIdFor(),
    copyMode: input.gitRef ? 'clean' : 'dirty',
  }
  if (input.label) params.label = input.label
  if (input.gitRef) params.gitRef = input.gitRef

  const resp = await acpExtRequest('x.ai/git/worktree/create_from_worktree_sync', params)
  if (!isRecord(resp) || typeof resp.worktreePath !== 'string' || !resp.worktreePath) {
    const message = isRecord(resp) && typeof resp.message === 'string' ? resp.message : 'missing worktreePath'
    throw new Error(`worktree 创建失败: ${message}`)
  }

  const worktreePath = resp.worktreePath
  let sessionCwd = worktreePath
  const sourceGitRoot = typeof resp.sourceGitRoot === 'string' ? resp.sourceGitRoot : null
  if (sourceGitRoot && sourceGitRoot.length > 0 && worktreePath.length > 0) {
    const rootNorm = sourceGitRoot.replace(/\\/g, '/').replace(/\/+$/, '')
    const srcNorm = input.sourcePath.replace(/\\/g, '/').replace(/\/+$/, '')
    if (srcNorm.toLowerCase().startsWith(rootNorm.toLowerCase() + '/')) {
      const relative = srcNorm.slice(rootNorm.length + 1)
      sessionCwd = worktreePath.replace(/\\/g, '/').replace(/\/+$/, '') + '/' + relative
    }
  }
  return { worktreePath, sessionCwd }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd web && npx vitest run src/api/worktree.test.ts`
Expected: PASS（5 用例）

- [ ] **Step 5: 提交**

```bash
git add web/src/api/worktree.ts web/src/api/worktree.test.ts
git commit -m "feat(worktree): API 从 SDK stub 重接 ACP ext（git root 检测 + 隔离 worktree 创建）"
```

---

## Task 5: worktree 进度通知 store

**Files:**
- Create: `web/src/features/sessions-hub/worktreeStatusStore.ts`
- Test: `web/src/features/sessions-hub/worktreeStatusStore.test.ts`

- [ ] **Step 1: 写失败测试**

`web/src/features/sessions-hub/worktreeStatusStore.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { worktreeStatusStore, subscribeWorktreeStatus } from './worktreeStatusStore'

describe('worktreeStatusStore', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    worktreeStatusStore.clearAll()
  })

  it('收到 x.ai/git/worktree/status 通知后通知订阅者', () => {
    const cb = vi.fn()
    const unsubscribe = subscribeWorktreeStatus('k1', cb)
    worktreeStatusStore.onExtNotification('x.ai/git/worktree/status', {
      status: 'progress',
      sessionId: 'k1',
      message: 'copying…',
    })
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ kind: 'progress', message: 'copying…' }))
    unsubscribe()
  })

  it('created 通知携带 worktreePath', () => {
    const cb = vi.fn()
    subscribeWorktreeStatus('k2', cb)
    worktreeStatusStore.onExtNotification('x.ai/git/worktree/status', {
      status: 'created',
      sessionId: 'k2',
      worktreePath: 'C:\\repo\\.claude\\worktrees\\w',
    })
    expect(cb).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'created', worktreePath: 'C:\\repo\\.claude\\worktrees\\w' }),
    )
  })

  it('error 通知映射 kind=error', () => {
    const cb = vi.fn()
    subscribeWorktreeStatus('k3', cb)
    worktreeStatusStore.onExtNotification('x.ai/git/worktree/status', {
      status: 'error',
      sessionId: 'k3',
      message: 'boom',
    })
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error', message: 'boom' }))
  })

  it('无关 ext 通知被忽略', () => {
    const cb = vi.fn()
    subscribeWorktreeStatus('k4', cb)
    worktreeStatusStore.onExtNotification('x.ai/other', {})
    expect(cb).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd web && npx vitest run src/features/sessions-hub/worktreeStatusStore.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

`web/src/features/sessions-hub/worktreeStatusStore.ts`：

```ts
// ============================================
// worktreeStatusStore - x.ai/git/worktree/status 进度订阅
// 后端 WorktreeStatus 形状（serde tag="status"）：
//   { status: "progress", sessionId, message }
//   { status: "created",  sessionId, worktreePath, commit, ... }
//   { status: "error",    sessionId, message }
// 通知经 acpBridge 的 acp:extNotification 广播（见 api/acpBridge.ts
// handleExtNotification——未识别的 ext 通知原样转发）。
// ============================================

export interface WorktreeProgress {
  kind: 'progress' | 'created' | 'error'
  message?: string
  worktreePath?: string
}

type Key = string
type Listener = (progress: WorktreeProgress) => void

const listeners = new Map<Key, Set<Listener>>()

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

export const worktreeStatusStore = {
  subscribe(key: Key, listener: Listener): () => void {
    let set = listeners.get(key)
    if (!set) {
      set = new Set()
      listeners.set(key, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) listeners.delete(key)
    }
  },

  onExtNotification(method: string, params: unknown): void {
    if (method !== 'x.ai/git/worktree/status' || !isRecord(params)) return
    const key = typeof params.sessionId === 'string' ? params.sessionId : ''
    if (!key) return
    const set = listeners.get(key)
    if (!set || set.size === 0) return
    let progress: WorktreeProgress
    if (params.status === 'progress') {
      progress = { kind: 'progress', message: typeof params.message === 'string' ? params.message : undefined }
    } else if (params.status === 'created') {
      progress = {
        kind: 'created',
        worktreePath: typeof params.worktreePath === 'string' ? params.worktreePath : undefined,
      }
    } else if (params.status === 'error') {
      progress = { kind: 'error', message: typeof params.message === 'string' ? params.message : undefined }
    } else {
      return
    }
    for (const listener of [...set]) {
      listener(progress)
    }
  },

  clearAll(): void {
    listeners.clear()
  },
}

export function subscribeWorktreeStatus(key: Key, listener: Listener): () => void {
  return worktreeStatusStore.subscribe(key, listener)
}

if (typeof window !== 'undefined') {
  window.addEventListener('acp:extNotification', (event: Event) => {
    const detail = (event as CustomEvent<{ method: string; params: unknown }>).detail
    if (detail) {
      worktreeStatusStore.onExtNotification(detail.method, detail.params)
    }
  })
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd web && npx vitest run src/features/sessions-hub/worktreeStatusStore.test.ts`
Expected: PASS（4 用例）

- [ ] **Step 5: 提交**

```bash
git add web/src/features/sessions-hub/worktreeStatusStore.ts web/src/features/sessions-hub/worktreeStatusStore.test.ts
git commit -m "feat(sessions-hub): worktree 创建进度通知 store"
```

---

## Task 6: 新建会话对话框 NewSessionDialog + DirectorySelector

**Files:**
- Create: `web/src/features/sessions-hub/DirectorySelector.tsx`
- Create: `web/src/features/sessions-hub/NewSessionDialog.tsx`
- Test: `web/src/features/sessions-hub/NewSessionDialog.test.tsx`

- [ ] **Step 1: 写失败测试**

`web/src/features/sessions-hub/NewSessionDialog.test.tsx`：

```tsx
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NewSessionDialog } from './NewSessionDialog'

const { useDirectoryMock, gitRootForMock, createIsolatedWorktreeMock, createSessionMock } = vi.hoisted(() => ({
  useDirectoryMock: vi.fn(),
  gitRootForMock: vi.fn(),
  createIsolatedWorktreeMock: vi.fn(),
  createSessionMock: vi.fn(),
}))

vi.mock('../../contexts/useDirectory', () => ({
  useDirectory: () => useDirectoryMock(),
}))

vi.mock('../../api/worktree', () => ({
  gitRootFor: (...args: unknown[]) => gitRootForMock(...args),
  createIsolatedWorktree: (...args: unknown[]) => createIsolatedWorktreeMock(...args),
}))

vi.mock('../../contexts/useSessionContext', () => ({
  useSessionContext: () => ({ createSession: (...args: unknown[]) => createSessionMock(...args) }),
}))

function renderDialog(overrides: Record<string, unknown> = {}) {
  const props = {
    isOpen: true,
    initialDirectory: 'C:\\repo',
    onClose: vi.fn(),
    onCreated: vi.fn(),
    ...overrides,
  }
  render(<NewSessionDialog {...props} />)
  return props
}

describe('NewSessionDialog', () => {
  beforeEach(() => {
    useDirectoryMock.mockReset()
    useDirectoryMock.mockReturnValue({
      recentProjects: { 'C:\\repo': 1000, 'D:\\other': 500 },
      touchDirectory: vi.fn(),
    })
    gitRootForMock.mockReset()
    createIsolatedWorktreeMock.mockReset()
    createSessionMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('渲染最近目录列表，选中项高亮', async () => {
    renderDialog()
    expect(screen.getByText('C:\\repo')).toBeInTheDocument()
    await userEvent.click(screen.getByText('D:\\other'))
    // 目录行有 data-selected 标记
    expect(screen.getByText('D:\\other').closest('[data-selected="true"]')).not.toBeNull()
  })

  it('普通创建：用选中目录 createSession 并触发 onCreated', async () => {
    createSessionMock.mockResolvedValue({ id: 's1' })
    const props = renderDialog()
    await userEvent.click(screen.getByText('C:\\repo'))
    await userEvent.click(screen.getByRole('button', { name: /创建/ }))
    await act(async () => {})
    expect(createSessionMock).toHaveBeenCalledWith(undefined, 'C:\\repo')
    expect(props.onCreated).toHaveBeenCalledWith({ id: 's1' })
  })

  it('目录是 git 仓库时显示 worktree 开关', async () => {
    gitRootForMock.mockResolvedValue('C:\\repo')
    renderDialog()
    await act(async () => {})
    expect(screen.getByText(/隔离 worktree/)).toBeInTheDocument()
  })

  it('worktree 路径：先建 worktree 再用 sessionCwd 建会话', async () => {
    gitRootForMock.mockResolvedValue('C:\\repo')
    createIsolatedWorktreeMock.mockResolvedValue({
      worktreePath: 'C:\\repo\\.claude\\worktrees\\w1',
      sessionCwd: 'C:\\repo\\.claude\\worktrees\\w1\\sub',
    })
    createSessionMock.mockResolvedValue({ id: 's2' })
    const props = renderDialog()
    await act(async () => {})
    const toggle = screen.getByRole('switch')
    await userEvent.click(toggle)
    await userEvent.click(screen.getByRole('button', { name: /创建/ }))
    await act(async () => {})
    expect(createIsolatedWorktreeMock).toHaveBeenCalledWith({
      sourcePath: 'C:\\repo',
    })
    expect(createSessionMock).toHaveBeenCalledWith(undefined, 'C:\\repo\\.claude\\worktrees\\w1\\sub')
    expect(props.onCreated).toHaveBeenCalledWith({ id: 's2' })
  })

  it('未选目录时创建按钮禁用', () => {
    useDirectoryMock.mockReturnValue({ recentProjects: {}, touchDirectory: vi.fn() })
    renderDialog()
    expect(screen.getByRole('button', { name: /创建/ })).toBeDisabled()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd web && npx vitest run src/features/sessions-hub/NewSessionDialog.test.tsx`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 `DirectorySelector.tsx`**

```tsx
// 目录选择器：最近目录列表 + 手动输入路径。被 NewSessionDialog 使用。

import { useMemo, useState } from 'react'
import { FolderIcon } from '../../components/Icons'
import { normalizeToForwardSlash } from '../../utils'

export interface DirectorySelectorProps {
  recentProjects: Record<string, number>
  selected: string
  onSelect: (path: string) => void
}

const MAX_RECENT = 5

export function DirectorySelector({ recentProjects, selected, onSelect }: DirectorySelectorProps) {
  const [manualPath, setManualPath] = useState('')

  const recents = useMemo(() => {
    return Object.entries(recentProjects)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_RECENT)
      .map(([path]) => path)
  }, [recentProjects])

  const handleManualSubmit = () => {
    const trimmed = manualPath.trim()
    if (!trimmed) return
    onSelect(normalizeToForwardSlash(trimmed))
  }

  return (
    <div className="space-y-2">
      <div className="text-[length:var(--fs-xs)] font-medium uppercase tracking-wider text-text-400">
        工作目录
      </div>

      {recents.length > 0 && (
        <div className="space-y-0.5">
          {recents.map(path => (
            <button
              key={path}
              type="button"
              data-selected={path === selected}
              onClick={() => onSelect(path)}
              className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left transition-colors ${
                path === selected
                  ? 'bg-accent-main-100/10 text-accent-main-100'
                  : 'text-text-200 hover:bg-bg-200/60'
              }`}
            >
              <FolderIcon size={14} className="shrink-0 text-text-400" />
              <span className="truncate text-[length:var(--fs-sm)] font-mono">{path}</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={manualPath}
          onChange={e => setManualPath(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') handleManualSubmit()
          }}
          placeholder="手动输入路径，回车确认"
          spellCheck={false}
          className="flex-1 h-8 px-2.5 text-[length:var(--fs-sm)] font-mono rounded-md bg-transparent text-text-100 border border-border-200 outline-none focus:border-accent-main-100"
        />
        <button
          type="button"
          onClick={handleManualSubmit}
          className="h-8 px-2.5 rounded-md text-[length:var(--fs-sm)] text-text-300 hover:text-text-100 hover:bg-bg-200/60 transition-colors"
        >
          确认
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: 实现 `NewSessionDialog.tsx`**

```tsx
// 新建会话对话框：选择工作目录（最近列表 / 手动输入 / 浏览模态框），
// Git 仓库可选在隔离 worktree 中运行，创建成功后通知父组件。

import { useEffect, useState } from 'react'
import { Button } from '../../components/ui/Button'
import { Dialog } from '../../components/ui/Dialog'
import { SpinnerIcon } from '../../components/Icons'
import { useDirectory } from '../../contexts/useDirectory'
import { useSessionContext } from '../../contexts/useSessionContext'
import { gitRootFor, createIsolatedWorktree } from '../../api/worktree'
import { subscribeWorktreeStatus, type WorktreeProgress } from './worktreeStatusStore'
import { DirBrowserModal } from '../chat/sidebar/DirBrowserModal'
import { DirectorySelector } from './DirectorySelector'

export interface NewSessionDialogProps {
  isOpen: boolean
  initialDirectory: string
  onClose: () => void
  onCreated: (session: { id: string; directory?: string }) => void
}

export function NewSessionDialog({ isOpen, initialDirectory, onClose, onCreated }: NewSessionDialogProps) {
  const { recentProjects, touchDirectory } = useDirectory()
  const { createSession } = useSessionContext()

  const [selectedDir, setSelectedDir] = useState(initialDirectory)
  const [isGit, setIsGit] = useState<boolean | null>(null)
  const [useWorktree, setUseWorktree] = useState(false)
  const [worktreeProgress, setWorktreeProgress] = useState<WorktreeProgress | null>(null)
  const [creating, setCreating] = useState(false)
  const [browserOpen, setBrowserOpen] = useState(false)

  // 打开 / 目录变化时重置状态并检测 git
  useEffect(() => {
    if (!isOpen) return
    setSelectedDir(initialDirectory)
    setUseWorktree(false)
    setWorktreeProgress(null)
    setIsGit(null)
    if (initialDirectory) {
      void gitRootFor(initialDirectory)
        .then(root => setIsGit(Boolean(root)))
        .catch(() => setIsGit(false))
    } else {
      setIsGit(false)
    }
  }, [isOpen, initialDirectory])

  const handleCreate = async () => {
    if (!selectedDir || creating) return
    setCreating(true)
    setWorktreeProgress(null)
    try {
      let sessionDir = selectedDir
      if (useWorktree && isGit) {
        const worktreeKey = `pager-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
        const unsubscribe = subscribeWorktreeStatus(worktreeKey, progress => {
          setWorktreeProgress(progress)
        })
        try {
          const created = await createIsolatedWorktree({ sourcePath: selectedDir })
          sessionDir = created.sessionCwd
        } finally {
          unsubscribe()
        }
      }
      const session = await createSession(undefined, sessionDir)
      touchDirectory(sessionDir)
      onCreated(session)
    } finally {
      setCreating(false)
    }
  }

  return (
    <>
      <Dialog isOpen={isOpen} onClose={onClose} title="新建会话" width={520}>
        <div className="space-y-4">
          <DirectorySelector
            recentProjects={recentProjects}
            selected={selectedDir}
            onSelect={setSelectedDir}
          />

          <button
            type="button"
            onClick={() => setBrowserOpen(true)}
            className="w-full flex items-center justify-center gap-1.5 h-8 rounded-md border border-dashed border-border-200 text-[length:var(--fs-sm)] text-text-300 hover:text-text-100 hover:border-border-100 transition-colors"
          >
            浏览文件系统…
          </button>

          {isGit && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                role="switch"
                checked={useWorktree}
                onChange={e => setUseWorktree(e.target.checked)}
                className="accent-accent-main-100"
              />
              <span className="text-[length:var(--fs-sm)] text-text-200">
                在隔离 worktree 中运行
              </span>
              <span className="text-[length:var(--fs-xs)] text-text-400">（不影响主代码库）</span>
            </label>
          )}

          {creating && worktreeProgress?.kind === 'progress' && (
            <div className="flex items-center gap-2 text-[length:var(--fs-sm)] text-text-300">
              <SpinnerIcon size={14} className="animate-spin" />
              <span>{worktreeProgress.message ?? '正在创建 worktree…'}</span>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={onClose}>
              取消
            </Button>
            <Button size="sm" onClick={handleCreate} disabled={!selectedDir || creating}>
              {creating ? '创建中…' : '创建会话'}
            </Button>
          </div>
        </div>
      </Dialog>

      <DirBrowserModal
        isOpen={browserOpen}
        initialPath={selectedDir || initialDirectory}
        onSelect={path => {
          setSelectedDir(path)
          setBrowserOpen(false)
        }}
        onClose={() => setBrowserOpen(false)}
      />
    </>
  )
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd web && npx vitest run src/features/sessions-hub/NewSessionDialog.test.tsx`
Expected: PASS（5 用例）

- [ ] **Step 6: 提交**

```bash
git add web/src/features/sessions-hub/DirectorySelector.tsx web/src/features/sessions-hub/NewSessionDialog.tsx web/src/features/sessions-hub/NewSessionDialog.test.tsx
git commit -m "feat(sessions-hub): 新建会话对话框（最近目录 + 隔离 worktree）"
```

---

## Task 7: 会话条目 SessionListItem

**Files:**
- Create: `web/src/features/sessions-hub/SessionListItem.tsx`
- Test: `web/src/features/sessions-hub/SessionListItem.test.tsx`

- [ ] **Step 1: 写失败测试**

`web/src/features/sessions-hub/SessionListItem.test.tsx`：

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionListItem } from './SessionListItem'
import type { ApiSession } from '../../api'

vi.mock('../../components/ui/ConfirmDialog', () => ({
  ConfirmDialog: ({ isOpen, onConfirm, title }: { isOpen: boolean; onConfirm: () => void; title: string }) =>
    isOpen ? (
      <div role="dialog">
        {title}
        <button onClick={onConfirm}>confirm</button>
      </div>
    ) : null,
}))

function makeSession(overrides: Partial<ApiSession> = {}): ApiSession {
  return {
    id: 's1',
    directory: 'C:\\repo',
    title: '修登录 bug',
    version: '',
    time: { created: 1000, updated: 2000 },
    ...overrides,
  } as ApiSession
}

describe('SessionListItem', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-20T12:00:00Z'))
  })

  it('渲染标题、相对时间与目录名', () => {
    render(
      <SessionListItem
        session={makeSession()}
        isSelected={false}
        onSelect={() => {}}
        onRename={() => Promise.resolve()}
        onDelete={() => Promise.resolve()}
      />,
    )
    expect(screen.getByText('修登录 bug')).toBeInTheDocument()
    expect(screen.getByText('repo')).toBeInTheDocument()
    expect(screen.getByText(/ago/)).toBeInTheDocument()
  })

  it('选中态有 data-selected 标记', () => {
    const { container } = render(
      <SessionListItem
        session={makeSession()}
        isSelected={true}
        onSelect={() => {}}
        onRename={() => Promise.resolve()}
        onDelete={() => Promise.resolve()}
      />,
    )
    expect(container.querySelector('[data-selected="true"]')).not.toBeNull()
  })

  it('点击条目触发 onSelect', async () => {
    const onSelect = vi.fn()
    render(
      <SessionListItem
        session={makeSession()}
        isSelected={false}
        onSelect={onSelect}
        onRename={() => Promise.resolve()}
        onDelete={() => Promise.resolve()}
      />,
    )
    await userEvent.click(screen.getByText('修登录 bug'))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }))
  })

  it('无标题显示占位文案', () => {
    render(
      <SessionListItem
        session={makeSession({ title: '' })}
        isSelected={false}
        onSelect={() => {}}
        onRename={() => Promise.resolve()}
        onDelete={() => Promise.resolve()}
      />,
    )
    expect(screen.getByText('未命名会话')).toBeInTheDocument()
  })

  it('删除需确认，确认后调用 onDelete', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined)
    render(
      <SessionListItem
        session={makeSession()}
        isSelected={false}
        onSelect={() => {}}
        onRename={() => Promise.resolve()}
        onDelete={onDelete}
      />,
    )
    await userEvent.click(screen.getByTitle('删除会话'))
    await userEvent.click(screen.getByText('confirm'))
    expect(onDelete).toHaveBeenCalledWith('s1')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd web && npx vitest run src/features/sessions-hub/SessionListItem.test.tsx`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

`web/src/features/sessions-hub/SessionListItem.tsx`：

```tsx
// 单条会话条目：状态徽章 + 标题 + 相对时间 + 目录名 + hover 操作（重命名 / 删除）。

import { useEffect, useRef, useState } from 'react'
import { TrashIcon, EditIcon } from '../../components/Icons'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { getDirectoryName } from '../../utils'
import type { ApiSession } from '../../api'
import { deriveSessionUiStatus, type SessionUiStatus } from './status'

const STATUS_DOT: Record<SessionUiStatus['kind'], string> = {
  working: 'bg-blue-500',
  needs_input: 'bg-yellow-500',
  completed: 'bg-emerald-500',
  failed: 'bg-red-500',
  idle: 'bg-bg-300',
}

export interface SessionListItemProps {
  session: ApiSession
  isSelected: boolean
  uiStatus: SessionUiStatus
  onSelect: (session: ApiSession) => void
  onRename: (sessionId: string, title: string) => Promise<void>
  onDelete: (sessionId: string) => Promise<void>
}

function formatRelativeTime(ts: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - ts) / 60_000))
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  return `${days} 天前`
}

export function SessionListItem({ session, isSelected, uiStatus, onSelect, onRename, onDelete }: SessionListItemProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(session.title ?? '')
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const commitRename = async () => {
    const title = draft.trim()
    setEditing(false)
    if (title && title !== (session.title ?? '')) {
      await onRename(session.id, title)
    }
  }

  const directoryName = session.directory ? getDirectoryName(session.directory) : ''

  return (
    <>
      <div
        data-selected={isSelected}
        onClick={() => onSelect(session)}
        className={`group flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors ${
          isSelected ? 'bg-bg-200/80' : 'hover:bg-bg-200/50'
        }`}
      >
        <span
          aria-label={uiStatus.kind}
          className={`size-2 rounded-full shrink-0 ${STATUS_DOT[uiStatus.kind]} ${uiStatus.kind === 'working' ? 'animate-pulse' : ''}`}
        />

        <div className="flex-1 min-w-0">
          {editing ? (
            <input
              ref={inputRef}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={e => {
                if (e.key === 'Enter') commitRename()
                if (e.key === 'Escape') {
                  setDraft(session.title ?? '')
                  setEditing(false)
                }
              }}
              className="w-full h-6 px-1.5 text-[length:var(--fs-sm)] rounded bg-bg-100 border border-border-200 outline-none focus:border-accent-main-100"
              autoFocus
            />
          ) : (
            <div className="truncate text-[length:var(--fs-sm)] text-text-100">
              {session.title || '未命名会话'}
            </div>
          )}
          <div className="flex items-center gap-1.5 text-[length:var(--fs-xxs)] text-text-400">
            <span>{formatRelativeTime(session.time?.updated ?? 0, Date.now())}</span>
            {directoryName && (
              <span className="truncate max-w-[40%] font-mono opacity-80">{directoryName}</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            type="button"
            onClick={e => {
              e.stopPropagation()
              setDraft(session.title ?? '')
              setEditing(true)
            }}
            title="重命名会话"
            className="p-1 rounded text-text-400 hover:text-text-100 hover:bg-bg-300"
          >
            <EditIcon size={12} />
          </button>
          <button
            type="button"
            onClick={e => {
              e.stopPropagation()
              setDeleteConfirmOpen(true)
            }}
            title="删除会话"
            className="p-1 rounded text-text-400 hover:text-danger-100 hover:bg-danger-100/10"
          >
            <TrashIcon size={12} />
          </button>
        </div>
      </div>

      <ConfirmDialog
        isOpen={deleteConfirmOpen}
        onClose={() => setDeleteConfirmOpen(false)}
        onConfirm={async () => {
          setDeleteConfirmOpen(false)
          await onDelete(session.id)
        }}
        title="删除会话"
        description="删除后不可恢复，确定删除这个会话吗？"
        confirmText="删除"
        variant="danger"
      />
    </>
  )
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd web && npx vitest run src/features/sessions-hub/SessionListItem.test.tsx`
Expected: PASS（5 用例）

- [ ] **Step 5: 提交**

```bash
git add web/src/features/sessions-hub/SessionListItem.tsx web/src/features/sessions-hub/SessionListItem.test.tsx
git commit -m "feat(sessions-hub): 会话条目（状态徽章 + hover 操作）"
```

---

## Task 8: 侧栏主面板 SessionHubPanel

**Files:**
- Create: `web/src/features/sessions-hub/SessionHubPanel.tsx`
- Test: `web/src/features/sessions-hub/SessionHubPanel.test.tsx`

- [ ] **Step 1: 写失败测试**

`web/src/features/sessions-hub/SessionHubPanel.test.tsx`：

```tsx
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionHubPanel } from './SessionHubPanel'
import type { ApiSession } from '../../api'

const {
  useSessionContextMock,
  useBusySessionsMock,
  useNotificationsMock,
  updateSessionMock,
  deleteSessionMock,
} = vi.hoisted(() => ({
  useSessionContextMock: vi.fn(),
  useBusySessionsMock: vi.fn(),
  useNotificationsMock: vi.fn(),
  updateSessionMock: vi.fn(),
  deleteSessionMock: vi.fn(),
}))

vi.mock('../../contexts/useSessionContext', () => ({
  useSessionContext: () => useSessionContextMock(),
}))

vi.mock('../../store/activeSessionStore', () => ({
  useBusySessions: () => useBusySessionsMock(),
  useBusyCount: () => 0,
}))

vi.mock('../../store/notificationStore', () => ({
  useNotifications: () => useNotificationsMock(),
}))

vi.mock('../../api', () => ({
  updateSession: (...args: unknown[]) => updateSessionMock(...args),
  deleteSession: (...args: unknown[]) => deleteSessionMock(...args),
}))

vi.mock('../../api/acpBridge', () => ({
  getServerCwd: () => 'C:\\root',
}))

vi.mock('./NewSessionDialog', () => ({
  NewSessionDialog: ({ isOpen, onClose, onCreated }: { isOpen: boolean; onClose: () => void; onCreated: (s: { id: string }) => void }) =>
    isOpen ? (
      <div role="dialog">
        <button onClick={() => onCreated({ id: 'new-1', directory: 'C:\\repo' })}>fake-create</button>
        <button onClick={onClose}>fake-close</button>
      </div>
    ) : null,
}))

vi.mock('./DirBrowserModalProxy', () => ({}))

function makeSession(overrides: Partial<ApiSession> = {}): ApiSession {
  return {
    id: 's1',
    directory: 'C:\\repo',
    title: '会话 A',
    version: '',
    time: { created: 1000, updated: 2000 },
    ...overrides,
  } as ApiSession
}

function sessionCtx(sessions: ApiSession[], search = '') {
  return {
    sessions,
    isLoading: false,
    isLoadingMore: false,
    hasMore: false,
    search,
    setSearch: vi.fn(),
    refresh: vi.fn(),
    loadMore: vi.fn(),
    createSession: vi.fn(),
    deleteSession: vi.fn(),
  }
}

describe('SessionHubPanel', () => {
  beforeEach(() => {
    useSessionContextMock.mockReset()
    useBusySessionsMock.mockReset()
    useBusySessionsMock.mockReturnValue([])
    useNotificationsMock.mockReset()
    useNotificationsMock.mockReturnValue([])
    updateSessionMock.mockReset()
    deleteSessionMock.mockReset()
  })

  it('渲染全局会话列表（含不同目录的会话）', () => {
    useSessionContextMock.mockReturnValue(
      sessionCtx([makeSession({ id: 's1', directory: 'C:\\repo' }), makeSession({ id: 's2', directory: 'D:\\other' })]),
    )
    render(
      <SessionHubPanel
        onNewSession={vi.fn()}
        onSelectSession={vi.fn()}
        selectedSessionId={null}
        isExpanded={true}
        onToggleSidebar={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    )
    expect(screen.getByText('会话 A')).toBeInTheDocument()
    expect(screen.getByText('D:\\other').closest('div')).not.toBeNull()
  })

  it('状态筛选：Needs input 只显示对应会话', async () => {
    useSessionContextMock.mockReturnValue(
      sessionCtx([makeSession({ id: 's1' }), makeSession({ id: 's2' })]),
    )
    useBusySessionsMock.mockReturnValue([{ sessionId: 's2', status: { type: 'busy' } }])
    render(
      <SessionHubPanel
        onNewSession={vi.fn()}
        onSelectSession={vi.fn()}
        selectedSessionId={null}
        isExpanded={true}
        onToggleSidebar={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByText('筛选'))
    await userEvent.click(screen.getByText('Working'))
    expect(screen.queryByText('会话 A')).not.toBeInTheDocument()
  })

  it('按项目分组：同目录折叠到分组头', () => {
    useSessionContextMock.mockReturnValue(
      sessionCtx([makeSession({ id: 's1', directory: 'C:\\repo' }), makeSession({ id: 's2', directory: 'C:\\repo' })]),
    )
    render(
      <SessionHubPanel
        onNewSession={vi.fn()}
        onSelectSession={vi.fn()}
        selectedSessionId={null}
        isExpanded={true}
        onToggleSidebar={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    )
    expect(screen.getByText('repo · 2')).toBeInTheDocument()
  })

  it('点新建打开对话框，fake-create 后触发 onNewSession', async () => {
    const onNewSession = vi.fn()
    useSessionContextMock.mockReturnValue(sessionCtx([]))
    render(
      <SessionHubPanel
        onNewSession={onNewSession}
        onSelectSession={vi.fn()}
        selectedSessionId={null}
        isExpanded={true}
        onToggleSidebar={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByTitle('新建会话'))
    await userEvent.click(screen.getByText('fake-create'))
    expect(onNewSession).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd web && npx vitest run src/features/sessions-hub/SessionHubPanel.test.tsx`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

`web/src/features/sessions-hub/SessionHubPanel.tsx`：

```tsx
// 侧栏主面板：全局会话列表 + 状态筛选 + 按项目分组 + 通知铃铛。
// 对齐 Claude Code 桌面端：单一列表，会话自带目录与状态，不再按目录过滤。

import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { SearchIcon, CloseIcon, BellIcon, NewChatIcon, SidebarIcon, CheckIcon } from '../../components/Icons'
import { useSessionContext } from '../../contexts/useSessionContext'
import { useBusySessions } from '../../store/activeSessionStore'
import { notificationStore, useNotifications } from '../../store/notificationStore'
import { updateSession, deleteSession as apiDeleteSession, type ApiSession } from '../../api'
import { getServerCwd } from '../../api/acpBridge'
import { getDirectoryName, isSameDirectory, normalizeToForwardSlash } from '../../utils'
import { uiErrorHandler } from '../../utils'
import { SidebarFooter } from '../chat/sidebar/SidebarFooter'
import { SessionListItem } from './SessionListItem'
import { NewSessionDialog } from './NewSessionDialog'
import { deriveSessionUiStatus, type SessionUiStatus } from './status'

export interface SessionHubPanelProps {
  onNewSession: () => void
  onSelectSession: (session: ApiSession) => void
  selectedSessionId: string | null
  isExpanded: boolean
  onToggleSidebar: () => void
  onOpenSettings?: () => void
}

type StatusFilter = 'all' | SessionUiStatus['kind']

const FILTER_LABELS: Record<StatusFilter, string> = {
  all: '全部',
  working: 'Working',
  needs_input: 'Needs input',
  completed: 'Completed',
  failed: 'Failed',
  idle: 'Idle',
}

function deriveAllStatuses(sessions: ApiSession[], busyIds: Set<string>, notifications: { type: string; sessionId: string; timestamp: number }[]): Map<string, SessionUiStatus> {
  const map = new Map<string, SessionUiStatus>()
  for (const s of sessions) {
    const latest = notifications
      .filter(n => n.sessionId === s.id)
      .sort((a, b) => b.timestamp - a.timestamp)[0]
    map.set(
      s.id,
      deriveSessionUiStatus({
        id: s.id,
        busy: busyIds.has(s.id),
        hasPendingAction: false,
        latestNotification: latest ?? null,
      }),
    )
  }
  return map
}

function groupByDirectory(sessions: ApiSession[]): Array<{ directory: string; sessions: ApiSession[] }> {
  const groups = new Map<string, ApiSession[]>()
  for (const s of sessions) {
    const key = s.directory ? normalizeToForwardSlash(s.directory) : '(none)'
    const list = groups.get(key)
    if (list) list.push(s)
    else groups.set(key, [s])
  }
  return Array.from(groups.entries()).map(([directory, list]) => ({ directory, sessions: list }))
}

export function SessionHubPanel({
  onNewSession,
  onSelectSession,
  selectedSessionId,
  isExpanded,
  onToggleSidebar,
  onOpenSettings,
}: SessionHubPanelProps) {
  const { t } = useTranslation(['chat', 'common'])
  const { sessions, isLoading, search, setSearch, refresh } = useSessionContext()
  const busySessions = useBusySessions()
  const notifications = useNotifications()

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [filterOpen, setFilterOpen] = useState(false)
  const [groupByProject, setGroupByProject] = useState(false)
  const [bellOpen, setBellOpen] = useState(false)
  const [newDialogOpen, setNewDialogOpen] = useState(false)

  const unreadCount = useSyncExternalStore(notificationStore.subscribe, notificationStore.getUnreadCount)

  const busyIds = useMemo(() => new Set(busySessions.map(b => b.sessionId)), [busySessions])
  const statuses = useMemo(() => deriveAllStatuses(sessions, busyIds, notifications), [sessions, busyIds, notifications])

  const filtered = useMemo(() => {
    let list = sessions
    if (search) {
      const q = search.toLowerCase()
      list = list.filter(s => (s.title ?? '').toLowerCase().includes(q))
    }
    if (statusFilter !== 'all') {
      list = list.filter(s => statuses.get(s.id)?.kind === statusFilter)
    }
    return list
  }, [sessions, search, statusFilter, statuses])

  const groups = useMemo(() => groupByDirectory(filtered), [filtered])

  const handleRename = useCallback(
    async (sessionId: string, title: string) => {
      try {
        await updateSession(sessionId, { title })
        await refresh()
      } catch (e) {
        uiErrorHandler('rename session', e)
      }
    },
    [refresh],
  )

  const handleDelete = useCallback(
    async (sessionId: string) => {
      await apiDeleteSession(sessionId)
      if (selectedSessionId === sessionId) {
        onNewSession()
      }
    },
    [selectedSessionId, onNewSession],
  )

  const renderItem = (session: ApiSession) => (
    <SessionListItem
      key={session.id}
      session={session}
      isSelected={session.id === selectedSessionId}
      uiStatus={statuses.get(session.id) ?? { kind: 'idle' }}
      onSelect={onSelectSession}
      onRename={handleRename}
      onDelete={handleDelete}
    />
  )

  const showLabels = isExpanded

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="mobile-safe-topbar-14 shrink-0 flex items-center">
        <div
          className="overflow-hidden transition-[width,padding,opacity] duration-300 ease-out"
          style={{ width: showLabels ? 'auto' : 0, paddingLeft: showLabels ? 16 : 0, opacity: showLabels ? 1 : 0 }}
        >
          <a href="/" className="flex items-center whitespace-nowrap">
            <span className="text-[length:var(--fs-heading-3)] font-semibold text-text-100 tracking-tight">
              {t('header.openCode')}
            </span>
          </a>
        </div>
        <div
          className="flex-1 flex items-center transition-all duration-300 ease-out"
          style={{ justifyContent: showLabels ? 'flex-end' : 'center', paddingRight: showLabels ? 8 : 0 }}
        >
          <button
            onClick={onToggleSidebar}
            aria-label={isExpanded ? t('sidebar.collapseSidebar') : t('sidebar.expandSidebar')}
            className="h-8 w-8 flex items-center justify-center rounded-lg text-text-300 hover:text-text-100 hover:bg-bg-200 active:scale-[0.98] transition-all duration-200"
          >
            <SidebarIcon size={16} />
          </button>
        </div>
      </div>

      {/* New chat */}
      <div className="flex flex-col gap-0.5 mx-2 -mt-2.5">
        <button
          type="button"
          onClick={() => setNewDialogOpen(true)}
          aria-label={t('sidebar.newChat')}
          title="新建会话"
          className="h-8 flex items-center rounded-lg text-text-300 hover:text-text-100 hover:bg-bg-200 active:scale-[0.98] transition-all duration-300 group overflow-hidden"
          style={{ width: showLabels ? '100%' : 32, paddingLeft: 6, paddingRight: 6 }}
        >
          <span className="size-5 flex items-center justify-center shrink-0">
            <NewChatIcon size={16} />
          </span>
          <span className="ml-2 text-[length:var(--fs-base)] whitespace-nowrap transition-opacity duration-300" style={{ opacity: showLabels ? 1 : 0 }}>
            {t('sidebar.newChat')}
          </span>
        </button>

        {/* Search */}
        {showLabels ? (
          <div className="relative w-full">
            <span className="pointer-events-none absolute left-[6px] top-1/2 -translate-y-1/2 size-5 flex items-center justify-center text-text-300">
              <SearchIcon size={16} />
            </span>
            <input
              type="text"
              name="sidebar-chat-search"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={t('sidebar.searchChats')}
              aria-label={t('sidebar.searchChats')}
              autoComplete="off"
              spellCheck={false}
              className="h-8 w-full appearance-none rounded-lg border-0 bg-transparent pl-[34px] pr-[26px] text-[length:var(--fs-base)] text-text-100 shadow-none outline-none ring-0 placeholder:text-text-300 transition-shadow focus-visible:ring-1 focus-visible:ring-accent-main-100/30"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-[6px] top-1/2 flex size-[14px] -translate-y-1/2 items-center justify-center text-text-400 hover:text-text-100"
                aria-label={t('sidebar.clearSearch')}
              >
                <CloseIcon size={14} />
              </button>
            )}
          </div>
        ) : null}

        {/* Filter row */}
        <div className="flex items-center gap-1 relative">
          <button
            type="button"
            onClick={() => setFilterOpen(!filterOpen)}
            className={`h-7 px-2 rounded-md text-[length:var(--fs-xs)] transition-colors ${
              statusFilter !== 'all' ? 'text-accent-main-100' : 'text-text-400 hover:text-text-200'
            }`}
          >
            筛选{statusFilter !== 'all' ? `: ${FILTER_LABELS[statusFilter]}` : ''}
          </button>
          <button
            type="button"
            onClick={() => setGroupByProject(!groupByProject)}
            className={`h-7 px-2 rounded-md text-[length:var(--fs-xs)] transition-colors flex items-center gap-1 ${
              groupByProject ? 'text-accent-main-100' : 'text-text-400 hover:text-text-200'
            }`}
            title="按项目分组"
          >
            <CheckIcon size={12} className={groupByProject ? '' : 'opacity-0'} />
            分组
          </button>
          <button
            type="button"
            onClick={() => setBellOpen(!bellOpen)}
            className="ml-auto relative p-1 rounded-md text-text-400 hover:text-text-100"
            title="通知"
          >
            <BellIcon size={14} />
            {unreadCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 size-3.5 flex items-center justify-center rounded-full bg-accent-main-100 text-[length:var(--fs-xxs)] text-white">
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </button>

          {filterOpen && (
            <div className="absolute left-0 top-full mt-1 z-30 min-w-[140px] rounded-lg border border-border-200/60 glass-alt shadow-sm p-1 bg-bg-100">
              {(['all', 'working', 'needs_input', 'completed', 'failed', 'idle'] as StatusFilter[]).map(kind => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => {
                    setStatusFilter(kind)
                    setFilterOpen(false)
                  }}
                  className={`w-full text-left px-2 py-1 rounded-md text-[length:var(--fs-sm)] transition-colors ${
                    statusFilter === kind ? 'text-accent-main-100 bg-accent-main-100/10' : 'text-text-300 hover:text-text-100 hover:bg-bg-200/50'
                  }`}
                >
                  {FILTER_LABELS[kind]}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Bell popover: 通知历史 */}
        {bellOpen && (
          <div className="absolute right-2 top-[86px] z-30 w-64 max-h-72 overflow-y-auto custom-scrollbar rounded-lg border border-border-200/60 glass-alt shadow-sm p-1 bg-bg-100">
            {notifications.length === 0 ? (
              <div className="px-3 py-4 text-center text-[length:var(--fs-sm)] text-text-400">暂无通知</div>
            ) : (
              notifications.map(n => (
                <div key={n.id} className="px-2 py-1.5 border-b border-border-200/30 last:border-b-0">
                  <div className="text-[length:var(--fs-xs)] text-text-200 truncate">{n.title}</div>
                  <div className="text-[length:var(--fs-xxs)] text-text-400 truncate">{n.body}</div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto custom-scrollbar px-2 pb-2">
        {isLoading && sessions.length === 0 ? (
          <div className="flex h-full items-center justify-center text-text-400/70 text-[length:var(--fs-sm)]">加载中…</div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-text-400 opacity-60">
            <p className="text-[length:var(--fs-sm)]">{search ? '没有匹配的会话' : '还没有会话，点上方新建'}</p>
          </div>
        ) : groupByProject ? (
          groups.map(group => (
            <div key={group.directory} className="mt-2">
              <div className="flex items-center gap-1.5 px-2 py-1 text-[length:var(--fs-xs)] font-medium text-text-400 uppercase tracking-wider">
                <span className="truncate">{group.directory === '(none)' ? '无目录' : getDirectoryName(group.directory)}</span>
                <span className="text-text-500">· {group.sessions.length}</span>
              </div>
              <div className="space-y-0.5">{group.sessions.map(renderItem)}</div>
            </div>
          ))
        ) : (
          <div className="mt-1 space-y-0.5">{filtered.map(renderItem)}</div>
        )}
      </div>

      {/* Footer */}
      <SidebarFooter showLabels={showLabels} connectionState="connected" contextLimit={200000} onOpenSettings={onOpenSettings} />

      {/* 新建会话对话框 */}
      <NewSessionDialog
        isOpen={newDialogOpen}
        initialDirectory={getServerCwd()}
        onClose={() => setNewDialogOpen(false)}
        onCreated={() => {
          setNewDialogOpen(false)
          onNewSession()
        }}
      />
    </div>
  )
}
```

**注意**：`notificationStore.getUnreadCount` 若不存在，改为 `useSyncExternalStore(notificationStore.subscribe, () => notificationStore.getSnapshot().filter(n => !n.read).length)`。渲染前用 grep 确认：`grep -n "getUnreadCount\|markAllRead" web/src/store/notificationStore.ts`，按实际方法名调用。`SidebarFooter` 的 props 以 [SidebarFooter.tsx](web/src/features/chat/sidebar/SidebarFooter.tsx) 实际签名为准（连接状态应接 `useSessionContext` 之外的既有来源——若旧 SidePanel 用 `subscribeToConnectionState`，此处照抄该 hook 用法）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd web && npx vitest run src/features/sessions-hub/SessionHubPanel.test.tsx`
Expected: PASS（4 用例）。若 `getDirectoryName` 对 `C:\repo` 返回 `repo` 的断言不符，按实际返回值修正测试。

- [ ] **Step 5: 提交**

```bash
git add web/src/features/sessions-hub/SessionHubPanel.tsx web/src/features/sessions-hub/SessionHubPanel.test.tsx
git commit -m "feat(sessions-hub): 全局会话侧栏面板（筛选 + 分组 + 通知铃铛）"
```

---

## Task 9: 挂载点切换 + App.tsx 适配

**Files:**
- Modify: `web/src/features/chat/Sidebar.tsx`
- Modify: `web/src/App.tsx`

- [ ] **Step 1: 改 `Sidebar.tsx`**

a. 删除 import：`SidePanel`、`ProjectDialog`、`useDirectory`、`useChatViewport`（若仅 ProjectDialog 用）。`handleAddProject` / `openProjectDialog` / `closeProjectDialog` / `isProjectDialogVisible` / `projectDialogKey` 状态全部删除。

b. 三处 `<SidePanel ...>` 替换为：

```tsx
<SessionHubPanel
  onNewSession={onNewSession}
  onSelectSession={onSelectSession}
  selectedSessionId={selectedSessionId}
  isExpanded={isOpen || mobileInline}
  onToggleSidebar={handleToggle}
  onOpenSettings={onOpenSettings}
/>
```

desktop docked 分支里 `isExpanded={isOpen}`、`onToggleSidebar={handleToggle}`；mobile overlay 与 mobileInline 分支里 `isExpanded={true}`、`onToggleSidebar={onClose}`。三处各自的 `<ProjectDialog ... />` 删除。import 改为 `import { SessionHubPanel } from '../sessions-hub/SessionHubPanel'`。

- [ ] **Step 2: 改 `App.tsx`**

a. `const { currentDirectory, savedDirectories, sidebarExpanded, setSidebarExpanded } = useDirectory()` 改为：

```tsx
  const { currentDirectory, recentProjects, sidebarExpanded, setSidebarExpanded } = useDirectory()
```

b. `activeDirectories` 的 `projectDirectories` 改为：

```tsx
        projectDirectories: Object.keys(recentProjects),
```

依赖数组 `savedDirectories` → `recentProjects`。

c. `openProject` / `projectDialogOpen` / `closeProjectDialog` 状态与 `<Sidebar projectDialogOpen={...} onProjectDialogClose={...} />` 两处 props 删除；`openProject` 的注册（command palette 条目 + shortcut）改为触发新建对话框——若 `SessionHubPanel` 内部已自管对话框，这里直接删除注册即可（命令面板里「打开项目」条目删除）。`Sidebar` 组件的 `projectDialogOpen`/`onProjectDialogClose` props 从接口中删除。

- [ ] **Step 3: typecheck + 全量测试**

Run: `cd web && npm run typecheck`
Expected: 无错。

Run: `cd web && npm run test:run 2>&1 | tail -5`
Expected: 全绿（除 Task 12 待删文件的测试仍跑，此时旧组件未删所以应全过）。

- [ ] **Step 4: 提交**

```bash
git add web/src/features/chat/Sidebar.tsx web/src/App.tsx
git commit -m "feat(sessions-hub): 挂载点切换为全局会话侧栏，移除项目对话框"
```

---

## Task 10: 旧组件下游适配（WorktreePanel / ChatPane / Sidebar 残留）

**Files:**
- Modify: `web/src/components/WorktreePanel.tsx`
- Modify: `web/src/features/chat/ChatPane.tsx`
- Modify: `web/src/features/chat/sidebar/DirBrowserModal.tsx`（无改动，确认即可）

- [ ] **Step 1: 修 `WorktreePanel.tsx`**

`const { currentDirectory, addDirectory, setCurrentDirectory } = useDirectory()` 改为 `const { currentDirectory, touchDirectory, setCurrentDirectory } = useDirectory()`；`addDirectory(path)` 调用改为 `touchDirectory(path)`。

其 `listWorktrees/createWorktree/removeWorktree/resetWorktree` 来自 `../api/worktree`（已重写为 ACP）——若这些符号已不在新 API 中，改为：

```ts
import { acpExtRequest } from '../api/acpBridge'
// list: acpExtRequest('x.ai/git/worktree/list', { repo: rootDirectory })
// remove: acpExtRequest('x.ai/git/worktree/remove', { idOrPath: path, force: false, dryRun: false })
// reset: acpExtRequest('x.ai/git/worktree/apply', { worktreePath: path })  —— 以实际后端签名为准，见 worktree.rs
```

其余 UI 逻辑不动。

- [ ] **Step 2: 修 `ChatPane.tsx`**

`const { addDirectory } = useDirectory()` 改为 `const { touchDirectory } = useDirectory()`；调用处语义同改。

- [ ] **Step 3: typecheck**

Run: `cd web && npm run typecheck`
Expected: 无错（或只剩 Task 12 删除对象内部的错误——若 SidePanel 报 `savedDirectories` 不存在，正常，Task 12 删除）。

- [ ] **Step 4: 提交**

```bash
git add web/src/components/WorktreePanel.tsx web/src/features/chat/ChatPane.tsx
git commit -m "refactor: 下游组件适配 DirectoryContext 新接口"
```

---

## Task 11: 验证与冒烟

- [ ] **Step 1: 全量验证**

Run: `cd web && npm run typecheck && npm run test:run 2>&1 | tail -8 && npm run build 2>&1 | tail -5`
Expected: typecheck 无错；test:run 全绿（595+ 新用例）；build 成功。

- [ ] **Step 2: 手动冒烟（若后端可用）**

```bash
grok web --secret test-key
# 打开 http://127.0.0.1:2420/#key=test-key
```

检查：a) 侧栏显示全局会话（含其他目录的）；b) 新建 → 对话框 → 选最近目录 → 创建 → 会话出现；c) git 目录下勾选 worktree → 创建 → 会话目录是 worktree 路径；d) 状态徽章随会话运行变化；e) 分组开关、筛选、搜索、通知铃铛正常；f) 删除会话 + 删除当前会话回落空态。

- [ ] **Step 3: 提交（若冒烟中发现小修）**

```bash
git add -u && git commit -m "fix(sessions-hub): 冒烟修复"
```

---

## Task 12: 删除旧组件族

**Files（全部删除）:**
- `web/src/features/chat/sidebar/SidePanel.tsx`
- `web/src/features/chat/sidebar/FolderRecentList.tsx`（+ 同名 test 若存在）
- `web/src/features/chat/sidebar/ActiveSessionItem.tsx`
- `web/src/features/chat/sidebar/NotificationItem.tsx`
- `web/src/features/chat/sidebar/projectGrouping.ts`
- `web/src/features/chat/sidebar/activeSessionTree.ts`
- `web/src/features/chat/sidebar/activeSessionTree.test.ts`
- `web/src/features/chat/sidebar/sidebarUtils.ts`
- `web/src/features/chat/sidebar/SessionChildrenSlot.tsx`
- `web/src/features/chat/ProjectDialog.tsx`
- `web/src/features/chat/ProjectDialog.test.tsx`
- `web/src/features/sessions/SessionList.tsx`
- `web/src/features/sessions/SessionList.test.tsx`
- `web/src/features/sessions/ProjectSelector.tsx`
- `web/src/features/sessions/ProjectSelector.test.tsx`
- `web/src/features/sessions/selectionRound.ts`

保留：`web/src/features/chat/sidebar/DirBrowserModal.tsx`、`web/src/features/chat/sidebar/SidebarFooter.tsx`。

- [ ] **Step 1: 确认无引用后删除**

Run: `cd web && grep -rn "SidePanel\|FolderRecentList\|ActiveSessionItem\|NotificationItem\|projectGrouping\|activeSessionTree\|sidebarUtils\|SessionChildrenSlot\|ProjectDialog\|features/sessions\|ProjectSelector\|selectionRound" src --include="*.ts" --include="*.tsx" | grep -v "sessions-hub\|DirBrowserModal\|SidebarFooter"`

Expected: 无输出。然后 `git rm` 上述文件。

- [ ] **Step 2: typecheck + 全量测试 + build**

Run: `cd web && npm run typecheck && npm run test:run 2>&1 | tail -8 && npm run build 2>&1 | tail -5`
Expected: 全部通过（旧组件测试随文件删除而消失，总用例数略减）。

- [ ] **Step 3: 提交**

```bash
git add -A
git commit -m "refactor(sessions-hub): 删除旧 SidePanel 组件族与项目对话框"
```

---

## Task 13: i18n 键位 + 文档收尾

**Files:**
- Modify: `web/src/locales/zh-CN/chat.json`
- Modify: `web/src/locales/en/chat.json`
- Modify: `CLAUDE.md`（模块地图与缺口表更新）

- [ ] **Step 1: 把 SessionHubPanel 里的硬编码中文提到 i18n**

新增 `sessionsHub` 命名空间键（两种语言）：`newChatDialogTitle`、`workingDirectory`、`recentDirectories`、`browseFilesystem`、`runInWorktree`、`worktreeHint`、`createSession`、`creating`、`cancel`、`manualPathPlaceholder`、`confirm`、`filterAll`、`filterWorking`、`filterNeedsInput`、`filterCompleted`、`filterFailed`、`filterIdle`、`groupByProject`、`notifications`、`noNotifications`、`noSessionsYet`、`noMatches`、`untitled`、`justNow`、`minutesAgo`、`hoursAgo`、`daysAgo`、`renameSession`、`deleteSession`、`deleteConfirmBody`、`loading`。

SessionHubPanel / NewSessionDialog / SessionListItem 中对应文案改 `t('chat:sessionsHub.xxx', {...})`。

- [ ] **Step 2: 验证**

Run: `cd web && npm run typecheck && npm run test:run 2>&1 | tail -3`
Expected: 通过。

- [ ] **Step 3: 更新 CLAUDE.md**

「适配进度」表与「横向能力」表：会话管理行更新为「全局列表 + 状态徽章 + 新建对话框 + worktree 创建」✅；「6d Worktree 生命周期」改注「创建已入新建对话框，面板仍缺」。模块地图增加 `web/src/features/sessions-hub/` 一段，删除 `features/chat/sidebar/SidePanel` 相关描述。

- [ ] **Step 4: 提交**

```bash
git add web/src/locales/ web/src/features/sessions-hub/ CLAUDE.md
git commit -m "docs: sessions-hub i18n 与模块地图更新"
```

---

## Self-Review 记录

1. **Spec 覆盖**：全局列表（Task 2/8）、新建对话框（Task 6）、自动维护最近目录（Task 3）、单列表状态徽章（Task 1/7/8）、worktree 创建（Task 4/5/6）、挂载切换与删除（Task 9/12）、i18n（Task 13）。✅
2. **占位符扫描**：Task 10 的 WorktreePanel 重接写了回退方案（以 worktree.rs 实际签名为准），因其不在本次 spec 核心路径、改动面最小；其余任务无 TBD。✅
3. **类型一致性**：`createSession(title?, directory?)` 在 Task 2 定义，Task 6 测试与实现使用一致；`deriveSessionUiStatus` 输入输出在 Task 1 定义，Task 7/8 一致；`CreateIsolatedWorktreeResult { worktreePath, sessionCwd }` 在 Task 4 定义，Task 6 一致。✅
