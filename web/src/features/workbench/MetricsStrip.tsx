// v2 spec §9.2.2: MetricsStrip shows per-stage p50 / p90 / retry counts as
// inline bars on the workbench header. Reads its data via a parent-supplied
// `metrics` prop (the parent handles the ext method call); this component
// is a presentational leaf.

export interface StageMetric {
  stage: string;
  p50_ms: number;
  p90_ms: number;
  retry_count: number;
  fallback_count: number;
}

export interface MetricsStripProps {
  /** Per-stage aggregates from `x.ai/workbench/metrics`. Empty array = no data yet. */
  stages: StageMetric[];
  /** Maximum duration (ms) used to scale the bars. Defaults to 1ms so the
  first non-zero value reads as ~100% (avoids a divide-by-zero render). */
  max_ms?: number;
  className?: string;
}

export function MetricsStrip({ stages, max_ms, className }: MetricsStripProps) {
  if (stages.length === 0) return null;
  const scale = Math.max(max_ms ?? 0, 1);
  return (
    <div className={`flex items-stretch gap-3 overflow-x-auto ${className ?? ""}`}>
      {stages.map((s) => {
        const width50 = (s.p50_ms / scale) * 100;
        const width90 = (s.p90_ms / scale) * 100;
        return (
          <div key={s.stage} className="flex flex-col min-w-[120px]">
            <div className="text-[length:var(--fs-xs)] text-text-400">{s.stage}</div>
            <div className="mt-1 space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-[length:var(--fs-xs)] text-text-200 w-6 shrink-0">p50</span>
                <div className="flex-1 h-2 bg-bg-200 rounded">
                  <div
                    className="h-2 bg-primary-500 rounded"
                    style={{ width: `${Math.min(width50, 100)}%` }}
                    title={`${s.stage} p50 = ${s.p50_ms}ms`}
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[length:var(--fs-xs)] text-text-200 w-6 shrink-0">p90</span>
                <div className="flex-1 h-2 bg-bg-200 rounded">
                  <div
                    className="h-2 bg-warning-100 rounded"
                    style={{ width: `${Math.min(width90, 100)}%` }}
                    title={`${s.stage} p90 = ${s.p90_ms}ms`}
                  />
                </div>
              </div>
            </div>
            {(s.retry_count > 0 || s.fallback_count > 0) && (
              <div className="flex items-center gap-2 mt-1 text-[length:var(--fs-xs)] text-text-400">
                {s.retry_count > 0 && <span>retries: {s.retry_count}</span>}
                {s.fallback_count > 0 && <span className="text-warning-100">fb: {s.fallback_count}</span>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
