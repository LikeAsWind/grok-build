export type StageName = 'brainstorm' | 'adjudicate' | 'develop' | 'code_review' | 'verify' | 'mr_submit'

const STAGES: Array<{ key: StageName; label: string }> = [
  { key: 'brainstorm', label: '设计' },
  { key: 'adjudicate', label: '裁断' },
  { key: 'develop', label: '开发' },
  { key: 'code_review', label: '评审' },
  { key: 'verify', label: '验证' },
  { key: 'mr_submit', label: '提 MR' },
]

interface StageTimelineProps {
  current: StageName | 'done' | 'blocked' | 'dead'
}

export function StageTimeline({ current }: StageTimelineProps) {
  const activeIndex =
    current === 'done' || current === 'blocked' || current === 'dead'
      ? STAGES.length - 1
      : STAGES.findIndex((s) => s.key === current)

  return (
    <div className="flex items-center gap-1" role="list" aria-label="Pipeline stage">
      {STAGES.map((stage, idx) => {
        const isReached = idx < activeIndex || (current === 'done' && idx <= activeIndex)
        const isActive = !isReached && idx === activeIndex
        const dotClass = isReached
          ? 'bg-emerald-500'
          : isActive
            ? 'bg-blue-500'
            : 'bg-text-500/40'
        return (
          <div
            key={stage.key}
            role="listitem"
            className="flex items-center gap-1"
            data-stage-active={isActive ? stage.key : undefined}
            data-stage-done={isReached ? 'true' : undefined}
          >
            <span className={`h-2 w-2 rounded-full ${dotClass}`} />
            <span className="text-xs text-text-600">{stage.label}</span>
            {idx < STAGES.length - 1 ? <span className="h-px w-4 bg-text-500/30" /> : null}
          </div>
        )
      })}
    </div>
  )
}

