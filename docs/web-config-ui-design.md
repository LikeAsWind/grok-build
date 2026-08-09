# grok Web 配置界面（表单化）设计方案

> 调研来源：`crates/codegen/xai-grok-shell/src/agent/config.rs`（主 Config）、`model_providers.rs`、
> `xai-grok-config-types/src/mcp.rs`、`config/reloader.rs`（热重载）、`xai-grok-pager/docs/user-guide/05-configuration.md`。
> config.toml 共 40+ section、300+ 配置键，完整清单见文末附录。

## 1. 设计原则：三层覆盖

配置项数量太大，全部表单化不现实也没必要。按使用频率分三层：

| 层 | 覆盖内容 | 呈现方式 |
|---|---|---|
| **表单层**（日常高频） | 模型、模型供应商、MCP 服务器、权限规则、功能开关、会话/工具常用项 | 专属表格/表单 |
| **开关矩阵层**（中频） | `[features]`、`[ui]` 的布尔/枚举项 | 自动渲染的开关列表 |
| **源码层**（100% 兜底） | 全部配置项，含表单未覆盖的 30+ 小 section | 现有 TOML 编辑器（保留） |

## 2. 页面结构

```
设置 → 高级 → 配置
┌────────────────────────────────────────────────┐
│  [表单模式 | TOML 源码]                [保存]    │
├───────────┬────────────────────────────────────┤
│ 模型       │                                    │
│ 模型供应商  │           内容区                    │
│ MCP 服务器 │   （右侧随左侧分区切换）              │
│ 权限规则   │                                    │
│ 功能开关   │                                    │
│ 会话与工具  │                                    │
│ 认证       │                                    │
│ 其他…      │  → 引导切换到 TOML 源码模式          │
└───────────┴────────────────────────────────────┘
```

每个分区标题带生效方式徽章：**🔥 保存即生效**（热重载）或 **⟳ 重启后生效**。

## 3. 各分区设计

### 3.1 模型（`[models]` + `[model.*]`）🔥热重载 —— 核心页

顶部全局项：
- **默认模型**：下拉（选项来自 ACP modelState）
- 隐藏/禁用模型：标签多选

模型表格（每行一个 `[model.<id>]`）：

| 列 | 控件 |
|---|---|
| ID（TOML 表头名，即 picker 名） | 文本 |
| 显示名 `name` | 文本 |
| API 模型名 `model` | 文本 |
| 协议 `api_backend` | 下拉：`chat_completions` / `responses`(OpenAI) / `messages`(Anthropic) |
| `base_url` | 文本（等宽） |
| 密钥 | 组合控件：直填 `api_key`（掩码●●●）或 环境变量 `env_key` |
| 上下文窗口 `context_window` | 数字 |
| 操作 | 展开 / 删除 |

行展开抽屉（高级字段）：`temperature`(0-2 滑条)、`top_p`、`max_completion_tokens`、
`model_provider`（下拉引用供应商）、`extra_headers` / `query_params` / `env_http_headers`（键值对编辑器）、
`reasoning_effort`、`hidden`、`auto_compact_threshold_percent`、`inference_idle_timeout_secs`、`max_retries`。

**「添加模型」提供预设模板**（一键填充）：
- Anthropic（messages + api.anthropic.com）
- OpenAI（responses + api.openai.com）
- Ollama 本地（chat_completions + localhost:11434）
- OpenAI 兼容自定义

### 3.2 模型供应商（`[model_providers.*]`）

表格：ID | `base_url` | 协议 | 认证（api_key 掩码 / env_key / auth 命令）| 被引用的模型（只读提示）。
展开：`extra_headers`、`query_params`、内联 `auth`（command/args/token_ttl_secs）。

### 3.3 MCP 服务器（`[mcp_servers.*]`）🔥热重载

表格：名称 | 传输类型（stdio/HTTP/SSE，按 command/url 自动判断）| command 或 url | **启用开关**（`enabled`，即时生效）| 超时。
展开：`args`（数组编辑）、`env` / `headers`（键值对）、`oauth` 子表单、`tool_timeouts`。
（与计划 Step 6 的 MCP 运行时面板互补：这里是持久配置，那边是运行状态。）

### 3.4 权限规则（`[permission]`）

三组规则列表（deny > ask > allow 优先级说明置顶）：
每组一个可增删的规则表，行格式 `Tool(pattern)`（如 `Bash(git *)`），输入框带工具名补全。

### 3.5 功能开关（`[features]` + 常用 `[ui]`）

自动渲染矩阵：bool → Switch，枚举 → Select，每项右侧一句中文说明。
重点项置顶：`support_permission`、`codebase_indexing`、`web_fetch`、`lsp_tools`、`telemetry`；
`ui.yolo`（🔥热重载）、`ui.theme`（🔥）单独标注。
内部 rollout 开关（`mcp_liveness_watchers` 等）归入"实验性"折叠区。

### 3.6 会话与工具

- `session.auto_compact_threshold_percent`（滑条 0-100，默认 85）、`session.load_envrc`
- `toolset.bash`：`timeout_secs`、`output_byte_limit`、`auto_background_on_timeout`
- `toolset.web_fetch`：`proxy_endpoint`、`allowed_domains`（标签编辑）
- `tools.respect_gitignore`

