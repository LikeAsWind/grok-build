// ============================================
// grok config.toml 配置 schema —— 全量可视化的数据源
//
// 每个 section 描述其 TOML 路径、字段清单（类型/默认值/说明）与生效方式，
// ConfigSectionCard 据此自动渲染表单。字段说明用中文直写（面向中文界面）。
// 调研来源: crates/codegen/xai-grok-shell/src/agent/config.rs 及各子 crate config
// ============================================

export type ConfigFieldType =
  | 'bool'
  | 'string'
  | 'number'
  | 'enum'
  | 'stringArray'
  | 'stringMap'
  | 'numberMap'
  | 'boolMap'
  /** 模型引用：下拉列出当前可用模型 */
  | 'model'
  /** 模型引用数组 */
  | 'modelArray'
  /** 映射，值为模型引用（如 subagents.models） */
  | 'modelMap'
  /** 权限规则数组：工具下拉 + 模式输入组合出 "Tool(pattern)" */
  | 'ruleArray'

export interface ConfigFieldDef {
  key: string
  label: string
  type: ConfigFieldType
  /** enum 选项；'' 表示"默认/继承" */
  options?: string[]
  /** 展示用默认值（占位提示），不写入文件 */
  default?: string
  desc?: string
  /** 密钥类字段（掩码显示） */
  secret?: boolean
  mono?: boolean
  /** 自由输入的补全建议（datalist） */
  suggestions?: string[]
  /** bool 取反显示（如 [ui] yolo 反向呈现为"询问权限"）；default 按显示语义填写 */
  invert?: boolean
}

export type ReloadKind = 'models' | 'mcp' | 'skills'

export interface ConfigSectionDef {
  /** TOML 路径，如 'features'、'toolset.bash' */
  id: string
  title: string
  desc?: string
  /** 保存后热生效（config reload 或显式 reload 调用） */
  hot?: boolean
  /** 保存后需要触发的后端重载方法 */
  reload?: ReloadKind
  /** 保存后额外发的运行时通知（permission_mode = x.ai/yolo_mode_changed，存活会话立即生效） */
  notify?: 'permission_mode'
  fields: ConfigFieldDef[]
  /** 折叠的高级/低频字段 */
  advanced?: ConfigFieldDef[]
}

/** 动态键表（[section.<自定义名>] 形态，如 mcp_servers/auth_provider） */
export interface KeyedTableDef {
  id: string
  title: string
  desc?: string
  hot?: boolean
  reload?: ReloadKind
  idLabel: string
  fields: ConfigFieldDef[]
  advanced?: ConfigFieldDef[]
}

const b = (key: string, label: string, dflt: 'true' | 'false', desc?: string): ConfigFieldDef => ({
  key, label, type: 'bool', default: dflt, desc,
})
const s = (key: string, label: string, desc?: string, dflt?: string): ConfigFieldDef => ({
  key, label, type: 'string', desc, default: dflt,
})
const n = (key: string, label: string, dflt?: string, desc?: string): ConfigFieldDef => ({
  key, label, type: 'number', default: dflt, desc,
})
const e = (key: string, label: string, options: string[], dflt?: string, desc?: string): ConfigFieldDef => ({
  key, label, type: 'enum', options: ['', ...options], default: dflt, desc,
})
const arr = (key: string, label: string, desc?: string): ConfigFieldDef => ({
  key, label, type: 'stringArray', desc,
})
const smap = (key: string, label: string, desc?: string): ConfigFieldDef => ({
  key, label, type: 'stringMap', desc,
})

// ── 分组：分区在页面上的组织 ─────────────────────────────────────

export interface ConfigGroupDef {
  id: string
  title: string
  sections: ConfigSectionDef[]
  keyedTables?: KeyedTableDef[]
}

