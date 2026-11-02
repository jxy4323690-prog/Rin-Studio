// @vitest-environment jsdom
// Unit: real UI controls/subscription; the IPC response is the only fixture.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RoundtablePanel } from '../RoundtablePanel';
import type { RoundtablePanelSnapshot } from '../../../../shared/roundtablePanel';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);
function harness(state = 'running') {
  const snapshot: RoundtablePanelSnapshot = { runs: [{ runId: 'r1', state }], leadReturns: ['Actual Lead return'], run: {
    runId: 'r1', teamId: 'team', leadSessionId: 'lead', workerSessionId: 'worker', state, currentAgent: 'worker', speeches: 2, completedTurns: 1,
    inFlight: true, leadActive: false, reason: null, messages: [{ requestId: 'q1', target: 'worker', message: 'Real source task', result: 'Actual Worker result' }],
  } };
  let listener: (value: unknown) => void = () => {};
  let ownerListener: () => void = () => {};
  const unsubscribeOwner = vi.fn();
  const unsubscribe = vi.fn(); const invoke = vi.fn(async () => snapshot);
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { onAuthStateChange: (cb: () => void) => { ownerListener = cb; return unsubscribeOwner; }, localDb: { orcaWorkflows: {
    roundtablePanel: invoke, onOrcaWorkerChanged: (cb: typeof listener) => { listener = cb; return unsubscribe; },
  } } } });
  return { snapshot, invoke, unsubscribe, ownerEvent: () => ownerListener(), event: (value: unknown) => listener(value) };
}
it('renders actual task/result/return data and sends real pause/stop operations', async () => {
  const h = harness(); const view = render(<RoundtablePanel leadSessionId="lead" />);
  await screen.findByText('r1');
  expect(screen.getByText('Real source task')).toBeTruthy(); expect(screen.getByText('Actual Worker result')).toBeTruthy();
  expect(screen.getByText('Actual Lead return')).toBeTruthy();
  fireEvent.click(screen.getByText('roundtablePanel.pause'));
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith({ leadSessionId: 'lead', runId: 'r1', action: 'pause' }));
  await waitFor(() => expect((screen.getByText('roundtablePanel.stop') as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByText('roundtablePanel.stop'));
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith({ leadSessionId: 'lead', runId: 'r1', action: 'stop' }));
  view.unmount(); expect(h.unsubscribe).toHaveBeenCalledOnce();
});
it('refreshes only on the selected Lead event, without polling', async () => {
  const h = harness('paused'); render(<RoundtablePanel leadSessionId="lead" />); await screen.findByText('r1');
  act(() => h.event({ leadSessionId: 'other' })); expect(h.invoke).toHaveBeenCalledTimes(1);
  act(() => h.event({ leadSessionId: 'lead' })); await waitFor(() => expect(h.invoke).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByText('roundtablePanel.resume'));
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith({ leadSessionId: 'lead', runId: 'r1', action: 'resume' }));
});
it.each(['uncertain', 'stopped'])('displays %s and in-flight warnings without enabling resume', async state => {
  harness(state); render(<RoundtablePanel leadSessionId="lead" />);
  await screen.findByText(state === 'uncertain' ? 'roundtablePanel.uncertain' : 'roundtablePanel.stopping');
  expect((screen.getByText('roundtablePanel.resume') as HTMLButtonElement).disabled).toBe(true);
});
it('handles denied reads and empty runs without pretending execution happened', async () => {
  const h = harness(); h.invoke.mockRejectedValueOnce(Error('PERMISSION_DENIED'));
  render(<RoundtablePanel leadSessionId="lead" />); await screen.findByRole('alert');
  h.invoke.mockResolvedValueOnce({ runs: [], run: null, leadReturns: [] });
  fireEvent.click(screen.getByText('roundtablePanel.refresh')); await screen.findByText('roundtablePanel.empty');
  expect(screen.queryByText('Actual Worker result')).toBeNull();
});

it('ignores late snapshots after changing the selected Lead', async () => {
  const h = harness(); let finish!: (value: RoundtablePanelSnapshot) => void;
  h.invoke.mockImplementationOnce(() => new Promise<RoundtablePanelSnapshot>(resolve => { finish = resolve; }));
  const view = render(<RoundtablePanel leadSessionId="lead" />);
  h.invoke.mockResolvedValueOnce({ runs: [], run: null, leadReturns: [] });
  view.rerender(<RoundtablePanel leadSessionId="other-lead" />); await screen.findByText('roundtablePanel.empty');
  await act(async () => { finish(h.snapshot); });
  expect(screen.queryByText('Actual Worker result')).toBeNull();
});

it('clears old-owner content when authentication changes', async () => {
  const h = harness(); render(<RoundtablePanel leadSessionId="lead" />); await screen.findByText('Actual Worker result');
  h.invoke.mockRejectedValueOnce(Error('PERMISSION_DENIED'));
  act(() => h.ownerEvent()); await screen.findByRole('alert');
  expect(screen.queryByText('Actual Worker result')).toBeNull();
});
