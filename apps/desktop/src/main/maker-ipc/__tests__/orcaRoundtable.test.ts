// Unit tier: actual controller entry points, fake model I/O only. Protects task 003
// dispatch/terminal/pause races missing from the ordinary Orca lifecycle tests.
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OrcaRoundtable, createRoundtableCompletionRouter, type RoundtableDeps, type RoundtableRun } from '../orcaRoundtable.js';
import { createRoundtableStore } from '../orcaRoundtableStore.js';

function harness(overrides: Partial<RoundtableDeps> = {}) {
  const journal = new Map<string, RoundtableRun>();
  const claims = new Set<string>();
  let sequence = 0, acceptedId = 'unaccepted';
  const accept = (run: RoundtableRun) => { acceptedId = `t${sequence++}`; controller.workerAccepted(run.workerSessionId!, acceptedId); };
  const deps: RoundtableDeps = {
    store: { load: () => [...journal.values()], save: run => { journal.set(run.runId, structuredClone(run)); },
      claim: id => { if (claims.has(id)) throw Error('TEAM_BUSY'); claims.add(id); }, release: id => { claims.delete(id); } },
    authorize: async (lead, worker) => {
      if (lead !== 'lead' || (worker && !['w1', 'w2'].includes(worker))) throw Error('NOT_AUTHORIZED');
      return { teamId: 'team', ...(worker ? { workerId: worker, workerSessionId: `${worker}-session` } : {}) };
    },
    dispatchWorker: vi.fn(async (run, _message, check) => { await check(); accept(run); }),
    dispatchLead: vi.fn(async (_run, _message, check) => { await check(); }),
    ...overrides,
  };
  const controller = new OrcaRoundtable(deps);
  const command = (action: Parameters<OrcaRoundtable['command']>[0]['action'], more = {}) => controller.command({
    callerSessionId: 'lead', action, runId: 'r1', ...more,
  });
  const dispatch = (requestId = 'q1', workerId = 'w1') => command('dispatch', { requestId, workerId, message: 'Inspect actual source' });
  const complete = (eventId: string | undefined = undefined, status: 'done' | 'error' = 'done') => controller.workerCompleted({ sessionId: 'w1-session', eventId: eventId ?? acceptedId, status, result: 'Actual result' });
  return { deps, controller, command, dispatch, complete, journal, claims, accept };
}

