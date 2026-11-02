import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { RoundtableRun, RoundtableStore } from './orcaRoundtable.js';

/** Owner-scoped journal. Exclusive team claims fail closed across processes and crashes. */
export function createRoundtableStore(root: string): RoundtableStore {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const key = (value: string) => createHash('sha256').update(value).digest('hex');
  const claimPath = (id: string) => path.join(root, `${key(id)}.claim`);
  const ownedClaims = new Set<string>();
  return {
    load: () => fs.readdirSync(root).filter(f => f.endsWith('.json')).map(f => {
      const run = JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')) as RoundtableRun;
      if (!run.runId || !run.teamId || !Array.isArray(run.messages) || !Array.isArray(run.terminals)) throw new Error('INVALID_ROUNDTABLE_JOURNAL');
      return run;
    }),
    save: run => {
      const dest = path.join(root, `${key(run.runId)}.json`);
      const temp = `${dest}.${randomUUID()}.tmp`;
      try { fs.writeFileSync(temp, JSON.stringify(run), { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, dest); }
      finally { fs.rmSync(temp, { force: true }); }
    },
    claim: (id, runId) => {
      fs.writeFileSync(claimPath(id), '', { mode: 0o600, flag: 'wx' });
      try { fs.writeFileSync(path.join(root, `${key(runId)}.run-claim`), '', { mode: 0o600, flag: 'wx' }); }
      catch (error) { fs.rmSync(claimPath(id), { force: true }); throw error; }
      ownedClaims.add(id);
    },
    release: id => {
      if (ownedClaims.delete(id)) fs.rmSync(claimPath(id), { force: true });
    },
  };
}
