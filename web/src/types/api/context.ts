/**
 * grok 后端 `ContextInfo` 快照的 TS 镜像。
 * 后端定义在 `crates/codegen/xai-grok-shell/src/session/acp_types.rs`。
 * 通过 ext-request `x.ai/session/info` 获取。
 */
export interface TokenUsageCategory {
  /** 显示标签，如 "Skills" 或 "MCP servers" */
  label: string
  /** 该类目占用的估算 token */
  tokens: number
  /** 简短附加信息，如 "21 skills" / "3 servers" */
  detail?: string
}

export interface ContextInfo {
  used: number
  total: number
  systemPromptTokens: number
  toolDefinitionsCount: number
  toolDefinitionsTokens: number
  compactionCount: number
  turnCount: number
  toolCallCount: number
  messageCount: number
  messageTokens: number
  freeTokens: number
  usagePct: number
  /** 后端 6-tier 解析后的自动压缩阈值百分比 */
  autoCompactThresholdPercent: number
  /** 分类明细（技能、MCP 服务器） */
  usageCategories: TokenUsageCategory[]
  /** 启动阶段耗时（毫秒）；`undefined` 表示尚未捕获或仍在加载 */
  skillDiscoveryElapsedMs?: number
  systemPromptBuildElapsedMs?: number
  toolRegistryPrepElapsedMs?: number
  mcpStartupElapsedMs?: number
  /** 当前会话实际生效的完整系统提示词文本；会话尚未初始化时为 `undefined` */
  systemPrompt?: string
}
