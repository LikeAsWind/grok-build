/**
 * grok 后端首页仪表盘统计快照的 TS 镜像。
 * 后端定义在 `crates/codegen/xai-grok-shell/src/session/usage_daily.rs`。
 * 通过 ext-request `x.ai/session_summaries/dashboard_stats` 获取。
 */
export interface DayActivity {
  /** "2026-08-24" */
  date: string
  messageCount: number
}

export interface ModelDayUsage {
  modelId: string
  inputTokens: number
  outputTokens: number
}

export interface DayModelBreakdown {
  date: string
  byModel: ModelDayUsage[]
}

export interface DashboardStats {
  totalSessions: number
  totalMessages: number
  totalTokens: number
  activeDays: number
  currentStreakDays: number
  longestStreakDays: number
  /** 0-23，本机时区；无数据时为 undefined */
  peakHour?: number
  favoriteModel?: string
  /** 最近 12 周（84 天），按天消息数 */
  heatmap: DayActivity[]
  /** 按天 × 按模型的 token 拆分，Models tab 用 */
  modelsByDay: DayModelBreakdown[]
}
