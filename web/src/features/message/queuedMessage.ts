/**
 * Queued follow-up message identity.
 *
 * A follow-up message enqueued while a turn is running is materialised in the
 * chat as a local placeholder bubble whose id starts with `queued_`. That
 * prefix is the single source of truth shared between
 * `followupQueueStore.enqueue` (which generates it) and the UI (which renders
 * affordances for it). Centralising it here avoids stringly-typed coupling
 * across files.
 */

export const QUEUED_MESSAGE_ID_PREFIX = 'queued_'

export interface QueuedIdentity {
  info: { id: string }
}

export const isQueuedMessage = (m: QueuedIdentity): boolean =>
  m.info.id.startsWith(QUEUED_MESSAGE_ID_PREFIX)