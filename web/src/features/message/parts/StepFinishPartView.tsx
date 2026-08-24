import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { useTheme } from '../../../hooks/useTheme'
import type { StepFinishPart } from '../../../types/message'
import {
  formatNumber,
  formatCost,
  formatDuration,
  formatCompletedAt,
  formatDetailedDateTime,
} from '../../../utils/formatUtils'
import { InfoLine, type InfoLineItem } from './InfoLine'

interface StepFinishPartViewProps {
  part: StepFinishPart
  /** 单条消息耗时（毫秒） */
  duration?: number
  /** 整个回合总耗时（毫秒），从用户发送到最后一条 assistant 完成 */
  turnDuration?: number
  /** agent 名称（来自消息 info） */
  agent?: string
  /** model 显示名（来自消息 info） */
  modelLabel?: string
  /** 消息完成时间戳（毫秒），用于显示完成时刻 */
  completedAt?: number
}

export const StepFinishPartView = memo(function StepFinishPartView({
  part,
  duration,
  turnDuration,
  agent,
  modelLabel,
  completedAt,
}: StepFinishPartViewProps) {
  const { t } = useTranslation('message')
  const { stepFinishDisplay: show, completedAtFormat } = useTheme()
  const { tokens, cost } = part
  const totalTokens = tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
  const cacheHit = tokens.cache.read

  const items: InfoLineItem[] = []
  if (show.agent && agent) {
    items.push({ key: 'agent', content: agent, className: 'capitalize' })
  }
  if (show.model && modelLabel) {
    items.push({ key: 'model', content: modelLabel })
  }
  if (show.tokens && totalTokens > 0) {
    items.push({
      key: 'tokens',
      content: `${formatNumber(totalTokens)} ${t('tokens')}`,
      title: `${t('stepFinish.inputTokens', { input: tokens.input })}, ${t('stepFinish.outputTokens', { output: tokens.output })}, ${t('stepFinish.reasoningTokens', { reasoning: tokens.reasoning })}, ${t('stepFinish.cacheRead', { read: tokens.cache.read })}, ${t('stepFinish.cacheWrite', { write: tokens.cache.write })}`,
    })
  }
  if (show.cache && cacheHit > 0) {
    items.push({
      key: 'cache',
      content: `(${t('stepFinish.cached', { count: formatNumber(cacheHit) })})`,
      title: `${t('stepFinish.cacheRead', { read: tokens.cache.read })}, ${t('stepFinish.cacheWrite', { write: tokens.cache.write })}`,
      className: 'text-text-600',
    })
  }
  if (show.cost && cost > 0) {
    items.push({ key: 'cost', content: formatCost(cost) })
  }
  if (show.duration && duration != null && duration > 0) {
    items.push({ key: 'duration', content: formatDuration(duration) })
  }
  if (show.turnDuration && turnDuration != null && turnDuration > 0) {
    items.push({ key: 'turnDuration', content: t('stepFinish.totalDuration', { duration: formatDuration(turnDuration) }) })
  }
  if (show.completedAt && completedAt != null) {
    items.push({
      key: 'completedAt',
      content: formatCompletedAt(completedAt, completedAtFormat),
      title: formatDetailedDateTime(completedAt),
    })
  }

  return <InfoLine items={items} />
})
