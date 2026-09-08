// v2 spec §9.2.4: TimelineDrawer shows the ordered event log of a single
// task (pending -> queued -> stage_started -> stage_done -> ...).
//
// Fetches via acpExtRequest('x.ai/workbench/timeline', { tapd_id }).
// Renders a horizontal scrollable strip with one dot per event; each
// event has a tooltip showing ts + kind + (when applicable) stage + model.

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from '../../components/ui/Dialog'
import { Button } from '../../components/ui/Button'
import { acpExtRequest } from '../../api/acpBridge'
import { handleError } from '../../utils'

interface TimelineEvent {
  ts: number;
  kind: string;
  stage?: string;
  attempt?: number;
  model?: string | null;
  duration_ms?: number;
  finished_at?: number;
  fallback_used?: boolean;
  state?: string;
}

interface TimelineResponse {
  tapd_id: string;
  events: TimelineEvent[];
}

export interface TimelineDrawerProps {
  isOpen: boolean;
  tapdId: string | null;
  onClose: () => void;
}

export function TimelineDrawer({ isOpen, tapdId, onClose }: TimelineDrawerProps) {
  const { t } = useTranslation('workbench')
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen || !tapdId) return;
    setLoading(true);
    setError('');
    acpExtRequest('x.ai/workbench/timeline', { tapd_id: tapdId })
      .then((resp) => {
        const data = resp as TimelineResponse;
        setEvents(data.events ?? []);
      })
      .catch((e) => setError(handleError(e).message));
      .finally(() => setLoading(false));
  }, [isOpen, tapdId]);

  return (
    <Dialog isOpen={isOpen} onClose={onClose} title={t('timelineDrawerTitle')} width={720}>
      {loading ? (
        <div className="text-[length:var(--fs-xs)] text-text-400">...</div>
      ) : error ? (
        <div className="text-[length:var(--fs-xs)] text-danger-100">{error}</div>
      ) : events.length === 0 ? (
        <div className="text-[length:var(--fs-xs)] text-text-400">{t('timelineEmpty')}</div>
      ) : (
        <div className="overflow-x-auto">
          <ol className="flex items-center gap-3 py-3 min-w-max">
            {events.map((evt, i) => (
              <li key={i} className="flex flex-col items-center min-w-[80px]">
                <span
                  title={evtTooltip(evt)}
                  className={`size-3 rounded-full ${dotColor(evt.kind)} shrink-0`}
                />
                <span className="text-[length:var(--fs-xs)] text-text-400 mt-1">
                  {kindLabel(evt.kind)}
                </span>
                {evt.stage && (
                  <span className="text-[length:var(--fs-xs)] text-text-200">{evt.stage}</span>
                )}
                {evt.ts > 0 && (
                  <span className="text-[length:var(--fs-xs)] text-text-400 font-mono">
                    {formatTime(evt.ts)}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
      <div className="flex justify-end pt-3 border-t border-border-200/40 mt-3">
        <Button variant="secondary" size="sm" onClick={onClose}>
          {t('close') as string}
        </Button>
      </div>
    </Dialog>
  );
}

function dotColor(kind: string): string {
  switch (kind) {
    case 'pending': return 'bg-text-400'
    case 'queued': return 'bg-info-100'
    case 'running': return 'bg-warning-100'
    case 'stage_done': return 'bg-success-100'
    case 'state': return 'bg-primary-500'
    default: return 'bg-text-300'
  }
}

function kindLabel(kind: string): string {
  switch (kind) {
    case 'pending': return 'pending'
    case 'queued': return 'queued'
    case 'running': return 'running'
    case 'stage_done': return 'done'
    case 'state': return 'state'
    default: return kind;
  }
}

function evtTooltip(evt: TimelineEvent): string {
  const parts = [kindLabel(evt.kind), `ts=${evt.ts}`];
  if (evt.stage) parts.push(`stage=${evt.stage}`);
  if (evt.attempt !== undefined) parts.push(`attempt=${evt.attempt}`);
  if (evt.model) parts.push(`model=${evt.model}`);
  if (evt.duration_ms !== undefined) parts.push(`${evt.duration_ms}ms`);
  return parts.join(' ');
}

function formatTime(ts: number): string {
  // Best-effort local-time formatter without pulling in a date library.
  const d = new Date(ts * 1000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}
