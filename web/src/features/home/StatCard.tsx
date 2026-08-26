interface StatCardProps {
  label: string
  value: string
}

/** 一个仪表盘统计卡片：小标签 + 大数值，跟截图的 Sessions/Messages/... 网格一致 */
export function StatCard({ label, value }: StatCardProps) {
  return (
    <div className="rounded-lg bg-bg-200/60 px-4 py-3">
      <div className="text-[length:var(--fs-sm)] text-text-400">{label}</div>
      <div className="mt-1 text-[length:var(--fs-heading-2)] font-semibold text-text-100 tabular-nums">{value}</div>
    </div>
  )
}

