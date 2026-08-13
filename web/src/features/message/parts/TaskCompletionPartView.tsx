import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { TerminalIcon, ChevronDownIcon } from '../../../components/Icons'
import { MarkdownRenderer } from '../../../components/MarkdownRenderer'
import { useDisclosureScrollLock } from '../../../hooks'
import type { TaskCompletionPart, TaskWakeSegment, ToolPart } from '../../../types/message'
import { useUiDisclosureState } from '../../../utils/uiDisclosureState'
import { formatTime, formatDetailedDateTime } from '../../../utils/formatUtils'
import { chevronClass, MessageExpandPanel, useMessageExpandRender } from '../messageExpand'
import { ToolPartView } from './ToolPartView'

// ============================================
// Task Completion Part View - 后台任务完成通知（独立系统消息卡片）
// 含 auto-wake 唤醒轮折叠区（模型对任务结果的反应）
// ============================================

/** 展开体 output / wake 文本渲染上限，防巨输出卡顿 */
const OUTPUT_RENDER_LIMIT = 32 * 1024
const WAKE_TEXT_RENDER_LIMIT = 64 * 1024

interface TaskCompletionPartViewProps {
  part: TaskCompletionPart
}

/** wake segment 渲染：text → markdown；reasoning → 弱化小字；tool → compact 工具卡 */
function WakeSegmentView({ part, seg, index, streaming }: {
  part: TaskCompletionPart
  seg: TaskWakeSegment
  index: number
  streaming: boolean
}) {
  if (seg.kind === 'tool') {
    const toolPart: ToolPart = {
      id: `${part.id}:wake:${seg.callID}`,
      sessionID: part.sessionID,
      messageID: part.messageID,
      type: 'tool',
      callID: seg.callID,
      tool: seg.tool,
      state: seg.state,
    }
    return <ToolPartView part={toolPart} compact isStreaming={streaming} />
  }
  const text = seg.text.length > WAKE_TEXT_RENDER_LIMIT ? seg.text.slice(0, WAKE_TEXT_RENDER_LIMIT) : seg.text
  if (seg.kind === 'reasoning') {
    return (
      <p className="text-[length:var(--fs-sm)] text-text-500 italic whitespace-pre-wrap break-words">
        {text}
      </p>
    )
  }
  return <MarkdownRenderer key={index} content={text} />
}

export const TaskCompletionPartView = memo(function TaskCompletionPartView({ part }: TaskCompletionPartViewProps) {
  const { t } = useTranslation('message')
  const [expanded, setExpanded] = useUiDisclosureState(`message:${part.messageID}:taskdone:${part.id}`, false)
  const shouldRenderBody = useMessageExpandRender(expanded)
  const { rootRef, headerRef, withScrollLock } = useDisclosureScrollLock()
  const { ok, command, displayCommand, description, cwd, exitCode, signal, output, outputFile, truncated, endTime, wake } = part

  const commandLine = (displayCommand || command).split('\n')[0]
  // description 有则主显，command 退次
  const headline = description || commandLine
  const statusBadge = signal
    ? t('taskNotification.signal', { signal })
    : exitCode !== undefined
      ? t('taskNotification.exit', { code: exitCode })
      : undefined
  const accent = ok ? 'text-success-100' : 'text-danger-100'
  const renderedOutput = output && output.length > OUTPUT_RENDER_LIMIT ? output.slice(0, OUTPUT_RENDER_LIMIT) : output
  const wakeStreaming = wake?.status === 'streaming'

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
          {headline && (
            <span className={`text-[length:var(--fs-sm)] text-text-300 truncate ${description ? '' : 'font-mono'}`}>{headline}</span>
          )}
        </div>
        {wakeStreaming && (
          <span className="flex items-center gap-1.5 flex-shrink-0 text-[length:var(--fs-xxs)] text-text-500">
            <span className="w-1.5 h-1.5 bg-accent-main-100 rounded-full animate-pulse" />
            {t('taskNotification.wakeStreaming')}
          </span>
        )}
        {wake?.status === 'cancelled' && (
          <span className="text-[length:var(--fs-xxs)] flex-shrink-0 px-1.5 py-0.5 rounded text-text-500 bg-bg-200/60">
            {t('taskNotification.wakeCancelled')}
          </span>
        )}
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
            {description && commandLine && (
              <p className="text-[length:var(--fs-xs)] text-text-500 font-mono truncate">{commandLine}</p>
            )}
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
            {wake && wake.segments.length > 0 && (
              <div className="pt-2 border-t border-border-200/40 space-y-2">
                <p className="text-[length:var(--fs-xs)] text-text-400">{t('taskNotification.wakeTitle')}</p>
                {wake.segments.map((seg, i) => (
                  <WakeSegmentView
                    key={seg.kind === 'tool' ? `tool:${seg.callID}` : i}
                    part={part}
                    seg={seg}
                    index={i}
                    streaming={wakeStreaming && i === wake.segments.length - 1}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </MessageExpandPanel>
    </div>
  )
})
