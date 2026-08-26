import type { DayModelBreakdown } from '../../types/api/dashboard'
import { formatTokens } from '../../hooks'

interface ModelsBarChartProps {
  days: DayModelBreakdown[]
  /** 模型顺序（按 token 总量降序），跟下方明细列表、图例保持一致 */
  modelOrder: string[]
}

/** 稳定的模型 → 颜色映射色板，模型数超出色板长度时循环使用 */
const PALETTE = [
  'bg-accent-main-100',
  'bg-blue-400',
  'bg-violet-400',
  'bg-emerald-400',
  'bg-amber-400',
  'bg-rose-400',
]

export function colorForModel(modelId: string, order: string[]): string {
  const idx = order.indexOf(modelId)
  return PALETTE[idx % PALETTE.length]
}

/** 稳定的模型顺序：按 token 总量降序 */
export function computeModelOrder(days: DayModelBreakdown[]): string[] {
  const totals = new Map<string, number>()
  for (const day of days) {
    for (const m of day.byModel) {
      totals.set(m.modelId, (totals.get(m.modelId) ?? 0) + m.inputTokens + m.outputTokens)
    }
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
}

function formatShortDate(date: string): string {
  const d = new Date(date)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/**
 * 按天堆叠柱状图：每天一根柱子，柱内按模型 token 占比堆叠着色。手写 div
 * 布局（项目未引入图表库），Y 轴只给一条参考线 + 顶部最大值标注，不追求
 * 精确坐标轴。
 */
export function ModelsBarChart({ days, modelOrder }: ModelsBarChartProps) {
  const dayTotals = days.map(day => day.byModel.reduce((sum, m) => sum + m.inputTokens + m.outputTokens, 0))
  const maxTotal = Math.max(1, ...dayTotals)

  if (days.length === 0) return null

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-end gap-1 h-40">
        <div className="flex flex-col justify-between h-full text-[length:var(--fs-xxs)] text-text-500 pr-1 shrink-0">
          <span>{formatTokens(maxTotal)}</span>
          <span>0</span>
        </div>
        <div className="flex-1 flex items-end gap-1 h-full border-l border-b border-border-200/40">
          {days.map((day, i) => {
            const total = dayTotals[i]
            const heightPct = total > 0 ? Math.max(2, (total / maxTotal) * 100) : 0
            return (
              <div key={day.date} className="flex-1 min-w-0 flex flex-col items-center justify-end h-full group">
                <div
                  className="w-full flex flex-col-reverse rounded-t-sm overflow-hidden"
                  style={{ height: `${heightPct}%` }}
                  title={`${day.date}: ${formatTokens(total)} tokens`}
                >
                  {day.byModel
                    .slice()
                    .sort((a, b) => modelOrder.indexOf(a.modelId) - modelOrder.indexOf(b.modelId))
                    .map(m => {
                      const modelTotal = m.inputTokens + m.outputTokens
                      const segPct = total > 0 ? (modelTotal / total) * 100 : 0
                      return (
                        <div
                          key={m.modelId}
                          className={colorForModel(m.modelId, modelOrder)}
                          style={{ height: `${segPct}%` }}
                        />
                      )
                    })}
                </div>
              </div>
            )
          })}
        </div>
      </div>
      <div className="flex gap-1 pl-6">
        {days.map(day => (
          <div key={day.date} className="flex-1 min-w-0 text-center text-[length:var(--fs-xxs)] text-text-500 truncate">
            {formatShortDate(day.date)}
          </div>
        ))}
      </div>
    </div>
  )
}

