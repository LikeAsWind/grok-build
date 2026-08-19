import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { CopyButton } from '../../components/ui'
import { TaskCompletionPartView } from './parts/TaskCompletionPartView'
import { AgentCompletionPartView } from './parts/AgentCompletionPartView'
import { ForkActionButton, useMessageActionBarClass } from './MessageRenderer'
import type { Message, TaskCompletionPart, AgentCompletionPart } from '../../types/message'

// ============================================
// Task Notification Message View - 后台任务 / 子 agent 完成通知的整条消息壳
// （msg_tasknotif_* 合成消息：单个 task-completion / agent-completion part + Fork/Copy 操作条）
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
  const taskPart = message.parts.find((p): p is TaskCompletionPart => p.type === 'task-completion')
  const agentPart = message.parts.find((p): p is AgentCompletionPart => p.type === 'agent-completion')
  // part 尚未 hydrate — 最小占位减少 CLS
  if (!taskPart && !agentPart) return <div className="w-full min-h-[24px]" />

  const copyText = taskPart
    ? taskPart.output?.trim()
      ? taskPart.output
      : `${taskPart.command}\n(${taskPart.signal ? t('taskNotification.signal', { signal: taskPart.signal }) : taskPart.exitCode !== undefined ? t('taskNotification.exit', { code: taskPart.exitCode }) : t('taskNotification.completedTitle')})`
    : agentPart?.output?.trim()
      ? agentPart.output
      : agentPart?.description || agentPart?.command || ''

  return (
    <div className="flex flex-col gap-1 w-full group">
      {taskPart ? <TaskCompletionPartView part={taskPart} /> : <AgentCompletionPartView part={agentPart!} />}
      <div className={actionBarClass}>
        <ForkActionButton message={message} onFork={onFork} />
        <CopyButton text={copyText} position="static" />
      </div>
    </div>
  )
})
