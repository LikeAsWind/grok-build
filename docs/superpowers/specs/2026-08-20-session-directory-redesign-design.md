# 会话与目录管理重构设计

日期：2026-08-20
状态：已获用户批准

## 背景与目标

当前 Web UI 的会话/目录管理体验不佳：

1. 「项目」概念模糊——三套数据（`savedDirectories` / `recentProjects` / Git worktree catalog）没有统一抽象
2. 新建会话流程割裂——必须先在下拉菜单选项目，再点「新建」
3. 会话列表按当前目录过滤——切目录 = 换一批会话，跨项目查看不便
4. 目录选择器入口深——三层菜单才能打开 `DirBrowserModal`
5. Recents / Active 双 tab 信息重复

参考 Claude Code 桌面端（2026 年 4 月重设计）的核心设计原则重构：

- **全局会话列表**：侧栏始终显示所有会话，不因目录切换而隐藏
- **多维筛选**：按状态 / 项目筛选分组，而非目录过滤
- **隐藏复杂度**：worktree 自动创建管理，用户视角只看到分支指示
- **新建对话框**：目录 / 模型 / worktree 选项集中在一个创建流程里

## 已确认的核心决策

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 组织范式 | 全局会话列表（对齐桌面端），「当前目录」退化为新建会话默认值 |
| 2 | 新建流程 | 新建对话框：目录选择（最近列表 + 浏览）+ 模型 + worktree 开关 |
| 3 | 项目列表 | 自动维护 `recentProjects`，删除手动添加/移除/拖拽排序 |
| 4 | 侧栏结构 | 单列表 + 状态徽章，删除 Active tab，通知移到铃铛弹出层 |
| 5 | 范围 | 含 worktree 创建（后端 ext 已就绪，重接前端即可） |
| 6 | 实施策略 | 方案 A：新组件族一次切换，旧 SidePanel 整体删除 |

## 关键事实（调研结论）

- 后端 worktree ext 方法齐全：`x.ai/git/worktree/{create,list,remove,show,resume_session,create_from_worktree}` + `x.ai/git/worktree/status` 进度通知（`crates/codegen/xai-grok-shell/src/extensions/worktree.rs`）
- 前端 `web/src/api/worktree.ts` 仍调用已 stub 的 `@opencode-ai/sdk`——等于死代码，需重接 ACP ext
- 会话 → 目录映射由后端 roster 持久化（每 session 带 `cwd`），前端无需额外存储
- 旧 `SidePanel.tsx` 1607 行，双 tab / 编辑模式 / 项目分组 / Global 模式状态纠缠，原地改造风险高

## 第一节：架构与数据流

**核心转变**：从「目录过滤的会话列表」变为「全局会话列表 + 会话自带目录属性」。

新组件族（`web/src/features/sessions-hub/`）：

- `SessionHubPanel.tsx` — 新侧栏：搜索 + 筛选条 + 会话列表 + 页脚
- `NewSessionDialog.tsx` — 新建对话框：目录选择 + 模型选择 + worktree 开关
- `SessionListItem.tsx` — 会话条目：标题 + 状态徽章 + 时间 + 目录标签 + hover 操作
- `SessionFilters.tsx` — 筛选栏：状态下拉 + 分组开关（按项目/平铺）

数据层改动：

- `SessionContext` 删除 `currentDirectory` 过滤逻辑，`getSessions()` 返回全量；新增 `statusFilter` / `projectGrouping` 状态
- `DirectoryContext` 删除 `savedDirectories` + 手动管理方法，保留自动维护的 `recentProjects: Record<string, number>`（路径 → 最后使用时间戳）
- `api/worktree.ts` 从 SDK stub 重接到 `acpExtRequest('x.ai/git/worktree/create', ...)`

状态徽章规范（对齐桌面端）：

