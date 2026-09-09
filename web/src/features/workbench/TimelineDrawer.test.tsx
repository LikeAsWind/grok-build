// TimelineDrawer: fetches x.ai/workbench/timeline, renders one dot per event,
// and renders an empty state when there are no events.

import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TimelineDrawer } from './TimelineDrawer'

const { acpExtRequestMock } = vi.hoisted(() => ({ acpExtRequestMock: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../api/acpBridge', () => ({
  acpExtRequest: (...args: unknown[]) => acpExtRequestMock(...args),
}));

vi.mock('../../components/ui/Dialog', () => ({
  Dialog: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div role="dialog">{children}</div> : null,
}));

vi.mock('../../components/ui/Button', () => ({
  Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
}));

const SAMPLE = {
  tapd_id: "TAPD-1",
  events: [
    { ts: 1700000000, kind: "pending" },
    { ts: 1700000010, kind: "queued" },
    { ts: 1700000020, kind: "running", stage: "brainstorm", attempt: 0, model: "opus-4.1" },
    { ts: 1700000090, kind: "stage_done", stage: "brainstorm", attempt: 0, model: "opus-4.1" },
    { ts: 1700000100, kind: "running", stage: "develop", attempt: 0, model: "opus-4.1" },
    { ts: 1700000200, kind: "stage_done", stage: "develop", attempt: 0, model: "opus-4.1", finished_at: 1700000200 },
  ],
};

describe('TimelineDrawer', () => {
  beforeEach(() => {
    acpExtRequestMock.mockReset();
    acpExtRequestMock.mockResolvedValue(SAMPLE);
  });

  it('calls x.ai/workbench/timeline with tapd_id when open', async () => {
    render(<TimelineDrawer isOpen tapdId="TAPD-1" onClose={vi.fn()} />);
    await waitFor(() => expect(acpExtRequestMock).toHaveBeenCalledTimes(1));
    expect(acpExtRequestMock).toHaveBeenCalledWith('x.ai/workbench/timeline', { tapd_id: 'TAPD-1' });
  });

  it('renders one list item per event', async () => {
    render(<TimelineDrawer isOpen tapdId="TAPD-1" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(6));
  });

  it('shows empty state when events array is empty', async () => {
    acpExtRequestMock.mockResolvedValueOnce({ tapd_id: 'TAPD-1', events: [] });
    render(<TimelineDrawer isOpen tapdId="TAPD-1" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('timelineEmpty')).toBeInTheDocument());
  });

  it('does not call acpExtRequest when closed or tapdId is null', () => {
    render(<TimelineDrawer isOpen={false} tapdId="TAPD-1" onClose={vi.fn()} />);
    render(<TimelineDrawer isOpen tapdId={null} onClose={vi.fn()} />);
    expect(acpExtRequestMock).not.toHaveBeenCalled();
  });
})
