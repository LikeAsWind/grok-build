// v2 spec §7.2.3: per-project cron schedule editor for ~/.grok/cron.yaml.
// Reads the file via acpExtRequest('x.ai/workbench/cron/get') on mount,
// parses it into ProjectSchedule[]. Edits stay local until "Save" is
// clicked -- we serialize back to YAML and POST via
// acpExtRequest('x.ai/workbench/cron/save', { content }).

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getCronYaml, saveCronYaml } from '../../api/grokConfig'
import { handleError } from '../../utils'

interface CronSchedule {
  cron: string
  tapd_status_filter: string[]
  priority_filter: string[]
}

interface ProjectSchedule {
  key: string
  schedules: CronSchedule[]
}

// Tiny YAML serializer tuned for our shape -- one section per project,
// one list item per schedule. Round-tripping arbitrary YAML is out of scope;
// the on-disk file is owned by this editor only.
function serializeCronYaml(projects: ProjectSchedule[]): string {
  const lines: string[] = ['projects:'];
  for (const p of projects) {
    lines.push(`  - key: ${JSON.stringify(p.key)}`);
    if (p.schedules.length === 0) {
      lines.push('    schedules: []');
      continue;
    }
    lines.push('    schedules:');
    for (const s of p.schedules) {
      lines.push(`      - cron: ${JSON.stringify(s.cron)}`);
      if (s.tapd_status_filter.length > 0) {
        lines.push(`        tapd_status_filter: [${s.tapd_status_filter.map((v) => JSON.stringify(v)).join(', ')}]`);
      }
      if (s.priority_filter.length > 0) {
        lines.push(`        priority_filter: [${s.priority_filter.map((v) => JSON.stringify(v)).join(', ')}]`);
      }
    }
  }
  return lines.join('\n') + '\n'
}