| 状态 | 视觉 |
|---|---|
| Working | 蓝色，动画脉冲 |
| Needs input | 黄色 |
| Idle | 暗淡 |
| Completed | 绿色 |
| Failed | 红色 |

## 第二节：新建会话对话框与 worktree 集成

`NewSessionDialog.tsx` 结构：

```tsx
<Dialog>
  <DialogTitle>新建会话</DialogTitle>

  {/* 工作目录选择 */}
  <DirectorySelector
    recentDirs={recentProjects}  // 按时间戳排序前 5
    onSelect={setSelectedDir}
    onBrowse={() => setDirBrowserOpen(true)}  // 复用现有 DirBrowserModal
  />

  {/* Worktree 选项（Git 仓库时才显示） */}
  {isGitRepo && (
    <WorktreeToggle
      enabled={useWorktree}
      onChange={setUseWorktree}
      tooltip="在隔离的 Git worktree 中运行，不影响主代码库"
    />
  )}

  {/* 模型选择（可选，对齐 Header 现有模型选择器） */}
  <ModelSelector currentModel={model} onChange={setModel} />

  <DialogActions>
    <Button variant="ghost" onClick={onCancel}>取消</Button>
    <Button onClick={handleCreate} disabled={!selectedDir}>创建会话</Button>
  </DialogActions>
</Dialog>
```

创建逻辑：

1. 用户点「创建会话」
2. 若 `useWorktree === true` 且目录是 Git 仓库：
   - 调 `acpExtRequest('x.ai/git/worktree/create', { cwd: selectedDir, ref: 'HEAD' })`（后端返回 `{ worktreePath }` 或 `Creating` 状态）
   - 订阅 `x.ai/git/worktree/status` 进度通知，显示进度条
   - worktree 就绪后调 `createSession({ directory: worktreePath })`
3. 否则直接 `createSession({ directory: selectedDir })`
4. 创建成功后 `touchDirectory(sessionDir)` 更新最近目录

`worktree.ts` 重接 ACP：

```typescript
export async function createWorktree(cwd: string, ref: string): Promise<string> {
  const resp = await acpExtRequest('x.ai/git/worktree/create', { cwd, ref })
  if (isRecord(resp) && resp.worktreePath) return resp.worktreePath as string
  throw new Error('worktree 创建失败')
}
```

进度通知处理（acpBridge 新增）：

```typescript
case 'x.ai/git/worktree/status':
  worktreeStatusStore.update(params.sessionId, params.progress)
```

## 第三节：侧栏 UI 结构与目录持久化

`SessionHubPanel.tsx` 总体结构：

```tsx
<div className="flex flex-col h-full">
  <SidebarHeader
    onNewSession={() => setNewDialogOpen(true)}
    // 铃铛按钮：点击弹出通知历史（Popover），未读数角标；复用 notificationStore
    notificationBell
  />
  <SearchBar value={search} onChange={setSearch} />
  <SessionFilters
    statusFilter={statusFilter}
    onStatusChange={setStatusFilter}
    groupByProject={groupByProject}
    onGroupByChange={setGroupByProject}
  />
  <div className="flex-1 overflow-y-auto custom-scrollbar">
    {groupByProject ? <GroupedSessionList ... /> : <FlatSessionList ... />}
  </div>
  <SidebarFooter connectionState={connectionState} onOpenSettings={onOpenSettings} />
</div>
```

- 状态下拉：All / Working / Needs input / Idle / Completed / Failed
- 分组开关：`Ctrl+S` 或按钮切换「按项目分组」，同目录会话折叠在分组头下
- 分组头显示目录名 + 会话数，折叠状态持久化 localStorage
- 条目 hover 出现重命名 / 删除操作

### 目录持久化（两层）

1. **会话 → 目录映射**：后端 roster 持久化（session 自带 `cwd`），前端不存
2. **最近目录列表**：前端 `localStorage`（key: `grok-recent-projects`），自动维护

`DirectoryContext` 瘦身后：

