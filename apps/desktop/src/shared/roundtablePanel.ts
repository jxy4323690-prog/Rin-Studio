export const ROUNDTABLE_PANEL_CHANNEL = 'maker:roundtable:panel';
export type RoundtablePanelAction = 'getStatus' | 'pause' | 'resume' | 'stop';
export interface RoundtablePanelRequest { leadSessionId: string; runId?: string; action: RoundtablePanelAction }
export interface RoundtablePanelRun {
  runId: string; teamId: string; leadSessionId: string; workerId?: string; workerSessionId?: string;
  state: string; currentAgent: string | null; speeches: number; completedTurns: number;
  inFlight: boolean; leadActive: boolean; reason: string | null;
  messages: Array<{ requestId: string; target: string; message: string; result?: string }>;
}
export interface RoundtablePanelSnapshot {
  runs: Array<{ runId: string; state: string }>;
  run: RoundtablePanelRun | null;
  leadReturns: string[];
}