export const CONFIG_GROUPS: ConfigGroupDef[] = [
  {
    id: 'models',
    title: '模型',
    sections: [
      {
        id: 'models',
        title: '全局模型设置',
        desc: '模型选择与全局默认采样参数（单个模型的字段优先）',
        hot: true,
        reload: 'models',
        fields: [
          { key: 'default', label: '默认模型', type: 'model', desc: '新会话使用的模型' },
          { key: 'web_search', label: 'Web 搜索模型', type: 'model', desc: 'web_search 工具使用的模型（需支持 Responses API）' },
          { key: 'session_summary', label: '会话标题模型', type: 'model' },
          e('default_reasoning_effort', '默认推理强度', ['low', 'medium', 'high']),
          { key: 'allowed_models', label: '允许的模型（glob）', type: 'modelArray', desc: '限制可选模型；空 = 不限制' },
          { key: 'hidden_models', label: '隐藏的模型', type: 'modelArray', desc: '不进选择器，仍可 -m 使用' },
          { key: 'disabled_models', label: '禁用的模型', type: 'modelArray', desc: '从目录彻底移除' },
        ],
        advanced: [
          n('temperature', '全局温度 (0-2)'),
          n('top_p', '全局 top_p'),
          n('max_completion_tokens', '全局最大输出 tokens'),
          n('max_retries', '全局重试次数', '5'),
          n('inference_idle_timeout_secs', '流式空闲超时（秒）', '300'),
          smap('extra_headers', '全局请求头'),
        ],
      },
    ],
  },
  {
    id: 'features',
    title: '功能开关',
    sections: [
      {
        id: 'features',
        title: '功能开关',
        desc: '各项功能的总开关（🔥 保存即生效，新会话可见）',
        fields: [
          b('codebase_indexing', '代码库索引 (CodeGraph)', 'true'),
          b('web_fetch', '网页抓取工具', 'true'),
          b('web_search', '网络搜索工具 (Responses API)', 'true'),
          b('lsp_tools', 'LSP 工具', 'false'),
          b('ask_user_question', 'AI 主动提问', 'true'),
          b('session_recap', '会话回顾', 'true'),
          b('turn_summary', '回合摘要', 'true'),
          b('write_file', '文件写入工具', 'true'),
          b('auto_wake', '自动唤醒', 'true'),
          b('feedback', '反馈系统', 'false'),
          b('telemetry', '匿名遥测', 'false'),
        ],
        advanced: [
          b('voice_mode', '语音模式', 'true'),
          b('image_gen', '图片生成', 'true'),
          b('video_gen', '视频生成', 'true'),
          b('cancel_rewind', '取消回退', 'true'),
          b('backend_tools', '后端工具', 'true'),
          b('two_pass_compaction', '两遍压缩', 'false'),
          e('compaction_mode', '压缩模式', ['summary', 'transcript', 'segments']),
          e('compaction_detail', '压缩详细度', ['none', 'minimal', 'balanced', 'verbose']),
          b('non_git_warning', '非 Git 目录警告', 'false'),
          b('managed_config', '托管配置', 'true'),
          b('remote_fetch', '远程拉取（离线部署关闭）', 'true'),
          b('subagent_worktree_snapshot', '子代理 worktree 快照', 'false'),
          b('mcp_liveness_watchers', 'MCP 存活监控（实验）', 'false'),
          b('mcp_auto_restart', 'MCP 自动重启（实验）', 'false'),
          b('mcp_push_server_status', 'MCP 状态推送（实验）', 'false'),
        ],
      },
    ],
  },
  {
    id: 'session',
    title: '会话与工具',
    sections: [
      {
        id: 'session',
        title: '会话',
        fields: [
          n('auto_compact_threshold_percent', '自动压缩阈值 (%)', '85', '上下文占用达到该百分比时自动压缩'),
          b('load_envrc', '加载 .envrc 环境变量', 'true'),
        ],
      },
      {
        id: 'tools',
        title: '工具通用',
        fields: [
          b('respect_gitignore', '工具遵循 .gitignore', 'false'),
          b('disable_zdr_incompatible_tools', '禁用 ZDR 不兼容工具', 'false'),
        ],
      },
      {
        id: 'toolset.bash',
        title: 'Bash 工具',
        fields: [
          n('timeout_secs', '命令超时（秒）', '120'),
          n('output_byte_limit', '输出上限（字节）', '20000'),
          b('auto_background_on_timeout', '超时自动转后台', 'true'),
        ],
        advanced: [
          n('max_timeout_secs', '最大超时（秒）', '36000'),
          s('cmd_prefix', '命令前缀'),
          n('foreground_block_budget_ms', '前台阻塞预算（毫秒）', '15000'),
          b('allow_background_operator', '允许 & 后台运算符', 'true'),
        ],
      },
      {
        id: 'toolset.web_fetch',
        title: '网页抓取工具',
        fields: [
          s('proxy_endpoint', '出口代理 URL', '所有请求经此代理', 'https://proxy.example.com'),
          arr('allowed_domains', '允许的域名', '覆盖内置白名单；空数组 = 全部禁止'),
          b('allow_local', '允许本地地址（SSRF 风险）', 'false'),
        ],
      },
      {
        id: 'toolset.ask_user_question',
        title: '提问工具',
        fields: [
          b('timeout_enabled', '启用超时', 'true'),
          n('timeout_secs', '超时（秒）', '1800'),
        ],
      },
      {
        id: 'suggestions',
        title: '命令建议',
        fields: [
          b('enabled', '启用', 'true'),
          b('ai_enabled', 'AI 建议', 'true'),
          { key: 'ai_model', label: 'AI 建议模型', type: 'model', default: 'grok-build' },
          n('debounce_ms', '防抖（毫秒）'),
        ],
      },
    ],
  },
  {
    id: 'permission',
    title: '权限',
    sections: [
      {
        id: 'ui',
        title: '权限模式',
        desc: '工具执行的确认策略（🔥 保存立即生效，含当前会话）',
        hot: true,
        notify: 'permission_mode',
        fields: [
          {
            key: 'yolo',
            label: '工具执行前询问权限',
            type: 'bool',
            invert: true,
            default: 'true',
            desc: '关闭 = 全部自动批准（YOLO）。开启时安全命令（ls/cat 等）仍自动放行，危险/未知命令弹窗确认',
          },
          {
            key: 'remember_tool_approvals',
            label: '记住工具批准',
            type: 'bool',
            default: 'false',
            desc: '弹窗显示"总是允许 xxx"细粒度选项，批准后同命令不再询问（按工作目录记忆，新会话生效）',
          },
        ],
      },
      {
        id: 'permission',
        title: '权限规则',
        desc: '按工具+模式组合规则，如 Bash(git *)。优先级 deny > ask > allow',
        fields: [
          { key: 'deny', label: '拒绝 deny', type: 'ruleArray', desc: '匹配即拒绝，优先级最高' },
          { key: 'ask', label: '询问 ask', type: 'ruleArray', desc: '匹配时弹出确认' },
          { key: 'allow', label: '允许 allow', type: 'ruleArray', desc: '匹配即放行' },
        ],
      },
      {
        id: 'sandbox',
        title: '沙箱',
        fields: [
          e('profile', '沙箱档位', ['off', 'workspace', 'devbox', 'read-only', 'strict']),
          b('auto_allow_bash', '沙箱内自动放行 Bash', 'false'),
        ],
      },
      {
        id: 'shell_environment_policy',
        title: '子进程环境变量策略',
        fields: [
          arr('inherit', '继承的变量'),
          arr('exclude', '排除的变量'),
          arr('include_only', '仅包含的变量'),
          smap('set', '强制设置'),
          b('ignore_default_excludes', '忽略默认排除清单', 'false'),
        ],
      },
    ],
  },
  {
    id: 'auth',
    title: '认证',
    sections: [
      {
        id: 'auth',
        title: '认证',
        desc: '[auth] 与 [grok_com_config] 等价',
        fields: [
          e('preferred_method', '首选认证方式', ['api_key', 'oidc']),
          b('disable_api_key_auth', '禁用 API Key 认证', 'false'),
          s('auth_provider_command', '外部认证命令', '打印 token 到 stdout 的脚本', '/path/to/auth-script.sh'),
          n('auth_token_ttl', 'Token TTL（秒）'),
        ],
        advanced: [
          s('grok_ws_origin', 'WS Origin'),
          s('grok_ws_url', 'WS URL'),
          s('token_header', 'Token 请求头'),
          s('auth_provider_label', '认证命令显示名'),
        ],
      },
      {
        id: 'auth.oidc',
        title: 'OIDC（企业 SSO）',
        fields: [
          s('issuer', 'Issuer *', undefined),
          s('client_id', 'Client ID *'),
          arr('scopes', 'Scopes'),
          s('audience', 'Audience'),
        ],
      },
    ],
  },
  {
    id: 'agents',
    title: '子代理与记忆',
    sections: [
      {
        id: 'subagents',
        title: '子代理',
        fields: [
          b('enabled', '启用子代理', 'true'),
          n('max_depth', '最大嵌套深度', '1'),
          n('max_concurrent', '最大并发数'),
          e('limit_behavior', '超限行为', ['queue', 'fail'], 'queue'),
          { key: 'models', label: '各代理模型指定', type: 'modelMap', desc: '代理名 → 模型' },
          { key: 'toggle', label: '各代理开关', type: 'boolMap', desc: '代理名 → 是否启用' },
        ],
      },
      {
        id: 'memory',
        title: '记忆',
        hot: true,
        fields: [b('enabled', '启用记忆', 'false')],
        advanced: [
          n('gc.max_age_days', '记忆保留天数'),
          b('session.save_on_end', '会话结束时保存', 'false'),
          b('dream.enabled', '记忆整理 (dream)', 'false'),
        ],
      },
      {
        id: 'compaction.pruning',
        title: '上下文修剪',
        hot: true,
        fields: [
          b('enabled', '启用', 'false'),
          n('keep_last_n_turns', '保留最近 N 轮'),
        ],
      },
      {
        id: 'goal',
        title: 'Goal 模式 (/goal)',
        fields: [
          b('enabled', '启用', 'false'),
          n('verifier_count', '验证者数量'),
          { key: 'planner_model', label: '规划模型', type: 'model' },
          { key: 'skeptic_models', label: '质疑者模型', type: 'modelArray' },
        ],
      },
    ],
  },
  {
    id: 'extensions',
    title: '扩展',
    sections: [
      {
        id: 'skills',
        title: 'Skills',
        hot: true,
        reload: 'skills',
        fields: [
          arr('paths', '额外扫描目录', '支持 ~'),
          arr('ignore', '排除路径'),
          arr('disabled', '禁用的 skill'),
        ],
      },
      {
        id: 'plugins',
        title: '插件',
        fields: [
          arr('paths', '额外插件目录'),
          arr('disabled', '禁用的插件 ID'),
          arr('enabled', '启用的项目级插件'),
        ],
      },
      {
        id: 'compat',
        title: '厂商兼容发现',
        desc: '发现 Claude / Cursor / Codex 的 skills、rules、MCP 等',
        hot: true,
        fields: [
          b('claude.skills', 'Claude: skills', 'true'),
          b('claude.rules', 'Claude: rules', 'true'),
          b('claude.agents', 'Claude: agents', 'true'),
          b('claude.mcps', 'Claude: MCP', 'true'),
          b('claude.hooks', 'Claude: hooks', 'true'),
          b('cursor.skills', 'Cursor: skills', 'true'),
          b('cursor.rules', 'Cursor: rules', 'true'),
          b('cursor.mcps', 'Cursor: MCP', 'true'),
          b('codex.sessions', 'Codex: sessions', 'true'),
        ],
      },
      {
        id: 'mcp',
        title: 'MCP 通用',
        fields: [n('max_output_bytes', '工具结果截断上限（字节）')],
      },
      {
        id: 'managed_mcps',
        title: '托管 MCP 连接器',
        fields: [
          b('enabled', '启用', 'true'),
          b('gateway_tools_enabled', '网关工具', 'false'),
        ],
      },
    ],
  },
  {
    id: 'system',
    title: '系统',
    sections: [
      {
        id: 'cli',
        title: 'CLI',
        fields: [
          b('auto_update', '启动时检查更新', 'true'),
          b('show_tips', '显示提示', 'true'),
          e('channel', '更新渠道', ['stable', 'nightly']),
        ],
        advanced: [
          s('npm_registry', 'npm 镜像源'),
          s('minimum_version', '最低版本（软）'),
          s('required_minimum_version', '最低版本（硬，启动拒绝）'),
          b('session_registry', '会话注册表', 'false'),
        ],
      },
      {
        id: 'storage',
        title: '存储',
        fields: [n('cleanup_ttl_days', '会话清理 TTL（天）', '30')],
      },
      {
        id: 'worktree.auto_gc',
        title: 'Worktree 自动回收',
        fields: [
          b('enabled', '启用', 'false'),
          n('max_age_secs', '最大保留（秒）'),
          b('dry_run', '仅演练', 'false'),
        ],
      },
      {
        id: 'doom_loop_recovery',
        title: '死循环恢复',
        fields: [
          b('enabled', '启用', 'true'),
          n('max_threshold', '判定阈值', '8'),
          n('max_retries', '恢复重试', '2'),
        ],
      },
      {
        id: 'telemetry',
        title: '遥测',
        desc: '真开关在「功能开关 → 匿名遥测」；此处配置目的地',
        fields: [
          s('events_url', '事件收集 URL', undefined, 'https://example.com/events'),
          { key: 'events_api_key', label: '事件 API Key', type: 'string', secret: true },
          b('otel_enabled', 'OpenTelemetry', 'false'),
          s('otel_endpoint', 'OTEL Endpoint', undefined, 'http://localhost:4318'),
          e('otel_protocol', 'OTEL 协议', ['http/protobuf', 'grpc']),
        ],
      },
      {
        id: 'endpoints',
        title: '端点（企业/内部）',
        fields: [
          s('models_base_url', '自定义模型目录 base URL', undefined, 'https://api.acme.com/v1'),
          s('cli_chat_proxy_base_url', 'Chat 代理 base URL', undefined, 'https://proxy.example.com/v1'),
          s('xai_api_base_url', 'xAI API base URL', undefined, 'https://api.x.ai/v1'),
          s('managed_config_url', '托管配置 URL', undefined, 'https://example.com/managed.toml'),
        ],
      },
      {
        id: 'diagnostics',
        title: '诊断',
        fields: [b('crash_handler', '崩溃处理器', 'true')],
      },
      {
        id: 'workflows',
        title: '工作流',
        fields: [b('enabled', '启用后台工作流', 'true')],
      },
      {
        id: 'relay',
        title: '会话中继',
        fields: [b('enabled', '启用', 'false'), ],
      },
      {
        id: 'hub',
        title: 'Computer Hub',
        fields: [s('url', 'Hub 地址', 'ws:// 或 wss://', 'wss://hub.example.com')],
      },
    ],
  },
  {
    id: 'tapd',
    title: 'TAPD 工作台',
    sections: [
      {
        id: 'tapd',
        title: 'TAPD 凭据与同步',
        desc: '工作台按目录关联的 TAPD 项目从这里读取凭据；项目绑定在下方「TAPD 项目绑定」管理',
        fields: [
          b('enabled', '启用自动同步', 'true', '关闭后仅能手动触发同步'),
          e('auth_method', '认证方式', ['token', 'basic'], 'token'),
          { key: 'access_token', label: 'Access Token', type: 'string', secret: true, desc: 'auth_method = token 时使用' },
          s('api_user', 'API 用户名', 'auth_method = basic 时使用'),
          { key: 'api_password', label: 'API 密码', type: 'string', secret: true, desc: 'auth_method = basic 时使用' },
          s('api_base_url', 'API Base URL', undefined, 'https://api.tapd.cn'),
          s('default_workspace_id', '默认 Workspace ID', '未显式配置 [tapd.projects.*] 的目录使用此 workspace'),
          n('poll_interval_secs', '自动同步间隔（秒）', '600', '默认 10 分钟；项目可各自覆盖'),
        ],
      },
    ],
  },
  {
    id: 'workbench',
    title: 'TAPD 工作台工作流',
    sections: [
      {
        id: 'workbench',
        title: '工作台开关',
        desc: '将 Pending 状态的 TAPD 任务自动推进到 GitLab MR；关闭后只走原有同步流程',
        fields: [
          b('enabled', '启用', 'false', '关闭后只走原有 TAPD 同步流程；开启后会把 Pending 任务自动推进'),
          b('keep_stage_files_after_done', '保留阶段文件', 'false', '默认完成后删除 .workbench/'),
          n('worktree_gc_delay_secs', 'Worktree 清理延迟（秒）', '300', '完成后多久清理工作目录'),
        ],
      },
    ],
  },
  {
    id: 'gitlab',
    title: 'GitLab MR 提交',
    sections: [
      {
        id: 'gitlab',
        title: 'GitLab 连接',
        desc: 'Token 读取自环境变量（不在配置中存储）',
        fields: [
          s('url', 'GitLab URL', undefined, 'https://gitlab.example.com'),
          s('token_env', 'Token 环境变量名', undefined, 'GITLAB_TOKEN'),
          b('default_assignees_self', '创建者自动成为 Assignee', 'false'),
        ],
      },
    ],
  },
]

