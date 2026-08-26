import type { DayModelBreakdown } from '../../types/api/dashboard'
import { formatTokens } from '../../hooks'
import { colorForModel } from './ModelsBarChart'
import { useTranslation } from 'react-i18next'

interface ModelUsageListProps {
  days: DayModelBreakdown[]
  modelOrder: string[]
}

/** 下方模型明细列表：每个模型一行，input/output token 数 + 占比 + 色块图例 */
export function ModelUsageList({ days, modelOrder }: ModelUsageListProps) {
  const { t } = useTranslation('home')

  const totalsByModel = new Map<string, { input: number; output: number }>()
  for (const day of days) {
    for (const m of day.byModel) {
      const entry = totalsByModel.get(m.modelId) ?? { input: 0, output: 0 }
      entry.input += m.inputTokens
      entry.output += m.outputTokens
      totalsByModel.set(m.modelId, entry)
    }
  }

  const grandTotal = [...totalsByModel.values()].reduce((sum, v) => sum + v.input + v.output, 0)

  if (modelOrder.length === 0) return null

  return (
    <div className="flex flex-col gap-2">
      {modelOrder.map(modelId => {
        const totals = totalsByModel.get(modelId)
        if (!totals) return null
        const modelTotal = totals.input + totals.output
        const pct = grandTotal > 0 ? (modelTotal / grandTotal) * 100 : 0
        return (
          <div key={modelId} className="flex items-center gap-2 text-[length:var(--fs-sm)]">
            <span className={`inline-block w-2.5 h-2.5 rounded-sm shrink-0 ${colorForModel(modelId, modelOrder)}`} aria-hidden="true" />
            <span className="text-text-100 truncate">{modelId}</span>
            <span className="ml-auto text-text-400 tabular-nums shrink-0">
              {formatTokens(totals.input)} {t('in')} · {formatTokens(totals.output)} {t('out')}
            </span>
            <span className="text-text-100 tabular-nums w-14 text-right shrink-0">{pct.toFixed(1)}%</span>
          </div>
        )
      })}
    </div>
  )
}

