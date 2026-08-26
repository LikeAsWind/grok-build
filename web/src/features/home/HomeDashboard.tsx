import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDashboardStats } from './useDashboardStats'
import { StatCard } from './StatCard'
import { ActivityHeatmap } from './ActivityHeatmap'
import { ModelsBarChart, computeModelOrder } from './ModelsBarChart'
import { ModelUsageList } from './ModelUsageList'
import { formatTokens } from '../../hooks'
import { MessageSquareIcon } from '../../components/Icons'

type DashboardTab = 'overview' | 'models'
type TimeWindow = 'all' | '30d' | '7d'

const WINDOW_DAYS: Record<TimeWindow, number | undefined> = {
  all: undefined,
  '30d': 30,
  '7d': 7,
}

/** 《霍比特人》全书约 95,000 词，按 1 词 ≈ 1.3 token 估算，取整作为固定
 * 换算基准——纯粹的彩蛋文案常量，不是精确数据。 */
const HOBBIT_BOOK_TOKENS = 120_000

function formatHour(hour: number): string {
  const period = hour < 12 ? 'AM' : 'PM'
  const h12 = hour % 12 === 0 ? 12 : hour % 12
  return `${h12} ${period}`
}

/**
 * 无 session 时的首页仪表盘（"What's up next" 风格）。纯展示页，不带输入
 * 框——发消息/新建会话仍然只能走侧栏"新建对话"。只做用量统计；TAPD 工作台
 * 是并列的独立入口（WorkbenchPage，侧栏「工作台」进入），不再挂在这里。
 */
export function HomeDashboard() {
  const { t } = useTranslation('home')
  const [tab, setTab] = useState<DashboardTab>('overview')
  const [timeWindow, setTimeWindow] = useState<TimeWindow>('all')
  const { stats, loading, error } = useDashboardStats(WINDOW_DAYS[timeWindow])

  if (loading && !stats) {
    return (
      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-3xl mx-auto flex flex-col gap-6">
          <div className="flex items-center justify-center py-12">
            <span className="w-5 h-5 border-2 border-text-400/30 border-t-text-400 rounded-full animate-spin" />
          </div>
        </div>
      </div>
    )
  }

  if (error || !stats) {
    return (
      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-3xl mx-auto flex flex-col gap-6">
          <div className="flex items-center justify-center py-12">
            <div className="text-text-400 text-[length:var(--fs-base)]">{error?.message}</div>
          </div>
        </div>
      </div>
    )
  }

  if (stats.totalSessions === 0) {
    return (
      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-3xl mx-auto flex flex-col gap-6">
          <div className="flex items-center justify-center py-8">
            <div className="max-w-md w-full text-center">
              <div className="flex justify-center mb-6">
                <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-accent-main-100 to-accent-main-200 flex items-center justify-center">
                  <MessageSquareIcon className="w-8 h-8 text-oncolor-100" />
                </div>
              </div>
              <h2 className="text-[length:var(--fs-heading-1)] font-semibold text-text-100 mb-2">{t('emptyTitle')}</h2>
              <p className="text-[length:var(--fs-base)] text-text-400">{t('emptyDescription')}</p>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const modelOrder = computeModelOrder(stats.modelsByDay)
  const tokenMultiplier = Math.round(stats.totalTokens / HOBBIT_BOOK_TOKENS)
  const heatmapMessageCount = stats.heatmap.reduce((sum, d) => sum + d.messageCount, 0)

  return (
    <div className="flex-1 overflow-y-auto p-8">
      <div className="max-w-3xl mx-auto flex flex-col gap-6">
        <h1 className="text-[length:var(--fs-heading-1)] font-semibold text-text-100">
          <span className="mr-2">✳</span>
          {t('greeting')}
        </h1>

        <div className="rounded-xl bg-bg-100 border border-border-200/50 p-5 flex flex-col gap-5">
          {/* 贡献日历区块：始终显示固定的最近 12 周，不受下方 tab / 时间筛选影响
              （匹配 GitLab 贡献日历"永远展示固定周期"的行为）。*/}
          <div className="flex flex-col gap-2">
            <div className="text-[length:var(--fs-sm)] text-text-400">
              {t('heatmapSummary', { count: heatmapMessageCount })}
            </div>
            <ActivityHeatmap days={stats.heatmap} />
          </div>

          <div className="border-t border-border-200/50" />

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'overview'}
                onClick={() => setTab('overview')}
                className={`pb-1.5 border-b-2 text-[length:var(--fs-sm)] font-medium transition-colors ${
                  tab === 'overview' ? 'border-accent-main-100 text-text-100' : 'border-transparent text-text-400 hover:text-text-200'
                }`}
              >
                {t('overview')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'models'}
                onClick={() => setTab('models')}
                className={`pb-1.5 border-b-2 text-[length:var(--fs-sm)] font-medium transition-colors ${
                  tab === 'models' ? 'border-accent-main-100 text-text-100' : 'border-transparent text-text-400 hover:text-text-200'
                }`}
              >
                {t('models')}
              </button>
            </div>

            <div className="flex items-center gap-1 rounded-lg bg-bg-200/60 p-0.5">
              {(['all', '30d', '7d'] as const).map(w => (
                <button
                  key={w}
                  type="button"
                  onClick={() => setTimeWindow(w)}
                  className={`px-2.5 py-1 rounded-md text-[length:var(--fs-xs)] font-medium transition-colors ${
                    timeWindow === w ? 'bg-bg-000 text-text-100 shadow-sm' : 'text-text-400 hover:text-text-200'
                  }`}
                >
                  {w === 'all' ? t('all') : w}
                </button>
              ))}
            </div>
          </div>

          {tab === 'overview' ? (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatCard label={t('sessions')} value={stats.totalSessions.toString()} />
                <StatCard label={t('messages')} value={formatTokens(stats.totalMessages)} />
                <StatCard label={t('totalTokens')} value={formatTokens(stats.totalTokens)} />
                <StatCard label={t('activeDays')} value={stats.activeDays.toString()} />
                <StatCard label={t('currentStreak')} value={`${stats.currentStreakDays}d`} />
                <StatCard label={t('longestStreak')} value={`${stats.longestStreakDays}d`} />
                <StatCard label={t('peakHour')} value={stats.peakHour !== undefined ? formatHour(stats.peakHour) : '—'} />
                <StatCard label={t('favoriteModel')} value={stats.favoriteModel ?? '—'} />
              </div>

              {tokenMultiplier > 0 && (
                <div className="text-[length:var(--fs-sm)] text-text-400">
                  {t('tokenComparison', { multiplier: tokenMultiplier })}
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-col gap-4">
              <ModelsBarChart days={stats.modelsByDay} modelOrder={modelOrder} />
              <ModelUsageList days={stats.modelsByDay} modelOrder={modelOrder} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

