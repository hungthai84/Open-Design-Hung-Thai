import { once } from 'node:events';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyTelemetryTrace } from '../src/telemetry.js';

const local = { taskExecutionId: 'task-1', conversationId: 'session-1', traceId: 'trace-1', environment: 'qa', status: 'accepted', protocol: 'legacy-v1', attemptCount: 1, dropReason: null, updatedAt: 100 };
test('verification requires exact remote identity, not merely a successful command', async () => {
  const result = await verifyTelemetryTrace(local, async () => ({ traces: [{ trace: { id: 'trace-1', sessionId: 'session-1', environment: 'qa', metadata: { taskExecutionId: 'task-1' } } }] }));
  assert.equal(result.status, 'verified');
  for (const trace of [
    { id: 'different' },
    { id: 'trace-1', sessionId: 'wrong', environment: 'qa', metadata: { taskExecutionId: 'task-1' } },
    { id: 'trace-1', sessionId: 'session-1', environment: 'wrong', metadata: { taskExecutionId: 'task-1' } },
    { id: 'trace-1', sessionId: 'session-1', environment: 'qa', metadata: { taskExecutionId: 'wrong' } },
  ]) assert.notEqual((await verifyTelemetryTrace(local, async () => ({ traces: [{ trace }] }))).status, 'verified');
});
test('missing persisted identity and unaccepted delivery cannot pass or query remotely', async () => {
  const query = async () => { throw new Error('must not query'); };
  assert.equal((await verifyTelemetryTrace({ ...local, traceId: null }, query)).status, 'trace_identity_unavailable');
  assert.equal((await verifyTelemetryTrace({ ...local, status: 'pending' }, query)).status, 'delivery_not_accepted');
});
test('remote errors and duplicate identities fail without leaking content', async () => {
  const result = await verifyTelemetryTrace(local, async () => { throw new Error('secret token prompt'); });
  assert.equal(result.status, 'remote_query_failed');
  assert.doesNotMatch(JSON.stringify(result), /secret|token|prompt/);
  const trace = { id: 'trace-1', sessionId: 'session-1', environment: 'qa', metadata: { taskExecutionId: 'task-1' } };
  assert.equal((await verifyTelemetryTrace(local, async () => ({ traces: [{ trace }, { trace }] }))).status, 'remote_trace_missing_or_ambiguous');
});

test('runtime HTTP state is authoritative; absent/old/invalid daemons are not ready', async () => {
  const { createServer } = await import('node:http');
  const { readTelemetryStatus } = await import('../src/telemetry.js');
  let code = 200; let body: unknown = { schemaVersion: 1, readyToSend: false, consent: { metrics: false, content: false }, task: { effectiveSink: { kind: 'none' } }, recentTasks: [] };
  const server = createServer((req, res) => { assert.match(req.url!, /^\/api\/telemetry\/diagnostics/); res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    assert.equal((await readTelemetryStatus(null)).status, 'daemon_not_running');
    assert.equal((await readTelemetryStatus(base, 'trace-1')).status, 'blocked');
    code = 404; assert.equal((await readTelemetryStatus(base)).status, 'diagnostics_unsupported_restart_required');
    code = 503; assert.equal((await readTelemetryStatus(base)).status, 'diagnostics_unavailable');
    code = 200; body = {}; assert.equal((await readTelemetryStatus(base)).status, 'diagnostics_invalid');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
