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
 */

export const TASK_NOTIFICATION_MESSAGE_ID_PREFIX = 'msg_tasknotif_'

export interface TaskNotificationIdentity {
  info: { id: string; role: string }
}

export const isTaskNotificationMessage = (m: TaskNotificationIdentity): boolean =>
  m.info.role === 'assistant' && m.info.id.startsWith(TASK_NOTIFICATION_MESSAGE_ID_PREFIX)
