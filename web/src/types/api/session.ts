import type {
  Session as SDKSession,
  SessionCreateData as SDKSessionCreateData,
  SessionForkData as SDKSessionForkData,
  SessionListData as SDKSessionListData,
  SessionStatus as SDKSessionStatus,
  SessionUpdateData as SDKSessionUpdateData,
} from '@opencode-ai/sdk/v2/client'

export type SessionStatus = SDKSessionStatus

export type SessionStatusMap = Record<string, SessionStatus>

export type SessionSummary = NonNullable<SDKSession['summary']>

export type SessionShare = NonNullable<SDKSession['share']>

export type SessionRevert = NonNullable<SDKSession['revert']>

/**
 * grok 本地扩展字段——不属于上游 OpenCodeUI SDK，由 ACP roster
 * （`x.ai/sessions/list`）在 `mapRosterToSession` 里回填（见 `web/src/api/session.ts`）。
 */
export interface SessionLocalExtensions {
  /** 会话期间代码增加的行数（来自 hunk-tracker 或落盘快照） */
  additions?: number
  /** 会话期间代码删除的行数 */
  deletions?: number
  /** 会话期间修改的文件数 */
  files?: number
  /** true = 进程内仍有 resident actor 驱动该会话（不论 busy/idle）；false = 仅存在于磁盘 */
  resident?: boolean
}

export type Session = SDKSession & SessionLocalExtensions

export type SessionListParams = NonNullable<SDKSessionListData['query']>

export type SessionCreateParams = NonNullable<SDKSessionCreateData['query']> & NonNullable<SDKSessionCreateData['body']>

export type SessionUpdateParams = NonNullable<SDKSessionUpdateData['body']>

export type SessionForkParams = NonNullable<SDKSessionForkData['query']> & NonNullable<SDKSessionForkData['body']>