// Best-effort YAML parser for the same shape. Tolerant of unknown fields.
function parseCronYaml(content: string): ProjectSchedule[] {
  const projects: ProjectSchedule[] = [];
  let current: ProjectSchedule | null = null;
  let currentSchedule: CronSchedule | null = null;
  const flushSchedule = () => {
    if (currentSchedule && current) {
      current.schedules.push(currentSchedule);
      currentSchedule = null;
    }
  };
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trimEnd();
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0 && line.startsWith('projects:')) continue;
    if (indent === 2 && line.startsWith('- key:')) {
      flushSchedule();
      const m = line.match(/^\s*- key:\s*(.+)$/);
      const key = m ? m[1].trim().replace(/^['"]|['"]$/g, '') : '';
      current = { key, schedules: [] };
      projects.push(current);
      continue;
    }
    if (current && indent === 4 && line.trim() === 'schedules:') {
      continue;
    }
    if (current && indent === 6 && line.trim().startsWith('- cron:')) {
      flushSchedule();
      const m = line.match(/^\s*- cron:\s*(.+)$/);
      const cron = m ? m[1].trim().replace(/^['"]|['"]$/g, '') : '';
      currentSchedule = { cron, tapd_status_filter: [], priority_filter: [] };
      continue;
    }
    if (currentSchedule && line.trim().startsWith('tapd_status_filter:')) {
      const m = line.match(/^\s*tapd_status_filter:\s*\[(.*?)\]\s*$/);
      const m1 = m && m[1]
      currentSchedule.tapd_status_filter = m1
        ? m1.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
        : [];
      continue;
    }
    if (currentSchedule && line.trim().startsWith('priority_filter:')) {
      const m = line.match(/^\s*priority_filter:\s*\[(.*?)\]\s*$/);
      const m1 = m && m[1]
      currentSchedule.priority_filter = m1
        ? m1.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
        : [];
      continue;
    }
  }
  flushSchedule();
  return projects;
}

export function CronSettingsPanel() {
  const { t } = useTranslation('workbench');
  const [projects, setProjects] = useState<ProjectSchedule[]>([]);
  const [original, setOriginal] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    setLoading(true);
    setError('');
    getCronYaml()
      .then((file) => {
        setOriginal(file.content);
        setProjects(parseCronYaml(file.content));
      })
      .catch((e) => setError(handleError(e).message || t('cronLoadFailed')));
      .finally(() => setLoading(false));
  }, [t]);

  const dirty = serializeCronYaml(projects) !== original;

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      const content = serializeCronYaml(projects);
      await saveCronYaml(content);
      setOriginal(content);
      setSavedAt(Date.now());
    } catch (e) {
      setError(handleError(e).message || t('cronSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const addProject = () => {
    setProjects([...projects, { key: 'new-project', schedules: [] }]);
  };

  const updateProject = (idx: number, patch: Partial<ProjectSchedule>) => {
    setProjects(projects.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  };

  const removeProject = (idx: number) => {
    setProjects(projects.filter((_, i) => i !== idx));
  };

  const addSchedule = (projIdx: number) => {
    setProjects(projects.map((p, i) => i === projIdx ? {
      ...p,
      schedules: [...p.schedules, { cron: '0 * * * * * *', tapd_status_filter: [], priority_filter: [] }],
    } : p));
  };

  const updateSchedule = (projIdx: number, schedIdx: number, patch: Partial<CronSchedule>) => {
    setProjects(projects.map((p, i) => i === projIdx ? {
      ...p,
      schedules: p.schedules.map((s, j) => j === schedIdx ? { ...s, ...patch } : s),
    } : p));
  };

  const removeSchedule = (projIdx: number, schedIdx: number) => {
    setProjects(projects.map((p, i) => i === projIdx ? {
      ...p,
      schedules: p.schedules.filter((_, j) => j !== schedIdx),
    } : p));
  };

  return (
    <div className="rounded border border-border-200/40 p-3 space-y-3">
      <div>
        <h3 className="text-sm font-semibold">{t('cronSettingsTitle')}</h3>
        <p className="text-[length:var(--fs-xs)] text-text-400">{t('cronSettingsDesc')}</p>
      </div>
      {loading ? (
        <div className="text-[length:var(--fs-xs)] text-text-400">...</div>
      ) : error ? (
        <div className="text-[length:var(--fs-xs)] text-danger-100">{error}</div>
      ) : projects.length === 0 ? (
        <div className="text-[length:var(--fs-xs)] text-text-400">{t('cronNoProjects')}</div>
      ) : (
        <div className="space-y-3">
          {projects.map((p, pi) => (
            <div key={pi} className="rounded border border-border-200/30 p-2 space-y-2">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  className="flex-1 rounded border border-border-200/40 bg-bg-100 px-2 py-1 text-[length:var(--fs-sm)] text-text-100"
                  value={p.key}
                  onChange={(e) => updateProject(pi, { key: e.target.value })}
                  placeholder={t('cronProjectKey') as string}
                  disabled={saving}
                />
                <button
                  type="button"
                  className="rounded border border-border-200/40 px-2 py-1 text-[length:var(--fs-xs)] text-text-200 hover:bg-bg-200"
                  onClick={() => removeProject(pi)}
                  disabled={saving}
                >
                  {t('cronRemove') as string}
                </button>
              </div>
              {p.schedules.length === 0 ? (
                <div className="text-[length:var(--fs-xs)] text-text-400">-</div>
              ) : (
                <div className="space-y-2">
                  {p.schedules.map((s, si) => (
                    <div key={si} className="rounded border border-border-200/30 p-2 space-y-1">
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          className="flex-1 rounded border border-border-200/40 bg-bg-100 px-2 py-1 text-[length:var(--fs-sm)] font-mono text-text-100"
                          value={s.cron}
                          onChange={(e) => updateSchedule(pi, si, { cron: e.target.value })}
                          placeholder={t('cronExpression') as string}
                          disabled={saving}
                        />
                        <button
                          type="button"
                          className="rounded border border-border-200/40 px-2 py-1 text-[length:var(--fs-xs)] text-text-200 hover:bg-bg-200"
                          onClick={() => removeSchedule(pi, si)}
                          disabled={saving}
                        >
                          {t('cronRemove') as string}
                        </button>
                      </div>
                      <input
                        type="text"
                        className="w-full rounded border border-border-200/40 bg-bg-100 px-2 py-1 text-[length:var(--fs-sm)] text-text-100"
                        value={s.tapd_status_filter.join(', ')}
                        onChange={(e) => updateSchedule(pi, si, {
                          tapd_status_filter: e.target.value.split(',').map((x) => x.trim()).filter(Boolean),
                        })}
                        placeholder={t('cronStatusFilter') as string}
                        disabled={saving}
                      />
                      <input
                        type="text"
                        className="w-full rounded border border-border-200/40 bg-bg-100 px-2 py-1 text-[length:var(--fs-sm)] text-text-100"
                        value={s.priority_filter.join(', ')}
                        onChange={(e) => updateSchedule(pi, si, {
                          priority_filter: e.target.value.split(',').map((x) => x.trim()).filter(Boolean),
                        })}
                        placeholder={t('cronPriorityFilter') as string}
                        disabled={saving}
                      />
                    </div>
                  ))}
                </div>
              )}
              <button
                type="button"
                className="rounded border border-border-200/40 px-2 py-1 text-[length:var(--fs-xs)] text-text-200 hover:bg-bg-200"
                onClick={() => addSchedule(pi)}
                disabled={saving}
              >
                {t('cronAddSchedule') as string}
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between pt-2 border-t border-border-200/30">
        <div>
          {savedAt && !dirty ? (
            <span className="text-[length:var(--fs-xs)] text-success-100">{t('cronSaved') as string}</span>
          ) : null}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded border border-border-200/40 px-3 py-1 text-[length:var(--fs-sm)] text-text-200 hover:bg-bg-200"
            onClick={addProject}
            disabled={saving}
          >
            + Project
          </button>
          <button
            type="button"
            className="rounded bg-primary-500 px-3 py-1 text-[length:var(--fs-sm)] text-white disabled:opacity-50"
            onClick={handleSave}
            disabled={!dirty || saving}
          >
            {saving ? '...' : (t('cronSave') as string)}
          </button>
        </div>
      </div>
    </div>
  );
}
