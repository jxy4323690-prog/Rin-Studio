// Unit: actual Controller commands through the Main panel boundary, fake DB/model only.
import { expect, it, vi } from 'vitest';
import { OrcaRoundtable } from '../orcaRoundtable.js';
import { createRoundtablePanelHandler } from '../roundtablePanelHandler.js';

function harness() {
  let owner = 1, teamId = 'team';
  const controller = new OrcaRoundtable({
    store: { load: () => [], save: () => {}, claim: () => {}, release: () => {} },
    authorize: async lead => { if (lead !== 'lead') throw Error('NOT_AUTHORIZED'); return { teamId }; },
    dispatchWorker: vi.fn(), dispatchLead: vi.fn(),
  });
  const deps = {
    captureAccess: () => { const captured = owner; return () => { if (owner !== captured) throw Error('OWNER_CHANGED'); }; },
    readLead: vi.fn(async (id: string) => id === 'lead' ? { id, orcaRole: 'lead' } : null),
    controller: () => controller, readLeadReturns: vi.fn(async () => ['Actual persisted message']),
  };
  return { controller, deps, handler: createRoundtablePanelHandler(deps), changeOwner: () => { owner++; }, changeTeam: () => { teamId = 'other-team'; } };
}
it('queries real runs and pauses/resumes/stops the original Controller without creating runs', async () => {
  const h = harness();
  expect((await h.handler({ leadSessionId: 'lead', action: 'getStatus' })).run).toBeNull();
  await h.controller.command({ callerSessionId: 'lead', runId: 'run-1', action: 'start' });
  for (const [action, state] of [['pause', 'paused'], ['resume', 'running'], ['stop', 'stopped']] as const) {
    expect((await h.handler({ leadSessionId: 'lead', runId: 'run-1', action, callerSessionId: 'forged' })).run?.state).toBe(state);
  }
  expect((await h.handler({ leadSessionId: 'lead', action: 'getStatus' })).leadReturns).toEqual(['Actual persisted message']);
});
it('rejects foreign sessions/runs and unknown control actions', async () => {
  const h = harness(); await h.controller.command({ callerSessionId: 'lead', runId: 'r1', action: 'start' });
  for (const request of [{ leadSessionId: 'foreign', action: 'getStatus' }, { leadSessionId: 'lead', runId: 'foreign', action: 'stop' }, { leadSessionId: 'lead', action: 'start' }]) {
    await expect(h.handler(request)).rejects.toThrow();
  }
  expect(h.controller.runsForLead('lead')[0].state).toBe('running');
});
it('does not return previous-owner data after an asynchronous account change', async () => {
  const h = harness(); h.deps.readLead.mockImplementationOnce(async id => { h.changeOwner(); return { id, orcaRole: 'lead' }; });
  await expect(h.handler({ leadSessionId: 'lead', action: 'getStatus' })).rejects.toThrow('OWNER_CHANGED');
  expect(h.deps.readLeadReturns).not.toHaveBeenCalled();
});
it('rejects Worker and remote identities before reading a Controller', async () => {
  const h = harness(); const controller = vi.spyOn(h.deps, 'controller');
  for (const identity of [
    { id: 'lead', orcaRole: 'worker' }, { id: 'lead', orcaRole: '' },
    { id: 'lead', orcaRole: 'lead', remoteHostId: 'ssh-host' },
    { id: 'lead', orcaRole: 'lead', agentDeviceId: 'remote-device' },
  ]) {
    h.deps.readLead.mockResolvedValueOnce(identity);
    await expect(h.handler({ leadSessionId: 'lead', action: 'getStatus' })).rejects.toThrow();
  }
  expect(controller).not.toHaveBeenCalled();
});

it('does not let a UI resume bypass Lead Plan mode', async () => {
  const h = harness(); await h.controller.command({ callerSessionId: 'lead', runId: 'r1', action: 'start' });
  await h.controller.command({ callerSessionId: 'lead', runId: 'r1', action: 'pause' });
  h.deps.readLead.mockImplementationOnce(async id => ({ id, orcaRole: 'lead', planModeEnabled: true }));
  await expect(h.handler({ leadSessionId: 'lead', runId: 'r1', action: 'resume' })).rejects.toThrow();
  expect(h.controller.runsForLead('lead')[0].state).toBe('paused');
});

it('does not control a previous Team run through a newly active Team', async () => {
  const h = harness(); await h.controller.command({ callerSessionId: 'lead', runId: 'r1', action: 'start' });
  h.changeTeam();
  await expect(h.handler({ leadSessionId: 'lead', runId: 'r1', action: 'pause' })).rejects.toThrow();
  expect(h.controller.runsForLead('lead')[0].state).toBe('running');
});
