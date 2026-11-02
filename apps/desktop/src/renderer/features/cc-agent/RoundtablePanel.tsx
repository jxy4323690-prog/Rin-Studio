import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { RoundtablePanelSnapshot, RoundtablePanelAction } from '../../../shared/roundtablePanel';
import { parseOrcaCommunicationContent } from '@/components/chat/userMessageDisplayText';

/** Read-only projection; all scheduling and authorization remain in Main. No polling. */
export function RoundtablePanel({ leadSessionId }: { leadSessionId: string }) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<RoundtablePanelSnapshot | null>(null);
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const version = useRef(0);
  const refresh = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let active = true;
    const load = async () => {
      const revision = ++version.current;
      try {
        const data = await window.electronAPI.localDb.orcaWorkflows.roundtablePanel({ leadSessionId, runId: selected, action: 'getStatus' });
        if (active && revision === version.current) { setSnapshot(data); setError(false); }
      } catch { if (active && revision === version.current) { setSnapshot(null); setError(true); } }
    };
    refresh.current = load;
    setSnapshot(null); void load();
    const unsubscribe = window.electronAPI.localDb.orcaWorkflows.onOrcaWorkerChanged(payload => {
      if ((payload as { leadSessionId?: string })?.leadSessionId === leadSessionId) void load();
    });
    const unsubscribeOwner = window.electronAPI.onAuthStateChange?.(() => {
      version.current++; setSnapshot(null); setSelected(undefined); void load();
    });
    return () => { active = false; version.current++; unsubscribe(); unsubscribeOwner?.(); };
  }, [leadSessionId, selected]);
  const control = async (action: RoundtablePanelAction) => {
    if (!snapshot?.run || busy) return;
    setBusy(true);
    try {
      await window.electronAPI.localDb.orcaWorkflows.roundtablePanel({ leadSessionId, runId: snapshot.run.runId, action });
      await refresh.current();
    } catch { setSnapshot(null); setError(true); }
    finally { setBusy(false); }
  };
  const run = snapshot?.run;
  const terminal = run && ['completed', 'failed', 'stopped'].includes(run.state);
  const unmatchedReturns = [...(snapshot?.leadReturns ?? [])];
  const timeline = run?.messages.map(message => {
    const index = message.result ? unmatchedReturns.findIndex(body => body.startsWith(`${message.result}\n\nRoundtable ${run.runId}:`)) : -1;
    return { ...message, returned: index < 0 ? undefined : unmatchedReturns.splice(index, 1)[0] };
  }) ?? [];
  const hasActiveRun = snapshot?.runs.some(r => ['running', 'paused', 'uncertain'].includes(r.state));
  return <section aria-label="Roundtable" className="max-h-[50%] shrink-0 overflow-auto border-b border-border/40 bg-content-area p-3 text-xs text-foreground">
    <div className="flex flex-wrap items-center gap-2">
      <strong>Roundtable</strong>
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => void refresh.current()}>{t('roundtablePanel.refresh')}</Button>
      {snapshot && snapshot.runs.length > 1 && <select aria-label={t('roundtablePanel.select')} value={selected ?? run?.runId ?? ''}
        className="h-8 max-w-full rounded-full border border-border bg-content-area px-2" onChange={e => setSelected(e.target.value)}>
        {snapshot.runs.map(r => <option key={r.runId} value={r.runId}>{r.runId} · {r.state}</option>)}
      </select>}
    </div>
    {error && <p role="alert">{t('roundtablePanel.error')}</p>}
    {!snapshot && !error && <p role="status">{t('roundtablePanel.loading')}</p>}
    {snapshot && !hasActiveRun && <p className="text-muted-foreground">{t('roundtablePanel.empty')}</p>}
    {run && <>
      <dl className="my-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 break-all">
        <dt>Run ID</dt><dd>{run.runId}</dd><dt>{t('roundtablePanel.state')}</dt><dd>{run.state}</dd>
        <dt>Lead</dt><dd>{run.leadSessionId}</dd><dt>Worker</dt><dd>{run.workerSessionId ?? '—'}</dd>
        <dt>{t('roundtablePanel.agent')}</dt><dd>{run.currentAgent ?? '—'}</dd>
        <dt>{t('roundtablePanel.turns')}</dt><dd>{run.completedTurns} · {t('roundtablePanel.budget', { count: run.speeches })}</dd>
      </dl>
      {run.state === 'uncertain' && <p role="status">{t('roundtablePanel.uncertain')}</p>}
      {(run.inFlight || run.leadActive) && <p role="status">{t(run.state === 'stopped' ? 'roundtablePanel.stopping' : 'roundtablePanel.inFlight')}</p>}
      {run.reason && <p className="my-1 break-words">{t('roundtablePanel.reason')}: {run.reason}</p>}
      <div className="my-2 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={busy || run.state !== 'running'} onClick={() => void control('pause')}>{t('roundtablePanel.pause')}</Button>
        <Button size="sm" variant="secondary" disabled={busy || run.state !== 'paused'} onClick={() => void control('resume')}>{t('roundtablePanel.resume')}</Button>
        <Button size="sm" variant="secondary" disabled={busy || !!terminal} onClick={() => void control('stop')}>{t('roundtablePanel.stop')}</Button>
      </div>
      <details><summary className="cursor-pointer py-2">{t('roundtablePanel.timeline')}</summary>
        <ol className="max-h-60 space-y-3 overflow-auto whitespace-pre-wrap break-words">
          {timeline.map(m => <li key={m.requestId}>
            <strong>{t('roundtablePanel.task')} → {m.target}</strong><p>{m.message}</p>
            {m.result !== undefined && <><strong>{t('roundtablePanel.result')}</strong><p>{m.result}</p></>}
            {m.returned !== undefined && <><strong>{t('roundtablePanel.returned')}</strong><p>{m.returned}</p></>}
          </li>)}
          {unmatchedReturns.map((body, i) => <li key={`return-${i}`}><strong>{t('roundtablePanel.returned')}</strong><p>{parseOrcaCommunicationContent(body)?.content ?? body}</p></li>)}
        </ol>
      </details>
    </>}
  </section>;
}