describe('Orca Roundtable bounded relay', () => {
  it('uses distinct Lead/Worker sessions and routes the actual result back for another structured decision', async () => {
    const h = harness(); await h.command('start'); await h.dispatch();
    expect(h.deps.dispatchWorker).toHaveBeenCalledWith(expect.objectContaining({ leadSessionId: 'lead', currentAgent: 'w1-session' }), 'Inspect actual source', expect.any(Function));
    await h.complete();
    expect(h.deps.dispatchLead).toHaveBeenCalledWith(expect.objectContaining({ currentAgent: 'lead' }), expect.stringContaining('Actual result'), expect.any(Function));
    await h.dispatch('q2', 'w2');
    expect(h.deps.dispatchWorker).toHaveBeenCalledTimes(2);
  });
  it('does not restart the same run or duplicate requests/terminal messages', async () => {
    const h = harness(); await h.command('start'); await h.dispatch(); await h.dispatch();
    await h.complete(); await h.complete(); await h.dispatch(); await h.command('start');
    expect(h.deps.dispatchWorker).toHaveBeenCalledOnce(); expect(h.deps.dispatchLead).toHaveBeenCalledOnce();
    expect((await h.command('getStatus')).completedTurns).toBe(2);
  });
  it('pauses after Worker completion and delivers the held result only on resume', async () => {
    const h = harness(); await h.command('start'); await h.dispatch(); await h.command('pause'); await h.complete();
    expect(h.deps.dispatchLead).not.toHaveBeenCalled();
    expect((await h.command('getStatus')).state).toBe('paused');
    await h.command('resume'); expect(h.deps.dispatchLead).toHaveBeenCalledOnce();
  });
  it('stop reports outstanding execution truthfully, then settles without another Lead turn', async () => {
    const h = harness(); await h.command('start'); await h.dispatch();
    expect(await h.command('stop')).toMatchObject({ state: 'stopped', inFlight: true, reason: 'stop_requested_in_flight_not_aborted' });
    await h.complete(); expect(h.deps.dispatchLead).not.toHaveBeenCalled();
    expect(await h.command('getStatus')).toMatchObject({ state: 'stopped', inFlight: false });
    await expect(h.command('resume')).rejects.toThrow('RUN_NOT_RESUMABLE');
  });
  it('ends at six admitted Agent turns instead of waking the Lead a seventh time', async () => {
    const h = harness(); await h.command('start');
    for (let i = 0; i < 3; i++) { await h.dispatch(`q${i}`); await h.complete(`t${i}`); }
    expect(await h.command('getStatus')).toMatchObject({ state: 'completed', speeches: 6, completedTurns: 6, reason: 'speech_limit' });
    expect(h.deps.dispatchWorker).toHaveBeenCalledTimes(3); expect(h.deps.dispatchLead).toHaveBeenCalledTimes(2);
  });
  it('records Worker failure and never triggers another model', async () => {
    const h = harness(); await h.command('start'); await h.dispatch(); await h.complete(undefined, 'error');
    expect(await h.command('getStatus')).toMatchObject({ state: 'failed', reason: 'worker_failed', inFlight: false });
    expect(h.deps.dispatchLead).not.toHaveBeenCalled();
  });
  it('rejects foreign callers/Workers and a second active run in the same team', async () => {
    const h = harness(); await h.command('start');
    await expect(h.command('getStatus', { callerSessionId: 'foreign' })).rejects.toThrow('NOT_AUTHORIZED');
    await expect(h.dispatch('bad', 'foreign-worker')).rejects.toThrow('NOT_AUTHORIZED');
    await expect(h.command('start', { runId: 'r2' })).rejects.toThrow('TEAM_BUSY');
    expect(h.deps.dispatchWorker).not.toHaveBeenCalled();
  });
  it('does not replay an uncertain delivery on resume or a duplicate message', async () => {
    const h = harness({ dispatchWorker: vi.fn(async () => { throw Error('connection lost after sending'); }) });
    await h.command('start'); await h.dispatch();
    expect(await h.command('getStatus')).toMatchObject({ state: 'uncertain', reason: 'delivery_unconfirmed', inFlight: true });
    await expect(h.command('resume')).rejects.toThrow('RUN_NOT_RESUMABLE');
    expect(h.deps.dispatchWorker).toHaveBeenCalledOnce();
  });
  it('retries a proven pre-dispatch busy refusal only after explicit resume', async () => {
    const h = harness(); vi.mocked(h.deps.dispatchWorker).mockRejectedValueOnce(Error('NOT_DISPATCHED'));
    await h.command('start'); await h.dispatch();
    expect(await h.command('getStatus')).toMatchObject({ state: 'paused', inFlight: false });
    await h.command('resume'); expect(h.deps.dispatchWorker).toHaveBeenCalledTimes(2);
  });
  it.each(['pause', 'stop'] as const)('rechecks %s while the model adapter is preparing', async action => {
    let release!: () => void; let entered!: () => void;
    const ready = new Promise<void>(r => { entered = r; }); const wait = new Promise<void>(r => { release = r; });
    const executed = vi.fn();
    const h = harness({ dispatchWorker: async (_run, _message, check) => {
      entered(); await wait;
      try { await check(); } catch { throw Error('NOT_DISPATCHED'); }
      executed();
    } });
    await h.command('start'); const pending = h.dispatch(); await ready;
    await h.command(action); release(); await pending;
    expect(executed).not.toHaveBeenCalled(); expect((await h.command('getStatus')).state).toBe(action === 'pause' ? 'paused' : 'stopped');
  });
  it('handles terminal-before-receipt without dropping or duplicating the report', async () => {
    const h = harness(); vi.mocked(h.deps.dispatchWorker).mockImplementation(async (run) => { h.accept(run); await h.complete(); });
    await h.command('start'); await h.dispatch();
    expect(h.deps.dispatchLead).toHaveBeenCalledOnce();
    expect(await h.command('getStatus')).toMatchObject({ speeches: 3, phase: 'decision' });
  });
  it('finishes on the Lead structured finish decision and keeps run-id tombstones', async () => {
    const h = harness(); await h.command('start'); await h.dispatch(); await h.complete(); await h.command('finish');
    expect(await h.command('start')).toMatchObject({ state: 'completed', reason: 'lead_finished' });
    await expect(h.dispatch('later')).rejects.toThrow('RUN_NOT_RESUMABLE');
  });
  it('restores interrupted journals as uncertain and rejects cross-process team claims', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rin-roundtable-'));
    try {
      const store = createRoundtableStore(root); const h = harness({ store });
      await h.command('start'); await h.dispatch();
      const second = harness({ store: createRoundtableStore(root) });
      expect(await second.command('getStatus')).toMatchObject({ state: 'uncertain', reason: 'recovery_required' });
      await expect(second.command('resume')).rejects.toThrow('RUN_NOT_RESUMABLE');
      expect(() => createRoundtableStore(root).claim('team', 'other-run')).toThrow();
      expect(() => createRoundtableStore(root).claim('other-team', 'r1')).toThrow();
      expect(second.deps.dispatchWorker).not.toHaveBeenCalled();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('automatically returns a fast Worker result when the initiating Lead product turn finishes', async () => {
    const h = harness(); h.controller.noteLeadExecution('r1', { instanceId: 'lead-runtime', generation: 1 });
    vi.mocked(h.deps.dispatchLead).mockRejectedValueOnce(Error('NOT_DISPATCHED'));
    await h.command('start'); await h.dispatch(); await h.complete();
    expect((await h.command('getStatus')).state).toBe('paused');
    await h.controller.leadSettled('lead', { instanceId: 'lead-runtime', generation: 0 }, true);
    expect(h.deps.dispatchLead).toHaveBeenCalledOnce();
    await h.controller.leadSettled('lead', { instanceId: 'lead-runtime', generation: 1 }, true);
    expect(h.deps.dispatchLead).toHaveBeenCalledTimes(2);
    expect(await h.command('getStatus')).toMatchObject({ state: 'running', phase: 'decision' });
  });
  it('does not automatically release a user pause on a Lead terminal', async () => {
    const h = harness(); await h.command('start'); await h.dispatch(); await h.command('pause'); await h.complete();
    await h.controller.leadSettled('lead', { instanceId: 'lead-runtime', generation: 1 }, true);
    expect(h.deps.dispatchLead).not.toHaveBeenCalled();
  });
  it.each([true, false])('settles the actual Lead decision terminal, success=%s, ignoring old generations', async successful => {
    const h = harness(); await h.command('start'); await h.dispatch(); await h.complete();
    h.controller.noteLeadExecution('r1', { instanceId: 'lead-runtime', generation: 2 });
    await h.controller.leadSettled('lead', { instanceId: 'lead-runtime', generation: 1 }, true);
    expect((await h.command('getStatus')).state).toBe('running');
    await h.controller.leadSettled('lead', { instanceId: 'lead-runtime', generation: 2 }, successful);
    expect(await h.command('getStatus')).toMatchObject({ state: successful ? 'completed' : 'failed', leadActive: false });
  });
  it('fails safely if Lead dies while its independent Worker is still running', async () => {
    const h = harness(); await h.command('start');
    h.controller.noteLeadExecution('r1', { instanceId: 'lead-runtime', generation: 1 });
    await h.dispatch();
    await h.controller.leadSettled('lead', { instanceId: 'lead-runtime', generation: 1 }, false);
    expect(await h.command('getStatus')).toMatchObject({ state: 'failed', inFlight: true, reason: 'lead_failed' });
    await h.complete(); expect(h.deps.dispatchLead).not.toHaveBeenCalled(); expect(h.claims.size).toBe(0);
  });
  it('does not consume a pre-existing busy Worker task as its own result', async () => {
    const h = harness(); vi.mocked(h.deps.dispatchWorker).mockRejectedValueOnce(Error('NOT_DISPATCHED'));
    await h.command('start'); await h.dispatch();
    expect(await h.complete('unrelated')).toBe(false);
    expect(h.deps.dispatchLead).not.toHaveBeenCalled();
    expect(h.controller.ownsWorker('w1-session')).toBe(false);
  });
  it('rechecks team authorization at the actual delivery boundary', async () => {
    const h = harness(); let authorized = true;
    vi.mocked(h.deps.dispatchWorker).mockImplementation(async (_run, _message, guard) => {
      authorized = false; await guard();
    });
    const original = h.deps.authorize;
    h.deps.authorize = async (...args) => { if (!authorized) throw Error('TEAM_CHANGED'); return original(...args); };
    await h.command('start'); await h.dispatch();
    authorized = true;
    expect(await h.command('getStatus')).toMatchObject({ state: 'uncertain' });
    expect(h.deps.dispatchLead).not.toHaveBeenCalled();
  });

  // Review 003.5: an old task may finish while a new Worker dispatch is still preparing.
  it('does not attribute a previous Worker terminal to the assignment being prepared', async () => {
    const h = harness(); const original = h.deps.dispatchWorker;
    let release!: () => void; let entered!: () => void;
    const ready = new Promise<void>(r => { entered = r; }); const wait = new Promise<void>(r => { release = r; });
    h.deps.dispatchWorker = async (...args) => { entered(); await wait; return original(...args); };
    await h.command('start'); const sending = h.dispatch(); await ready;
    const consumedOldResult = await h.complete('old-task-terminal');
    release(); await sending;
    expect(consumedOldResult).toBe(false);
    expect(h.deps.dispatchLead).not.toHaveBeenCalled();
    expect(await h.command('getStatus')).toMatchObject({ completedTurns: 1, phase: 'worker' });
  });
  it.each([true, false])('retains a Lead terminal before its dispatch receipt, success=%s', async successful => {
    const h = harness();
    vi.mocked(h.deps.dispatchLead).mockImplementation(async (_run, _message, check) => {
      await check(); h.controller.noteLeadExecution('r1', { instanceId: 'lead-runtime', generation: 2 });
      await h.controller.leadSettled('lead', { instanceId: 'lead-runtime', generation: 2 }, successful);
    });
    await h.command('start'); await h.dispatch(); await h.complete();
    expect(await h.command('getStatus')).toMatchObject({ state: successful ? 'completed' : 'failed', leadActive: false });
  });
  it('keeps its exclusive Team claim if a cancelled dispatch still has a live Lead', async () => {
    const h = harness(); let release!: () => void; let entered!: () => void;
    const ready = new Promise<void>(r => { entered = r; }); const wait = new Promise<void>(r => { release = r; });
    h.deps.dispatchWorker = async () => { entered(); await wait; throw Error('NOT_DISPATCHED'); };
    await h.command('start'); const sending = h.dispatch(); await ready;
    await h.command('stop'); release(); await sending;
    expect(h.claims.has('team')).toBe(true);
    expect(await h.command('getStatus')).toMatchObject({ state: 'stopped', leadActive: true });
  });

  it('binds terminal ownership to the accepted assignment rather than just its Worker session', async () => {
    const h = harness(); await h.command('start'); await h.dispatch();
    expect(await h.complete('previous-execution')).toBe(false);
    expect(h.deps.dispatchLead).not.toHaveBeenCalled();
    await h.complete(); await h.dispatch('q2');
    await h.complete('t0'); // Late duplicate from assignment one cannot finish assignment two.
    expect(h.deps.dispatchLead).toHaveBeenCalledOnce();
    expect(await h.command('getStatus')).toMatchObject({ phase: 'worker', inFlight: true, completedTurns: 3 });
    await h.complete(); expect(h.deps.dispatchLead).toHaveBeenCalledTimes(2);
  });
  it('loads recovery journals at the real completion route before any control command', async () => {
    const h = harness(); await h.command('start'); await h.dispatch(); await h.command('stop');
    let restored: OrcaRoundtable | undefined;
    const replayWorker = vi.fn(), replayLead = vi.fn();
    const route = createRoundtableCompletionRouter(() => restored ??= new OrcaRoundtable({
      ...h.deps, dispatchWorker: replayWorker, dispatchLead: replayLead,
    }), () => 'restored-event');
    const input = { sessionId: 'w1-session', identity: {}, status: 'done' as const, result: 'Delayed crash report' };
    expect(await route.completed(input)).toBe(true);
    expect(await route.completed(input)).toBe(true);
    expect(restored!.ownsWorkerId('w1')).toBe(true);
    expect(await restored!.command({ callerSessionId: 'lead', action: 'getStatus', runId: 'r1' })).toMatchObject({ state: 'uncertain', reason: 'recovery_required' });
    await expect(restored!.command({ callerSessionId: 'lead', action: 'resume', runId: 'r1' })).rejects.toThrow('RUN_NOT_RESUMABLE');
    expect(replayWorker).not.toHaveBeenCalled(); expect(replayLead).not.toHaveBeenCalled();
  });

});
