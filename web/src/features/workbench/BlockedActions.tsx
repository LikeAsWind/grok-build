// Renders action buttons for a BlockedForHuman task (spec §15.5).
// - `needs_owner_decision` -> "回答问题并继续" button
// - `branch diverged` -> "重试提 MR" button
interface BlockedActionsProps {
  reason: string
  onResolve: () => void
  onRetryMr: () => void
}

export function BlockedActions({ reason, onResolve, onRetryMr }: BlockedActionsProps) {
  const isNeedsOwner = reason === 'needs_owner_decision'
  const isBranchDiverged = reason === 'branch diverged'

  return (
    <div className="rounded border border-danger-100 bg-danger-100/10 p-3 text-sm">
      <div className="font-semibold text-danger-100">需要人工处理</div>
      <div className="text-text-600">{reason}</div>
      <div className="mt-2 flex gap-2">
        {isNeedsOwner ? (
          <button
            className="rounded bg-primary-500 px-3 py-1 text-white"
            onClick={onResolve}
          >
            回答问题并继续
          </button>
        ) : null}
        {isBranchDiverged ? (
          <button
            className="rounded bg-primary-500 px-3 py-1 text-white"
            onClick={onRetryMr}
          >
            重试提 MR
          </button>
        ) : null}
      </div>
    </div>
  )
}