// ── 动态键表（[section.<自定义名>]）─────────────────────────────

export const KEYED_TABLES: KeyedTableDef[] = [
  {
    id: 'mcp_servers',
    title: 'MCP 服务器',
    desc: 'stdio 填命令；HTTP/SSE 填 URL。保存即热重载',
    hot: true,
    reload: 'mcp',
    idLabel: '服务器名称',
    fields: [
      s('command', '命令（stdio）', undefined, 'npx'),
      arr('args', '参数'),
      s('url', 'URL（HTTP/SSE）', undefined, 'https://mcp.example.com/mcp'),
      b('enabled', '启用', 'true'),
      smap('env', '环境变量'),
    ],
    advanced: [
      s('cwd', '工作目录'),
      smap('headers', '请求头'),
      s('bearer_token_env_var', 'Bearer Token 环境变量'),
      n('startup_timeout_sec', '启动超时（秒）', '30'),
      n('tool_timeout_sec', '工具超时（秒）', '6000'),
      { key: 'tool_timeouts', label: '各工具超时（秒）', type: 'numberMap' },
      e('type', '强制传输类型', ['sse']),
    ],
  },
  {
    id: 'auth_provider',
    title: '凭据助手',
    desc: '外部命令按需产出 token（[auth_provider.<名>]），模型用 auth_provider 字段引用',
    idLabel: '助手名称',
    fields: [
      s('command', '命令 *', undefined, '/path/to/token-helper.sh'),
      arr('args', '参数'),
      n('token_ttl_secs', 'Token TTL（秒）'),
      n('timeout_secs', '超时（秒）', '30'),
      s('cwd', '工作目录', '支持 ~'),
    ],
  },
  {
    id: 'tapd.projects',
    title: 'TAPD 项目绑定',
    desc: '按对话目录关联 TAPD 项目（workspace_id）；工作台据此展示对应项目的任务',
    idLabel: '绑定名称',
    fields: [
      s('directory', '工作目录 *', '绝对路径', '/path/to/project'),
      s('workspace_id', 'TAPD Workspace ID *', undefined, '12345'),
      arr('entity_types', '同步的实体类型', '留空默认仅同步 story；可填 story/task/bug'),
      arr('module_filter', '模块筛选', '留空 = 不筛选模块'),
      n('poll_interval_override_secs', '同步间隔覆盖（秒）', undefined, '0 或留空 = 使用全局默认间隔'),
      b('enabled', '启用', 'true'),
    ],
  },
]

/** 表单未覆盖、按原样保留的 section（渲染只读卡片提示） */
export const OPAQUE_SECTIONS = new Set([
  'marketplace', 'desktop', 'dashboard', 'tips', 'announcements', 'campaigns',
  'slash_command_tags', 'version_overrides', 'hints', 'privacy', 'feedback',
  'harness', 'paths', 'repo_changes_dedup', 'worktree_pool', 'auto_mode',
  'agent', 'disabled_mcp_servers', 'disabled_mcp_tools',
])

/** 已被 schema 覆盖的顶层 section 名（其余视为未知/只读） */
export function coveredTopLevelSections(): Set<string> {
  const covered = new Set<string>()
  for (const group of CONFIG_GROUPS) {
    for (const section of group.sections) covered.add(section.id.split('.')[0])
  }
  for (const table of KEYED_TABLES) covered.add(table.id)
  covered.add('model')
  covered.add('model_providers')
  covered.add('grok_com_config')
  return covered
}

