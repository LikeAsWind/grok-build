import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { DayActivity } from '../../types/api/dashboard'

interface ActivityHeatmapProps {
  days: DayActivity[]
}

/** 4 档深浅（不含 0），第 0 档留给"当天无消息"的空格子 */
const LEVEL_CLASSES = ['bg-bg-300', 'bg-accent-main-100/30', 'bg-accent-main-100/55', 'bg-accent-main-100/80', 'bg-accent-main-100']

/** 只在这几行画星期标签，避免 7 行全标注造成拥挤（GitHub/GitLab 的既定惯例） */
const WEEKDAY_LABEL_ROWS = new Set([1, 3, 5])

function levelFor(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0
  const ratio = count / max
  if (ratio > 0.75) return 4
  if (ratio > 0.5) return 3
  if (ratio > 0.25) return 2
  return 1
}

function formatMonthLabel(date: string): string {
  return new Date(date).toLocaleDateString(undefined, { month: 'short' })
}

function formatFullDate(date: string): string {
  return new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

/** 2023-01-01 是周日，用作稳定的一周起点算短星期名（跟随浏览器 locale） */
function weekdayLabel(dow: number): string {
  return new Date(2023, 0, 1 + dow).toLocaleDateString(undefined, { weekday: 'short' })
}

/**
 * 53 周 × 7 天活跃度热力图（跨度一整年），按 `messageCount` 分档着色。纯
 * div 网格实现（项目未引入图表库），布局参照 GitLab 贡献日历：顶部月份
 * 标签、左侧星期标签（Mon/Wed/Fri）、右下角色块图例 + 说明文案、自定义
 * hover tooltip。格子用 8px（比 GitLab 略小）以便一整年在仪表盘宽度内
 * 不横向溢出。
 */
export function ActivityHeatmap({ days }: ActivityHeatmapProps) {
  const { t } = useTranslation('home')
  const [hovered, setHovered] = useState<DayActivity | null>(null)
  const max = days.reduce((m, d) => Math.max(m, d.messageCount), 0)

  // days 是最近一年，按日期升序；补齐到完整周（从周日开始）方便按列渲染。
  const firstDate = days[0] ? new Date(days[0].date) : new Date()
  const leadingBlankDays = firstDate.getDay()
  const cells: Array<DayActivity | null> = [
    ...Array.from({ length: leadingBlankDays }, () => null),
    ...days,
  ]
  const weekCount = Math.ceil(cells.length / 7)

  let lastMonthLabel = ''

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-0.5">
        <div className="w-6 shrink-0" />
        <div className="flex gap-0.5">
          {Array.from({ length: weekCount }, (_, week) => {
            const firstCell = cells[week * 7]
            const label = firstCell ? formatMonthLabel(firstCell.date) : ''
            const show = label !== '' && label !== lastMonthLabel
            if (show) lastMonthLabel = label
            return (
              <div key={week} className="w-2 shrink-0 text-[length:var(--fs-xxs)] text-text-500 whitespace-nowrap">
                {show ? label : ''}
              </div>
            )
          })}
        </div>
      </div>

      <div className="flex gap-0.5">
        <div className="flex flex-col gap-0.5 w-6 shrink-0">
          {Array.from({ length: 7 }, (_, dow) => (
            <div key={dow} className="h-2 text-[length:var(--fs-xxs)] text-text-500 leading-none">
              {WEEKDAY_LABEL_ROWS.has(dow) ? weekdayLabel(dow) : ''}
            </div>
          ))}
        </div>

        <div className="flex gap-0.5" role="img" aria-label="activity heatmap">
          {Array.from({ length: weekCount }, (_, week) => (
            <div key={week} className="flex flex-col gap-0.5">
              {Array.from({ length: 7 }, (_, dow) => {
                const cell = cells[week * 7 + dow]
                if (!cell) return <div key={dow} className="w-2 h-2" />
                const level = levelFor(cell.messageCount, max)
                return (
                  <div
                    key={dow}
                    data-date={cell.date}
                    className={`relative w-2 h-2 rounded-sm ${LEVEL_CLASSES[level]}`}
                    onMouseEnter={() => setHovered(cell)}
                    onMouseLeave={() => setHovered(null)}
                  >
                    {hovered === cell && (
                      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 whitespace-nowrap rounded-md bg-bg-000 border border-border-200 px-2 py-1 text-[length:var(--fs-xxs)] text-text-100 shadow-md z-10">
                        {t('heatmapTooltip', { count: cell.messageCount, date: formatFullDate(cell.date) })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 pt-1">
        <div className="flex gap-0.5">
          {LEVEL_CLASSES.map(cls => (
            <span key={cls} className={`w-2 h-2 rounded-sm ${cls}`} />
          ))}
        </div>
        <span className="text-[length:var(--fs-xxs)] text-text-500">{t('heatmapCaption')}</span>
      </div>
    </div>
  )
}
