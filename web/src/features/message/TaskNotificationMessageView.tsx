import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { CopyButton } from '../../components/ui'
import { TaskCompletionPartView } from './parts/TaskCompletionPartView'
import { ForkActionButton, useMessageActionBarClass } from './MessageRenderer'
import type { Message, TaskCompletionPart } from '../../types/message'

// ============================================
// Task Notification Message View - 后台任务完成通知的整条消息壳
// （msg_tasknotif_* 合成消息：单个 task-completion part + Fork/Copy 操作条）
// ============================================

interface TaskNotificationMessageViewProps {
  message: Message
  onFork?: (message: Message, forkMessageId?: string) => Promise<void> | void
}

export const TaskNotificationMessageView = memo(function TaskNotificationMessageView({
  message,
  onFork,
}: TaskNotificationMessageViewProps) {
  const { t } = useTranslation('message')
  const actionBarClass = useMessageActionBarClass()
  const part = message.parts.find((p): p is TaskCompletionPart => p.type === 'task-completion')
  // part 尚未 hydrate — 最小占位减少 CLS
  if (!part) return <div className="w-full min-h-[24px]" />

  const statusLine = part.signal
    ? t('taskNotification.signal', { signal: part.signal })
    : part.exitCode !== undefined
      ? t('taskNotification.exit', { code: part.exitCode })
      : t('taskNotification.completedTitle')
  const wakeText = part.wake?.segments
    .filter((s): s is Extract<typeof s, { kind: 'text' }> => s.kind === 'text')
    .map(s => s.text)
    .join('\n') ?? ''
  const baseText = part.output?.trim() ? part.output : `${part.command}\n(${statusLine})`
  const copyText = wakeText ? `${baseText}\n\n${wakeText}` : baseText

  return (
    <div className="flex flex-col gap-1 w-full group">
      <TaskCompletionPartView part={part} />
      <div className={actionBarClass}>
        <ForkActionButton message={message} onFork={onFork} />
        <CopyButton text={copyText} position="static" />
      </div>
    </div>
  )
})
