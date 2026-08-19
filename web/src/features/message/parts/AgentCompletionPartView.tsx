import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { AgentIcon, ChevronDownIcon } from '../../../components/Icons'
import { MarkdownRenderer } from '../../../components/MarkdownRenderer'
import { useDisclosureScrollLock } from '../../../hooks'
import type { AgentCompletionPart } from '../../../types/message'
import { useUiDisclosureState } from '../../../utils/uiDisclosureState'
import { formatTime, formatDetailedDateTime, formatDuration } from '../../../utils/formatUtils'
import { chevronClass, MessageExpandPanel, useMessageExpandRender } from '../messageExpand'

// ============================================
// Agent Completion Part View - 后台子 agent 完成通知（独立系统消息卡片）
// output 用 markdown 渲染（支持图片内联）；唤醒回复是紧随其后的独立 assistant 消息
// ============================================

/** 展开体 output 渲染上限，防巨输出卡顿 */
const OUTPUT_RENDER_LIMIT = 32 * 1024

interface AgentCompletionPartViewProps {
  part: AgentCompletionPart
}

export const AgentCompletionPartView = memo(function AgentCompletionPartView({ part }: AgentCompletionPartViewProps) {
  const { t } = useTranslation('message')
  const [expanded, setExpanded] = useUiDisclosureState(`message:${part.messageID}:agentdone:${part.id}`, false)
  const shouldRenderBody = useMessageExpandRender(expanded)
  const { rootRef, headerRef, withScrollLock } = useDisclosureScrollLock()
  const { ok, command, description, agentType, output, receivedAt } = part

  const headline = description || command
  const accent = ok ? 'text-success-100' : 'text-danger-100'
  const renderedOutput = output && output.length > OUTPUT_RENDER_LIMIT ? output.slice(0, OUTPUT_RENDER_LIMIT) : output
  const durationLabel = part.durationMs !== undefined ? t('stepFinish.totalDuration', { duration: formatDuration(part.durationMs) }) : undefined
  const stats: string[] = []
  if (part.turns !== undefined) stats.push(t('agentNotification.turns', { count: part.turns }))
  if (part.toolCalls !== undefined) stats.push(t('agentNotification.tools', { count: part.toolCalls }))

  return (
    <div>
      <div ref={rootRef} className={`rounded-md border overflow-hidden ${ok ? 'border-border-200/60 bg-bg-100/50' : 'border-danger-100/30 bg-danger-100/5'}`}>
      <button
        type="button"
        ref={headerRef}
        onClick={() => withScrollLock(() => setExpanded(!expanded))}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left bg-transparent border-none hover:bg-bg-200/30 transition-colors"
      >
        <AgentIcon className={`w-4 h-4 flex-shrink-0 ${accent}`} />
        <div className="flex-1 min-w-0 flex items-baseline gap-2">
          <span className={`text-[length:var(--fs-base)] flex-shrink-0 ${accent}`}>
            {ok ? t('agentNotification.completedTitle') : t('agentNotification.failedTitle')}
          </span>
          {headline && (
            <span className="text-[length:var(--fs-sm)] text-text-300 truncate">{headline}</span>
          )}
        </div>
        {agentType && (
          <span className="text-[length:var(--fs-xxs)] flex-shrink-0 px-1.5 py-0.5 rounded text-text-500 bg-bg-200/60">
            {agentType}
          </span>
        )}
        <span
          className="text-[length:var(--fs-sm)] text-text-500 flex-shrink-0"
          title={formatDetailedDateTime(receivedAt)}
        >
          {formatTime(receivedAt)}
        </span>
        <ChevronDownIcon className={chevronClass(expanded)} />
      </button>

      <MessageExpandPanel open={expanded} variant="fade" innerClassName="overflow-hidden">
        {shouldRenderBody && (
          <div className="px-3 py-2 border-t border-border-200/40 space-y-2">
            {renderedOutput ? (
              <MarkdownRenderer content={renderedOutput} />
            ) : (
              <p className="text-[length:var(--fs-sm)] text-text-500">{t('agentNotification.noOutput')}</p>
            )}
            {stats.length > 0 && (
              <p className="text-[length:var(--fs-xs)] text-text-500">
                {stats.join(' · ')}
              </p>
            )}
          </div>
        )}
      </MessageExpandPanel>
      </div>
      {durationLabel && (
        <div className="flex items-center gap-3 py-0.5 text-[length:var(--fs-xxs)] text-text-500">
          <span title={formatDetailedDateTime(receivedAt)}>{durationLabel}</span>
        </div>
      )}
    </div>
  )
})