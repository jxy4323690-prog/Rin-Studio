import { throwIpcError } from '../utils/ipcValidate.js';
import type { OrcaRoundtable } from './orcaRoundtable.js';
import type { RoundtablePanelRequest, RoundtablePanelSnapshot } from '../../shared/roundtablePanel.js';

export function createRoundtablePanelHandler(deps: {
  captureAccess(): () => void;
  readLead(id: string): Promise<{ id: string; orcaRole: string | null; planModeEnabled?: boolean; remoteHostId?: string | null; agentDeviceId?: string | null } | null>;
  controller(): OrcaRoundtable;
  readLeadReturns(leadId: string, runId: string): Promise<string[]>;
}) {
  return async (input: unknown): Promise<RoundtablePanelSnapshot> => {
    const assertCurrent = deps.captureAccess(); assertCurrent();
    const b = input as Partial<RoundtablePanelRequest> | null;
    if (!b || typeof b.leadSessionId !== 'string' || !b.leadSessionId || b.leadSessionId.length > 200
      || !['getStatus', 'pause', 'resume', 'stop'].includes(b.action ?? '')
      || (b.runId !== undefined && (typeof b.runId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(b.runId)))) throwIpcError('INVALID_PARAMS', 'Invalid Roundtable request');
    const lead = await deps.readLead(b.leadSessionId); assertCurrent();
    if (!lead || lead.orcaRole !== 'lead' || lead.remoteHostId || lead.agentDeviceId) throwIpcError('PERMISSION_DENIED', 'Local owned Lead required');
    if (b.action === 'resume' && lead.planModeEnabled) throwIpcError('PERMISSION_DENIED', 'Plan mode cannot resume execution');
    const controller = deps.controller();
    const runs = controller.runsForLead(lead.id);
    let run = b.runId ? runs.find(r => r.runId === b.runId) : runs.find(r => ['running', 'paused', 'uncertain'].includes(r.state)) ?? runs.at(-1);
    if (b.runId && !run) throwIpcError('PERMISSION_DENIED', 'Run does not belong to this Lead');
    if (b.action !== 'getStatus') {
      if (!run) throwIpcError('INVALID_PARAMS', 'No Roundtable selected');
      // Caller identity is derived from the current owner's DB row, never from the payload.
      try { run = await controller.command({ callerSessionId: lead.id, runId: run.runId, action: b.action! }); }
      catch { throwIpcError('PERMISSION_DENIED', 'Roundtable control was refused; refresh its state'); }
      assertCurrent();
    }
    const leadReturns = run ? await deps.readLeadReturns(lead.id, run.runId) : []; assertCurrent();
    return { runs: controller.runsForLead(lead.id).map(r => ({ runId: r.runId, state: r.state })),
      run: run ? { runId: run.runId, teamId: run.teamId, leadSessionId: lead.id,
        workerId: run.workerId, workerSessionId: run.workerSessionId, state: run.state,
        currentAgent: run.currentAgent, speeches: run.speeches, completedTurns: run.completedTurns,
        inFlight: run.inFlight, leadActive: run.leadActive, reason: run.reason, messages: run.messages } : null, leadReturns };
  };
}
