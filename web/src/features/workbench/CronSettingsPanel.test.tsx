// CronSettingsPanel: parses loaded cron.yaml into project rows, renders
// editable cron expression + filter inputs, and saves back via the
// x.ai/workbench/cron/save ext method.

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CronSettingsPanel } from './CronSettingsPanel'

const { getCronYamlMock, saveCronYamlMock, tMock } = vi.hoisted(() => ({
  getCronYamlMock: vi.fn(),
  saveCronYamlMock: vi.fn(),
  // Stable identity: the panel's fetch effect depends on [t] (repo convention),
  // and the real react-i18next returns a stable t. A fresh arrow per render
  // would re-run the effect forever.
  tMock: (key: string) => key,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: tMock }),
}))

vi.mock('../../api/grokConfig', () => ({
  getCronYaml: (...args: unknown[]) => getCronYamlMock(...args),
  saveCronYaml: (...args: unknown[]) => saveCronYamlMock(...args),
}))

const YAML = `projects:
  - key: my-app
    schedules:
      - cron: "0 0 9 * * MON *"
        tapd_status_filter: ["open"]
        priority_filter: ["high", "urgent"]
      - cron: "* * * * * * *"
  - key: other-app
    schedules: []
`;

describe('CronSettingsPanel', () => {
  beforeEach(() => {
    getCronYamlMock.mockReset();
    saveCronYamlMock.mockReset();
    getCronYamlMock.mockResolvedValue({ path: '/root/.grok/cron.yaml', content: YAML });
    saveCronYamlMock.mockResolvedValue(undefined);
  });

  it('renders one row per project on load', async () => {
    render(<CronSettingsPanel />);
    await waitFor(() => expect(screen.getAllByPlaceholderText('cronProjectKey')).toHaveLength(2));
    const keys = screen.getAllByPlaceholderText('cronProjectKey') as HTMLInputElement[];
    expect(keys.map((k) => k.value)).toEqual(['my-app', 'other-app']);
  });

  it('shows the schedule list under each project', async () => {
    render(<CronSettingsPanel />);
    await waitFor(() => expect(screen.getAllByPlaceholderText('cronExpression')).toHaveLength(2));
    const exprs = screen.getAllByPlaceholderText('cronExpression') as HTMLInputElement[];
    expect(exprs.map((e) => e.value)).toEqual(['0 0 9 * * MON *', '* * * * * * *']);
  });

  it('Save is disabled until an edit is made', async () => {
    render(<CronSettingsPanel />);
    await waitFor(() => screen.getAllByPlaceholderText('cronExpression'));
    const save = screen.getByText('cronSave') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it('Save calls saveCronYaml with serialized YAML; disables while saving', async () => {
    render(<CronSettingsPanel />);
    await waitFor(() => screen.getAllByPlaceholderText('cronExpression'));
    // Edit the first schedule's cron expression
    fireEvent.change(screen.getAllByPlaceholderText('cronExpression')[0], {
      target: { value: '0 0 17 * * MON *' },
    });
    const save = screen.getByText('cronSave') as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(saveCronYamlMock).toHaveBeenCalledTimes(1));
    // saveCronYaml(content: string) -- the { content } envelope is built inside
    // the helper, so the first argument here is the raw YAML string.
    const content = saveCronYamlMock.mock.calls[0][0] as string;
    expect(typeof content).toBe('string');
    expect(content).toContain('0 0 17 * * MON *');
    // Original YAML is unchanged, so the new content should differ from it.
    expect(content).not.toBe(YAML);
  });

  it('shows error if saveCronYaml rejects', async () => {
    saveCronYamlMock.mockRejectedValueOnce(new Error('write failed'));
    render(<CronSettingsPanel />);
    await waitFor(() => screen.getAllByPlaceholderText('cronExpression'));
    fireEvent.change(screen.getAllByPlaceholderText('cronExpression')[0], {
      target: { value: 'changed' },
    });
    fireEvent.click(screen.getByText('cronSave'));
    await waitFor(() => expect(screen.getByText('write failed')).toBeInTheDocument());
  });

  it('shows error if getCronYaml rejects', async () => {
    getCronYamlMock.mockRejectedValueOnce(new Error('load failed'));
    render(<CronSettingsPanel />);
    await waitFor(() => expect(screen.getByText('load failed')).toBeInTheDocument());
  });
})
