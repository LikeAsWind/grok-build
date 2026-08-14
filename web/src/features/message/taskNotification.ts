/**
 * Background task completion notification identity.
 *
 * When a background task completes, the ACP `task_completed` frame is
 * materialised as a standalone synthetic assistant message whose id starts
 * with `msg_tasknotif_` and whose only part is a `task-completion` part.
 * The prefix is the single source of truth shared between
 * `acpBridge.emitTaskNotification` (which generates it) and the UI (which
 * renders the message as a system card instead of a normal assistant reply).
 * The suffix is the backend task id, making the message id deterministic so
 * replay / duplicate frames upsert the same message.
 *
 * The auto-wake turn that follows (the model's reaction to the task result)
 * is a normal standalone assistant message with the `msg_wake_` prefix —
 * rendered through the regular assistant path plus a small "auto reply"
 * label so it reads as system-triggered rather than answering the user.
 */

export const TASK_NOTIFICATION_MESSAGE_ID_PREFIX = 'msg_tasknotif_'
export const WAKE_REPLY_MESSAGE_ID_PREFIX = 'msg_wake_'

export interface TaskNotificationIdentity {
  info: { id: string; role: string }
}

export const isTaskNotificationMessage = (m: TaskNotificationIdentity): boolean =>
  m.info.role === 'assistant' && m.info.id.startsWith(TASK_NOTIFICATION_MESSAGE_ID_PREFIX)

export const isWakeReplyMessage = (m: TaskNotificationIdentity): boolean =>
  m.info.role === 'assistant' && m.info.id.startsWith(WAKE_REPLY_MESSAGE_ID_PREFIX)
