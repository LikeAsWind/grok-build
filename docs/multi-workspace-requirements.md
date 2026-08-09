# Multi-Workspace 编排 — 需求记录

> **状态**：需求探索阶段（pre-design）。本文档只记录"我们要什么"，不写"怎么实现"。
> 设计阶段另起 `multi-workspace-design.md`。

## 1. Goal

让 `grok web` 支持**多项目并行**：同时跑多个独立 workspace，每个 workspace 有自己的
工作目录、配置文件、模型、API key；前端可以在它们之间切换。

**当前架构**（参考）：
- `grok web` 单进程，端口 2420
- 单 `AgentConfig` = 单 cwd + 单 `~/.grok/config.toml`
- ACP server 复用 `xai-grok-shell::agent::server`
- 前端 `web/src/store/serverStore.ts` 已支持多 `ServerConfig` 列表（多 backend 场景）

## 2. 已确定的需求（4 问 4 答）

### 2.1 Workspace 定位 — 多项目并行

- ✅ 同时跑多个项目，每个 workspace = 独立 cwd + 独立 config.toml + 独立 API key
- ✅ 切换 = 换 context，不重启进程（router 视角）
- 适用场景：项目 A 在 `~/work/alpha`（用 Opus 4.8）+ 项目 B 在 `~/work/beta`（用 Sonnet 5）

### 2.2 进程管理 — Router 统一管理

- ✅ 新增 `grok workspace` 子命令（up / down / list / show / add / remove）
- ✅ Router 进程负责拉起 / 杀掉 / 监控 workspace 子进程
- ✅ 子进程崩溃可见（router 维护状态）
- 可选：崩溃自恢复（CLI flag，默认 off）

### 2.3 前端 UX — 复用 serverStore

- ✅ Router 暴露 `GET /api/workspaces` 返回 workspace 列表（结构契合现有 `ServerConfig`）
- ✅ 前端启动时拉取，填入 serverStore
- ✅ 切换 = 现有 server 切换逻辑（WS 重连等基础设施复用）
- ✅ 现有 OpenCodeUI 的"服务器切换" UI 组件直接复用

### 2.4 定义存储 — TOML + CLI + UI 三处可改

- ✅ 主存储 `~/.grok/workspaces.toml`
- ✅ 三个入口都能改：
  - CLI: `grok workspace add/remove`
  - Router HTTP API: `POST /api/workspaces` 等
  - 未来 UI 面板
- ✅ TOML 是单一真源（single source of truth）

## 3. 待定 / 默认决策（5 问，只取默认）

| 问题 | 默认 | 备注 |
|---|---|---|
| 资源限制 | 无上限 | 用户自己管内存 |
| 端口分配 | router 自动分配，持久化回 TOML | 避免冲突 |
| 前端切换 | 单 tab 单 workspace，多 tab 多开 | 跟 OpenCodeUI 现有体验一致 |
| 进程隔离 | 已隔离（独立进程） | — |
| Router 退出 | **不**自动 kill 子进程 | 留子进程活着，重启 router 后可 track 回 |

> 注：这些是**默认**，后续设计阶段如被推翻，需要单独标注。

## 4. 暂不设计的内容

- workspace 启动顺序 / 依赖关系
- 跨 workspace 的 session 共享机制
- workspace 配额（CPU / 内存 / 网络）
- workspace 级别权限隔离
- 远程 workspace（多机器）
- workspace 模板 / 快照
- 嵌套 / 父子 workspace

如未来需要，回头补到需求里。

## 5. 业务约束

- GPL-3.0（前端 OpenCodeUI 派生）
- 后端走 Rust + axum + tokio
- 不引入 Docker（旧的 `web/src-router/` 已删，不可复活）
- router 复用 `xai-grok-web` crate（meta UI 用 rust-embed）
- 端口：router 固定 2420；workspace 端口 2421+ 自动分配

## 6. 验收标准（v1）

- [ ] `grok workspace add alpha --cwd ~/work/alpha` 创建定义
- [ ] `grok workspace up alpha` 启动子进程，分配端口
- [ ] router `GET /api/workspaces` 返回 alpha 的 url + secret
- [ ] 前端能列出 alpha 且连接到 `http://127.0.0.1:2421/?server-key=<secret>`
- [ ] `grok workspace down alpha` 杀掉子进程，端口释放
- [ ] `grok workspace list` 显示所有 workspace 状态（Running / Stopped / Crashed）
- [ ] `grok workspace remove alpha` 从 TOML 删除
- [ ] router 重启后能 track 回之前留下的子进程（按 PID 看是否还活着）

## 7. 待办

- [ ] 设计阶段：写 `multi-workspace-design.md`（架构 / crate 拆分 / 协议 / 错误处理 / 测试）
- [ ] 决策点：是否拆分 `xai-grok-router` 独立 crate
- [ ] 决策点：meta UI 是否复用 OpenCodeUI 还是独立写
- [ ] 决策点：崩溃自恢复的 CLI flag 开关