### 3.7 认证（`[auth]` / `[grok_com_config]`）

`preferred_method`（api_key/oidc）、`disable_api_key_auth`；OIDC/OAuth2 子表单归入"企业"折叠区。

## 4. 交互细节

- **敏感字段**（`api_key`、`*_token`、`events_api_key`）：掩码显示，点眼睛临时显示；表格列只显示"已设置 / env:VAR"
- **校验**：前端做范围校验（temperature 0-2、百分比 0-100、URL 格式）；后端 TOML/serde 校验错误带行号回显
- **保留注释**：表单保存走结构化 patch（见 §5），不整文件覆盖，用户手写的注释和未覆盖的 section 原样保留
- **未知 section 安全**：表单只动自己管的 section，其余内容不碰

## 5. 技术方案

### 后端（xai-grok-web，workspace 已有 `toml_edit 0.22`）

| 端点 | 用途 |
|---|---|
| `GET /config-file?format=json` | 在现有返回上附加 `parsed`（TOML→JSON），供表单渲染 |
| `PATCH /config-file` | body `{set: {"model.claude.api_key": "sk-..."}, delete: ["model.old"]}`；用 **toml_edit** 在文档树上修改后写回——**保留注释与格式**；返回校验错误 |
| 现有 `GET` / `PUT` | 保留，供 TOML 源码模式整文件读写 |

鉴权同现状（`x-server-key`）。热重载由 shell config watcher 自动完成，无需额外通知。

### 前端

- `GrokConfigSettings` 扩展为 表单模式 / 源码模式 双 tab（源码模式=现有编辑器）
- 分区表单组件按 OpenCodeUI 现有 `SettingsSection` + 表格模式实现
- 配置元数据（字段清单/类型/默认值/说明/热重载标记）集中在一个 `grokConfigSchema.ts`，渲染器数据驱动

## 6. 实施分期

| 期 | 内容 | 交付判定 |
|---|---|---|
| **P1** | 双模式框架 + PATCH 端点 + **模型 / 供应商 / MCP** 三个高频表格 | 浏览器里表单添加 Anthropic BYOK 模型 → 保存 → 模型选择器出现该模型（热重载）|
| **P2** | 功能开关矩阵 + 权限规则 + 会话与工具 + 认证 | 各分区读写往返一致，注释保留 |
| **P3** | 打磨：预设模板、供应商被引用提示、项目级配置只读视图、字段搜索 | — |

---

## 附录 A：config.toml 全量 section 清单（按重要性）

**高**（表单层）：`[models]`🔥 `[model.*]`🔥 `[model_providers.*]` `[mcp_servers.*]`🔥 `[permission]` `[auth]`
**中**（开关矩阵/次级表单）：`[features]` `[ui]`(theme/yolo🔥) `[ui.notifications]` `[session]` `[toolset.bash|web_fetch|ask_user_question]` `[tools]` `[subagents]` `[memory]`🔥 `[compaction]`🔥 `[skills]`🔥 `[plugins]` `[compat]`🔥 `[cli]` `[agent]` `[auth_provider.*]` `[shell_environment_policy]`
**低**（仅源码模式）：`[endpoints]` `[telemetry]` `[goal]` `[workflows]` `[auto_mode]` `[doom_loop_recovery]` `[worktree]` `[worktree_pool]` `[sandbox]` `[suggestions]` `[storage]` `[paths]` `[harness]` `[relay]` `[hub]` `[managed_mcps]` `[feedback]` `[diagnostics]` `[repo_changes_dedup]` `[hints]` `[privacy]` `[mcp]` `[marketplace]` `[dashboard]` `[desktop]`

🔥 = 保存后热重载（`config/reloader.rs` 监听：mcp_servers、memory+compaction、skills、compat、model/models、ui 的 theme/yolo/fork_secondary_model；其余需重启）。

**[model.*] 完整字段**：`model` `base_url` `name` `description` `api_key` `env_key` `auth_provider` `model_provider` `api_base_url` `max_completion_tokens` `temperature` `top_p` `api_backend`(chat_completions/responses/messages) `extra_headers` `query_params` `env_http_headers` `context_window` `auto_compact_threshold_percent` `system_prompt_label` `use_concise` `agent_type` `inference_idle_timeout_secs` `max_retries` `hidden` `supported_in_api` `reasoning_effort` `supports_reasoning_effort` `reasoning_efforts` `supports_backend_search` `show_model_fingerprint` `stream_tool_calls`

**[model_providers.*] 完整字段**：`base_url` `api_base_url` `env_key` `api_key` `api_backend` `extra_headers` `query_params` `env_http_headers` `auth_provider` `auth`(command/args/token_ttl_secs/timeout_secs/cwd) `context_window`

**[mcp_servers.*] 完整字段**：stdio: `command` `args` `env` `cwd`；HTTP/SSE: `url` `type` `bearer_token_env_var` `headers` `oauth_*`；通用: `enabled` `startup_timeout_sec` `tool_timeout_sec` `tool_timeouts` `expose_image_base64` `setup`

其余 section 的键级明细见调研记录（`config.rs` L1329+、各子 crate config 模块）。
