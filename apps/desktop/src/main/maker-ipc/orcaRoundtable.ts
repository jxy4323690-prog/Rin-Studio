/** Bounded Lead/Worker relay. No model simulation, polling, or automatic replay. */
export type RoundtableAction = 'start' | 'dispatch' | 'finish' | 'pause' | 'resume' | 'stop' | 'getStatus';
export interface RoundtableRequest {
  callerSessionId: string;
  action: RoundtableAction;
  runId: string;
  requestId?: string;
  workerId?: string;
  message?: string;
}
export interface RoundtableRun {
  runId: string;
  teamId: string;
  leadSessionId: string;
  state: 'running' | 'paused' | 'stopped' | 'completed' | 'failed' | 'uncertain';
  phase: 'decision' | 'worker' | 'report';
  speeches: number;
  completedTurns: number;
  currentAgent: string | null;
  inFlight: boolean;
  leadActive: boolean;
  reason: string | null;
  workerId?: string;
  workerSessionId?: string;
  /** Host-only accepted assignment identity, never inferred from the session alone. */
  workerExecutionId?: string;
  pending?: { target: 'worker' | 'lead'; message: string };
  messages: Array<{ requestId: string; target: string; message: string; result?: string }>;
  requests: string[];
  terminals: string[];
}
export interface RoundtableStore {
  load(): RoundtableRun[];
  save(run: RoundtableRun): void;
  claim(teamId: string, runId: string): void;
  release(teamId: string): void;
}
export interface RoundtableDeps {
  store: RoundtableStore;
  /** Host authentication/authorization, active team and local controlled Worker validation. */
  authorize(leadSessionId: string, workerId?: string): Promise<{
    teamId: string; workerId?: string; workerSessionId?: string;
  }>;
  dispatchWorker(run: RoundtableRun, message: string, guard: () => Promise<void>): Promise<void>;
  dispatchLead(run: RoundtableRun, message: string, guard: () => Promise<void>): Promise<void>;
}
const terminal = (run: RoundtableRun) => ['stopped', 'completed', 'failed'].includes(run.state);
export class OrcaRoundtable {
  private runs = new Map<string, RoundtableRun>();
  private busy = new Set<string>();
  private leadExecutions = new Map<string, { instanceId: string; generation: number }>();
  private deferredLeadTerminals = new Map<string, Array<{
    sessionId: string; execution: { instanceId: string; generation: number }; successful: boolean;
  }>>();
  private recoveredRuns = new Set<string>();
  constructor(private readonly deps: RoundtableDeps) {
    for (const saved of deps.store.load()) {
      // Never replay uncertain writes, or assume that another process's runtime stopped.
      const run = structuredClone(saved);
      if (!terminal(run) || run.inFlight || run.leadActive) {
        run.state = 'uncertain'; run.reason = 'recovery_required'; this.recoveredRuns.add(run.runId);
      }
      this.runs.set(run.runId, run);
    }
  }
  private save(run: RoundtableRun) { this.deps.store.save(structuredClone(run)); }
  private snapshot(run: RoundtableRun) { return structuredClone(run); }
  runsForLead(leadSessionId: string): RoundtableRun[] {
    return [...this.runs.values()].filter(r => r.leadSessionId === leadSessionId).map(r => this.snapshot(r));
  }
  ownsWorker(sessionId: string) {
    return [...this.runs.values()].some(r => r.workerSessionId === sessionId
      && (this.recoveredRuns.has(r.runId) || (r.inFlight && !!r.workerExecutionId)));
  }
  ownsWorkerId(workerId: string) {
    return [...this.runs.values()].some(r => r.workerId === workerId
      && (this.recoveredRuns.has(r.runId) || (r.inFlight && !!r.workerExecutionId)));
  }
  ownsLead(sessionId: string) {
    return [...this.runs.values()].some(r => r.leadSessionId === sessionId && (!terminal(r) || r.inFlight || r.leadActive));
  }
  private end(run: RoundtableRun, state: 'completed' | 'failed', reason: string) {
    run.state = state; run.reason = reason;
    if (!run.inFlight) run.currentAgent = run.leadActive ? run.leadSessionId : null;
    run.pending = undefined;
    this.save(run);
    if (!run.inFlight && !run.leadActive) this.deps.store.release(run.teamId);
  }
  async command(input: RoundtableRequest): Promise<RoundtableRun> {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(input.runId)) throw new Error('INVALID_RUN_ID');
    // The host supplies the attested caller and selects this owner-scoped controller.
    // Historical status must remain readable after a Team is ended or replaced.
    if (input.action === 'getStatus') {
      const saved = this.runs.get(input.runId);
      if (!saved || saved.leadSessionId !== input.callerSessionId) throw new Error('NOT_AUTHORIZED');
      return this.snapshot(saved);
    }
    // Controls stay responsive during awaits; only schedule-changing commands take this lock.
    const control = ['pause', 'stop', 'getStatus'].includes(input.action);
    if (!control && this.busy.has(input.runId)) throw new Error('ROUNDTABLE_BUSY');
    if (!control) this.busy.add(input.runId);
    try {
      const identity = await this.deps.authorize(input.callerSessionId, input.workerId);
      let run = this.runs.get(input.runId);
      if (input.action === 'start') {
        if (run) {
          if (run.leadSessionId !== input.callerSessionId || run.teamId !== identity.teamId) throw new Error('NOT_AUTHORIZED');
          return this.snapshot(run); // Idempotent even after completion. Never restart this ID.
        }
        if ([...this.runs.values()].some(r => (r.teamId === identity.teamId || r.leadSessionId === input.callerSessionId)
          && (!terminal(r) || r.inFlight || r.leadActive))) throw new Error('TEAM_BUSY');
        this.deps.store.claim(identity.teamId, input.runId);
        run = { runId: input.runId, teamId: identity.teamId, leadSessionId: input.callerSessionId,
          state: 'running', phase: 'decision', speeches: 1, completedTurns: 0,
          currentAgent: input.callerSessionId, inFlight: false, leadActive: true, reason: null,
          messages: [], requests: [], terminals: [] };
        this.save(run); this.runs.set(run.runId, run);
        return this.snapshot(run);
      }
      if (!run || run.teamId !== identity.teamId || run.leadSessionId !== input.callerSessionId) throw new Error('NOT_AUTHORIZED');
      if (input.action === 'pause') {
        if (!terminal(run) && run.state !== 'uncertain') { run.state = 'paused'; run.reason = 'user_paused'; this.save(run); }
        return this.snapshot(run);
      }
      if (input.action === 'stop') {
        if (terminal(run)) return this.snapshot(run);
        if (run.state === 'uncertain') {
          run.state = 'stopped'; run.inFlight = true; run.reason = 'stop_requested_execution_unconfirmed'; run.pending = undefined;
          this.save(run); return this.snapshot(run);
        }
        run.state = 'stopped'; run.reason = run.inFlight || run.leadActive ? 'stop_requested_in_flight_not_aborted' : 'user_stopped';
        run.pending = undefined; this.save(run);
        if (!run.inFlight && !run.leadActive) this.deps.store.release(run.teamId);
        return this.snapshot(run);
      }
      if (terminal(run) || run.state === 'uncertain') throw new Error('RUN_NOT_RESUMABLE');
      if (input.action === 'resume') {
        if (run.state === 'paused') { run.state = 'running'; run.reason = null; this.save(run); }
        if (run.pending && !run.inFlight) await this.deliver(run);
        return this.snapshot(run);
      }
      if (run.state !== 'running') throw new Error('RUN_PAUSED');
      if (input.action === 'finish') {
        if (run.phase !== 'decision' || run.inFlight) throw new Error('EXECUTION_IN_FLIGHT');
        run.completedTurns++; this.end(run, 'completed', 'lead_finished'); return this.snapshot(run);
      }
      if (!input.requestId || input.requestId.length > 100) throw new Error('REQUEST_ID_REQUIRED');
      if (run.requests.includes(input.requestId)) return this.snapshot(run);
      if (run.phase !== 'decision' || run.inFlight) throw new Error('WAIT_FOR_WORKER_RESULT');
      if (!identity.workerId || !identity.workerSessionId || !input.message?.trim() || input.message.length > 32000) throw new Error('INVALID_DISPATCH');
      run.workerId = identity.workerId; run.workerSessionId = identity.workerSessionId;
      run.completedTurns++;
      run.requests.push(input.requestId);
      run.messages.push({ requestId: input.requestId, target: identity.workerSessionId, message: input.message });
      run.pending = { target: 'worker', message: input.message }; this.save(run);
      await this.deliver(run);
      return this.snapshot(run);
    } finally { if (!control) await this.unlock(input.runId); }
  }
  private async unlock(runId: string) {
    this.busy.delete(runId);
    const deferred = this.deferredLeadTerminals.get(runId) ?? [];
    this.deferredLeadTerminals.delete(runId);
    for (const item of deferred) await this.leadSettled(item.sessionId, item.execution, item.successful);
  }
  /** Only the Orca accepted boundary may bind this identity; preparing is not accepted. */
  workerAccepted(sessionId: string, executionId: string) {
    const run = [...this.runs.values()].find(r => r.workerSessionId === sessionId
      && r.inFlight && r.phase === 'worker' && r.pending?.target === 'worker' && r.state === 'running');
    if (!run) return;
    run.workerExecutionId = executionId; this.save(run);
  }
  private async deliver(run: RoundtableRun) {
    if (run.state !== 'running' || !run.pending || run.inFlight) return;
    if (run.speeches >= 6) { this.end(run, 'completed', 'speech_limit'); return; }
    const pending = run.pending;
    const check = async () => {
      const identity = await this.deps.authorize(run.leadSessionId, run.workerId);
      if (identity.teamId !== run.teamId || identity.workerSessionId !== run.workerSessionId) throw new Error('TEAM_CHANGED');
      if (run.state !== 'running' || run.pending !== pending) throw new Error('DISPATCH_CANCELLED');
    };
    try { await check(); }
    catch {
      if (run.state === 'running') { run.state = 'paused'; run.reason = 'authorization_or_team_changed'; }
      this.save(run);
      return;
    }
    // Journal before any external side effect. A crash here requires reconciliation, never replay.
    if (pending.target === 'worker') run.workerExecutionId = undefined;
    run.inFlight = true; run.currentAgent = pending.target === 'worker' ? run.workerSessionId! : run.leadSessionId;
    run.phase = pending.target === 'worker' ? 'worker' : 'report'; this.save(run);
    try {
      if (pending.target === 'worker') await this.deps.dispatchWorker(this.snapshot(run), pending.message, check);
      else await this.deps.dispatchLead(this.snapshot(run), pending.message, check);
      run.speeches++;
      // Lead report acceptance is a new decision turn, not a Worker execution.
      if (pending.target === 'lead') { run.inFlight = false; run.leadActive = true; run.phase = 'decision'; }
      if (run.pending === pending) run.pending = undefined;
      this.save(run);
      if (run.pending && !run.inFlight && run.state === 'running') await this.deliver(run);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Only the adapter's proven pre-dispatch refusal is safe to retry on explicit resume.
      if (message === 'NOT_DISPATCHED') {
        run.inFlight = false;
        if (!terminal(run)) { run.state = 'paused'; run.reason = 'target_busy_or_cancelled_before_dispatch'; }
        else { run.pending = undefined; if (!run.leadActive) this.deps.store.release(run.teamId); }
      } else { run.state = 'uncertain'; run.reason = 'delivery_unconfirmed'; }
      this.save(run);
    }
  }
  noteLeadExecution(runId: string, execution: { instanceId: string; generation: number }, onlyIfAbsent = false) {
    if (onlyIfAbsent && this.leadExecutions.has(runId)) return;
    this.leadExecutions.set(runId, execution);
  }
  /** Product Lead terminal, also the wakeup for a result waiting behind its initial turn. */
  async leadSettled(sessionId: string, execution: { instanceId: string; generation: number }, successful: boolean) {
    const run = [...this.runs.values()].find(r => r.leadSessionId === sessionId && (!terminal(r) || r.leadActive));
    if (!run || run.state === 'uncertain') return;
    if (this.busy.has(run.runId)) {
      const deferred = this.deferredLeadTerminals.get(run.runId) ?? [];
      const duplicate = deferred.some(item => item.execution.instanceId === execution.instanceId && item.execution.generation === execution.generation);
      if (!duplicate) deferred.push({ sessionId, execution, successful });
      this.deferredLeadTerminals.set(run.runId, deferred);
      return;
    }
    const expected = this.leadExecutions.get(run.runId);
    const matches = expected && expected.instanceId === execution.instanceId && expected.generation === execution.generation;
    if (matches) {
      run.leadActive = false;
      if (run.currentAgent === sessionId && !run.inFlight) run.currentAgent = null;
      this.save(run);
    }
    if (terminal(run)) { if (!run.inFlight && !run.leadActive) this.deps.store.release(run.teamId); return; }
    if (matches && !successful) { this.end(run, 'failed', 'lead_failed'); return; }
    if (matches && run.state === 'paused' && run.reason === 'target_busy_or_cancelled_before_dispatch' && run.pending?.target === 'lead') {
      run.state = 'running'; run.reason = null; this.save(run);
      this.busy.add(run.runId);
      try { await this.deliver(run); } finally { await this.unlock(run.runId); }
      return;
    }
    if (run.state === 'running' && run.phase === 'decision' && !run.inFlight && matches) {
      run.completedTurns++;
      this.end(run, successful ? 'completed' : 'failed', successful ? 'lead_finished' : 'lead_failed');
    }
  }
  /** Called only by Orca's product-terminal auto-bridge boundary, not a vendor event. */
  async workerCompleted(input: { sessionId: string; eventId: string; status: 'done' | 'error'; result: string }): Promise<boolean> {
    if ([...this.runs.values()].some(r => r.terminals.includes(input.eventId))) return true;
    const recovered = [...this.runs.values()].find(r => r.workerSessionId === input.sessionId && this.recoveredRuns.has(r.runId));
    if (recovered) {
      // Rehydrated auto-bridge/manual reports must not escape via ordinary Orca delivery.
      recovered.terminals.push(input.eventId); this.save(recovered); return true;
    }
    const run = [...this.runs.values()].find(r => r.workerSessionId === input.sessionId && r.inFlight && r.phase === 'worker');
    if (!run) return false;
    if (run.workerExecutionId !== input.eventId) return false;
    if (run.terminals.includes(input.eventId) || run.phase !== 'worker') return true;
    run.terminals.push(input.eventId); run.completedTurns++; run.inFlight = false;
    run.currentAgent = run.leadActive ? run.leadSessionId : null;
    const last = run.messages.at(-1); if (last) last.result = input.result;
    if (terminal(run)) { this.save(run); if (!run.leadActive) this.deps.store.release(run.teamId); return true; }
    if (run.state === 'uncertain') { this.save(run); return true; }
    if (input.status === 'error') { this.end(run, 'failed', 'worker_failed'); return true; }
    run.phase = 'report';
    run.pending = { target: 'lead', message: `${input.result}\n\nRoundtable ${run.runId}: inspect this actual Worker result. Use roundtable dispatch with a NEW request_id for a follow-up (including another authorized Worker), or roundtable finish. Do not use send_to_worker for this run. Maximum six Agent turns including yours.` };
    this.save(run);
    // An extremely fast terminal may arrive while the Worker dispatch receipt is settling.
    if (this.busy.has(run.runId)) return true;
    this.busy.add(run.runId);
    try { await this.deliver(run); } finally { await this.unlock(run.runId); }
    return true;
  }
}

/** Shared accepted/terminal identity bridge; getter also loads crash journals before routing. */
export function createRoundtableCompletionRouter(getController: () => OrcaRoundtable, createId: () => string) {
  const identities = new WeakMap<object, string>();
  const executionId = (identity: object) => {
    let id = identities.get(identity);
    if (!id) { id = createId(); identities.set(identity, id); }
    return id;
  };
  return {
    accepted: (sessionId: string, identity: object) => getController().workerAccepted(sessionId, executionId(identity)),
    completed: (input: { sessionId: string; identity: object; status: 'done' | 'error'; result: string }) =>
      getController().workerCompleted({ ...input, eventId: executionId(input.identity) }),
  };
}
