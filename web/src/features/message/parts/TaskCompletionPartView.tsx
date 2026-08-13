import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { TerminalIcon, ChevronDownIcon } from '../../../components/Icons'
import { useDisclosureScrollLock } from '../../../hooks'
import type { TaskCompletionPart } from '../../../types/message'
import { useUiDisclosureState } from '../../../utils/uiDisclosureState'
import { formatTime, formatDetailedDateTime } from '../../../utils/formatUtils'
import { chevronClass, MessageExpandPanel, useMessageExpandRender } from '../messageExpand'

// ============================================
// Task Completion Part View - 后台任务完成通知（独立系统消息卡片）
// ============================================

/** 展开体 output 渲染上限，防巨输出卡顿（后端另有 truncated/output_file 兜底） */
const OUTPUT_RENDER_LIMIT = 32 * 1024

interface TaskCompletionPartViewProps {
  part: TaskCompletionPart
}

export const TaskCompletionPartView = memo(function TaskCompletionPartView({ part }: TaskCompletionPartViewProps) {
  const { t } = useTranslation('message')
  const [expanded, setExpanded] = useUiDisclosureState(`message:${part.messageID}:taskdone:${part.id}`, false)
  const shouldRenderBody = useMessageExpandRender(expanded)
  const { rootRef, headerRef, withScrollLock } = useDisclosureScrollLock()
  const { ok, command, displayCommand, cwd, exitCode, signal, output, outputFile, truncated, endTime } = part

  const commandLine = (displayCommand || command).split('\n')[0]
  const statusBadge = signal
    ? t('taskNotification.signal', { signal })
    : exitCode !== undefined
      ? t('taskNotification.exit', { code: exitCode })
      : undefined
  const accent = ok ? 'text-success-100' : 'text-danger-100'
  const renderedOutput = output && output.length > OUTPUT_RENDER_LIMIT ? output.slice(0, OUTPUT_RENDER_LIMIT) : output

  return (
    <div ref={rootRef} className={`rounded-md border overflow-hidden ${ok ? 'border-border-200/60 bg-bg-100/50' : 'border-danger-100/30 bg-danger-100/5'}`}>
      <button
        type="button"
        ref={headerRef}
        onClick={() => withScrollLock(() => setExpanded(!expanded))}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left bg-transparent border-none hover:bg-bg-200/30 transition-colors"
      >
        <TerminalIcon className={`w-4 h-4 flex-shrink-0 ${accent}`} />
        <div className="flex-1 min-w-0 flex items-baseline gap-2">
          <span className={`text-[length:var(--fs-base)] flex-shrink-0 ${accent}`}>
            {ok ? t('taskNotification.completedTitle') : t('taskNotification.failedTitle')}
          </span>
          {commandLine && (
            <span className="text-[length:var(--fs-sm)] text-text-300 font-mono truncate">{commandLine}</span>
          )}
        </div>
        {statusBadge && (
          <span className={`text-[length:var(--fs-xxs)] flex-shrink-0 px-1.5 py-0.5 rounded ${ok ? 'text-text-500 bg-bg-200/60' : 'text-danger-100/80 bg-danger-100/10'}`}>
            {statusBadge}
          </span>
        )}
        <span
          className="text-[length:var(--fs-sm)] text-text-500 flex-shrink-0"
          title={formatDetailedDateTime(endTime)}
        >
          {formatTime(endTime)}
        </span>
        <ChevronDownIcon className={chevronClass(expanded)} />
      </button>

      <MessageExpandPanel open={expanded} variant="fade" innerClassName="overflow-hidden">
        {shouldRenderBody && (
          <div className="px-3 py-2 border-t border-border-200/40 space-y-2">
            {cwd && (
              <p className="text-[length:var(--fs-xs)] text-text-500 font-mono truncate">{cwd}</p>
            )}
            {renderedOutput ? (
              <pre className="text-[length:var(--fs-sm)] text-text-300 font-mono whitespace-pre-wrap break-words overflow-x-hidden max-h-96 overflow-y-auto">
                {renderedOutput}
              </pre>
            ) : (
              <p className="text-[length:var(--fs-sm)] text-text-500">{t('taskNotification.noOutput')}</p>
            )}
            {truncated && outputFile && (
              <p className="text-[length:var(--fs-xxs)] text-text-500">
                {t('taskNotification.truncated', { file: outputFile })}
              </p>
            )}
          </div>
        )}
      </MessageExpandPanel>
    </div>
  )
})
