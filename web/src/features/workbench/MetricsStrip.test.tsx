// MetricsStrip: renders p50/p90 bars scaled by max_ms, hides when stages is empty,
// and surfaces retry/fallback counts.

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MetricsStrip } from './MetricsStrip'

describe('MetricsStrip', () => {
  it('renders nothing when stages is empty', () => {
    const { container } = render(<MetricsStrip stages={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders one column per stage with p50 + p90 bars', () => {
    render(<MetricsStrip stages={[
      { stage: 'develop', p50_ms: 100, p90_ms: 800, retry_count: 0, fallback_count: 0 },
      { stage: 'verify', p50_ms: 50, p90_ms: 250, retry_count: 0, fallback_count: 0 },
    ]} max_ms={1000} />);
    expect(screen.getByText('develop')).toBeInTheDocument();
    expect(screen.getByText('verify')).toBeInTheDocument();
    expect(screen.getByText('p50')).toBeInTheDocument();
    expect(screen.getByText('p90')).toBeInTheDocument();
  });

  it('scales bars so the largest p90 reads as ~100%', () => {
    render(<MetricsStrip stages={[
      { stage: 'develop', p50_ms: 250, p90_ms: 1000, retry_count: 0, fallback_count: 0 },
    ]} max_ms={1000} />);
    const p90 = screen.getByTitle('develop p90 = 1000ms');
    expect(p90.style.width).toBe('100%');
    const p50 = screen.getByTitle('develop p50 = 250ms');
    expect(p50.style.width).toBe('25%');
  });

  it('defaults max_ms to 1ms when omitted so the first value reads as 100%', () => {
    render(<MetricsStrip stages={[
      { stage: 'develop', p50_ms: 50, p90_ms: 0, retry_count: 0, fallback_count: 0 },
    ]} />);
    // p50=50ms with max_ms=1 (default) means 5000% — clamped to 100%.
    const p50 = screen.getByTitle('develop p50 = 50ms');
    expect(p50.style.width).toBe('100%');
  });

  it('shows retry + fallback counts when non-zero', () => {
    render(<MetricsStrip stages={[
      { stage: 'develop', p50_ms: 100, p90_ms: 200, retry_count: 3, fallback_count: 1 },
    ]} max_ms={1000} />);
    expect(screen.getByText('retries: 3')).toBeInTheDocument();
    expect(screen.getByText('fb: 1')).toBeInTheDocument();
  });

  it('hides retry + fallback rows when both are zero', () => {
    render(<MetricsStrip stages={[
      { stage: 'develop', p50_ms: 100, p90_ms: 200, retry_count: 0, fallback_count: 0 },
    ]} max_ms={1000} />);
    expect(screen.queryByText(/retries:/)).toBeNull();
    expect(screen.queryByText(/^fb:/)).toBeNull();
  });
})
