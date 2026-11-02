import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';

import { createOrcaMcpServer, type OrcaMcpDeps, type OrcaMcpSessionCtx } from './server.js';

const BASE = {
  ok: true as const,
  worker_id: 'w-1',
  session_id: 's-1',
  status: 'done',
  session_status: 'idle',
  idle_ms: 0,
  restored_from_storage: false,
  result: 'partial output',
};

function payloadOf(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  const first = content[0];
  if (!first?.text) throw new Error('missing text payload');
  return JSON.parse(first.text) as Record<string, unknown>;
}

async function harness(readWorker: OrcaMcpDeps['readWorker']) {
  const server = createOrcaMcpServer({ readWorker } as unknown as OrcaMcpDeps, {
    agentKind: 'claude-code',
    workingDir: '/tmp',
    sessionId: 'lead-1',
  } as OrcaMcpSessionCtx);
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'orca-test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe('cindy_orca.read_worker', () => {
  it('把本轮 terminal error 一并交给 Lead', async () => {
    const turnError = {
      message: 'Rate limit reached',
      reason: 'rate_limit',
      createdAt: '2026-10-11T00:00:00.000Z',
    };
    const h = await harness(async () => ({ ...BASE, turnError }));
    const payload = payloadOf(
      await h.client.callTool({ name: 'read_worker', arguments: { worker_id: 'w-1' } }),
    );
    expect(payload.ok).toBe(true);
    expect(payload.turnError).toEqual(turnError);
    await h.cleanup();
  });

  it('本轮没有失败时 turnError 为 null,而不是悄悄缺字段', async () => {
    const h = await harness(async () => ({ ...BASE, turnError: null }));
    const payload = payloadOf(
      await h.client.callTool({ name: 'read_worker', arguments: { worker_id: 'w-1' } }),
    );
    expect(payload.ok).toBe(true);
    expect(payload.turnError).toBeNull();
    await h.cleanup();
  });
});

// Unit tier: real MCP transport and existing Host authorizer, no model/runtime.
describe('cindy_orca.roundtable authenticated routing', () => {
  async function roundtableHarness(role: 'lead' | 'worker', allowed = true) {
    const call = vi.fn(async params => ({ runId: params.runId }));
    const authorize = vi.fn(async () => allowed ? { ok: true as const } : { ok: false as const, errorCode: 'DENIED', message: 'No authority' });
    const server = createOrcaMcpServer({ roundtable: call, authorizeCall: authorize } as unknown as OrcaMcpDeps, {
      sessionId: 'real-session', agentKind: 'claude-code', workingDir: '/tmp', vendorOptions: { orcaRole: role },
    } as OrcaMcpSessionCtx);
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'roundtable-test', version: '1' });
    await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
    return { call, authorize, client, close: async () => { await client.close(); await server.close(); } };
  }
  it('uses attested caller identity rather than a supplied Lead ID', async () => {
    const h = await roundtableHarness('lead');
    try {
      expect(payloadOf(await h.client.callTool({ name: 'roundtable', arguments: { action: 'start', run_id: 'r1', callerSessionId: 'forged' } })).ok).toBe(true);
      expect(h.call).toHaveBeenCalledWith(expect.objectContaining({ callerSessionId: 'real-session', runId: 'r1' }));
      expect(h.authorize).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'real-session', server: 'cindy_orca', tool: 'roundtable' }));
    } finally { await h.close(); }
  });
  it.each(['worker', 'denied'] as const)('does not call the controller for %s', async mode => {
    const h = await roundtableHarness(mode === 'worker' ? 'worker' : 'lead', mode !== 'denied');
    try {
      expect(payloadOf(await h.client.callTool({ name: 'roundtable', arguments: { action: 'start', run_id: 'r1' } })).ok).toBe(false);
      expect(h.call).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });
});
