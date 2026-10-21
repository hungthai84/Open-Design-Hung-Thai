import Database from 'better-sqlite3';
import express from 'express';
import { once } from 'node:events';
import { describe, it, expect } from 'vitest';
import { initializeTaskTraceReceipts, recordTaskTraceReceipt, readTelemetryDiagnostics } from '../src/observability/telemetry-diagnostics.js';
import { registerTelemetryDiagnosticsRoutes } from '../src/routes/telemetry-diagnostics.js';
import { requireLocalDaemonRequest } from '../src/http/local-daemon-request.js';

const task = { requestedMode: 'auto', mode: 'send', effectiveMode: 'send', environment: 'qa', tag: 'qa', effectiveSink: { kind: 'relay', host: 'telemetry.example', protocol: 'https' }, taskProtocol: 'legacy-v1', readyToSend: true, schemaReady: true, blockedReason: null } as const;
function database() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE strategy_task_executions (task_execution_id TEXT PRIMARY KEY, conversation_id TEXT);
    CREATE TABLE strategy_task_observation_delivery (task_execution_id TEXT, environment TEXT, status TEXT, attempt_count INTEGER, drop_reason TEXT, updated_at INTEGER);
    INSERT INTO strategy_task_executions VALUES ('t1','s1');
    INSERT INTO strategy_task_observation_delivery VALUES ('t1','qa','accepted',1,NULL,10);`);
  initializeTaskTraceReceipts(db); return db;
}
describe('telemetry diagnostics', () => {
  it('preserves unknown historical identity and records the sending identity across restart/config change', () => {
    const db = database();
    try {
      expect(readTelemetryDiagnostics(db, { metrics: true, content: true }, task).recentTasks[0]!.traceId).toBeNull();
      recordTaskTraceReceipt(db, 't1', 'actual-export-id', 'legacy-v1');
      initializeTaskTraceReceipts(db);
      const result = readTelemetryDiagnostics(db, { metrics: true, content: true }, { ...task, taskProtocol: 'otlp-v4' }, 'actual-export-id');
      expect(result.readyToSend).toBe(true);
      expect(result.remoteVerification).toBe('not_checked');
      expect(result.recentTasks[0]).toMatchObject({ traceId: 'actual-export-id', protocol: 'legacy-v1', conversationId: 's1' });
      expect(readTelemetryDiagnostics(db, {}, task).blockedReason).toBe('metrics_consent_off');
      expect(readTelemetryDiagnostics(db, { metrics: true }, task).blockedReason).toBe('content_consent_off');
      expect(readTelemetryDiagnostics(db, { metrics: true, content: true }, { ...task, blockedReason: 'missing_sink', readyToSend: false }).blockedReason).toBe('missing_sink');
      expect(readTelemetryDiagnostics(db, { metrics: true, content: true }, task, 'unknown').recentTasks).toEqual([]);
    } finally { db.close(); }
  });
  it('serves local HTTP diagnostics, rejects foreign origins, and does not expose exception secrets', async () => {
    const db = database(); const app = express(); let fail = false;
    registerTelemetryDiagnosticsRoutes(app, { requireLocalDaemonRequest, readDiagnostics: async (id) => {
      if (fail) throw new Error('secret-token');
      return readTelemetryDiagnostics(db, { metrics: true, content: true }, task, id);
    } });
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/telemetry/diagnostics`;
    try {
      expect(((await (await fetch(url)).json()) as { readyToSend: boolean }).readyToSend).toBe(true);
      expect((await fetch(url, { headers: { Origin: 'https://untrusted.example' } })).status).toBe(403);
      expect((await fetch(url + '?traceId=%20')).status).toBe(400);
      fail = true; const response = await fetch(url); expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('secret-token');
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); db.close(); }
  });
});
