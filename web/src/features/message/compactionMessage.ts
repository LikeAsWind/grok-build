/**
 * Compaction-only assistant message identity.
 *
 * Manual `/compact` (Web's `x.ai/compact_conversation` ext-request path)
 * never goes through `session/prompt`, so it never resets `turn.assistantId`
 * via `prepareTurnForPrompt`. When it fires between turns, `ensureAssistant`
 * (acpBridge.ts) mints a brand-new assistant message carrying nothing but the
 * `compaction` part — a standalone notification, not a reply to the user.
 *
 * Without this identity check, that message gets mistaken for "the last
 * assistant reply of the turn" by turn-duration / latest-assistant logic
 * (chatPageModel.ts), stealing the real reply's total-duration/completed-at
 * attribution.
 */

import type { Message } from '../../types/message'

export const isCompactionOnlyMessage = (m: Message): boolean =>
  m.info.role === 'assistant' && m.parts.length > 0 && m.parts.every(p => p.type === 'compaction')