```typescript
export interface DirectoryContextValue {
  recentProjects: Record<string, number>       // 路径 → 最后使用时间戳
  touchDirectory: (path: string) => void       // 创建会话成功后自动调用
  currentDirectory?: string                    // 仅供 Header 显示，不再控制过滤
  setCurrentDirectory: (dir?: string) => void
}
```

```typescript
const touchDirectory = useCallback((path: string) => {
  setRecentProjects(prev => {
    const next = { ...prev, [normalizeToForwardSlash(path)]: Date.now() }
    localStorage.setItem('grok-recent-projects', JSON.stringify(next))
    return next
  })
}, [])
```

## 第四节：改动范围与删除清单

新增（`features/sessions-hub/`）：

```
SessionHubPanel.tsx / NewSessionDialog.tsx / SessionListItem.tsx /
SessionFilters.tsx / GroupedSessionList.tsx / FlatSessionList.tsx /
DirectorySelector.tsx / WorktreeToggle.tsx / worktreeStatusStore.ts
```

修改（数据层）：

- `contexts/SessionContext.tsx` — 全局列表 + `statusFilter` / `projectGrouping`
- `contexts/DirectoryContext.tsx` — 删手动管理，保留 `recentProjects` + `touchDirectory`
- `api/worktree.ts` — 重接 ACP ext
- `api/acpBridge.ts` — 新增 `x.ai/git/worktree/status` 处理

删除（旧组件族，切换挂载点后）：

```
features/chat/sidebar/SidePanel.tsx（1607 行）
features/chat/sidebar/FolderRecentList.tsx
features/chat/sidebar/ActiveSessionItem.tsx（徽章逻辑迁移到 SessionListItem）
features/chat/sidebar/NotificationItem.tsx（通知改用铃铛弹出层）
features/chat/sidebar/projectGrouping.ts
features/chat/sidebar/activeSessionTree.ts
features/chat/sidebar/sidebarUtils.ts（部分工具迁移到 sessions-hub）
```

保留复用：`DirBrowserModal.tsx`（被 NewSessionDialog 调用）、`SidebarFooter.tsx`。

类型新增（`types/api/session.ts`）：

```typescript
export type SessionStatus = 'working' | 'needs_input' | 'idle' | 'completed' | 'failed'
```

状态数据来源（前端推断，不依赖后端新字段）：

- `working`：`activeSessionStore` 的 busySessions 包含该 session
- `needs_input`：`permission.asked` / `question.asked` 未答复（现有 `useGlobalEvents` 已路由这两类事件）
- `failed`：`session.error` 事件（notificationStore 已记录）
- `completed` / `idle`：`session.idle` 后按「最后一轮是否正常结束」区分；无信号时默认 `idle`

## 迁移路径（开发顺序）

1. 数据层先行：`SessionContext` / `DirectoryContext` / `worktree.ts` / `acpBridge`
2. 新组件族开发：先 `SessionListItem` / `NewSessionDialog`，再组装 `SessionHubPanel`
3. 临时双挂载：App 里 localStorage flag 切换新旧侧栏调试
4. 验证后切换挂载点，删除旧组件族

## 验证标准

- `npm run typecheck` 无错
- `npm run test:run` 现有 595 用例保持通过 + 新增测试（筛选逻辑 / 分组折叠 / worktree 创建流 / 目录自动维护）
- `npm run build` 生产构建成功

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| SessionContext 语义变化影响下游 | 数据层先行 + 全量测试，`useSessionContext` 消费方逐个核对 |
| worktree create 异步长耗时 | `Creating` 状态 + `x.ai/git/worktree/status` 进度条，失败可取消回退普通创建 |
| 挂载点一次切换出回归 | 临时双挂载 flag 调试期兜底，删除旧组件前全量验证 |
| 通知历史（NotificationItem）迁移遗漏 | 铃铛弹出层作为独立小组件先行实现，复用 notificationStore 不改数据层 |
