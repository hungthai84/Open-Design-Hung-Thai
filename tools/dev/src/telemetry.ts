import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TaskTelemetryReceipt, TelemetryDiagnostics } from '@open-design/contracts';

const execute = promisify(execFile);
export type TelemetryCheck = { status: string; diagnostics?: TelemetryDiagnostics };
export async function readTelemetryStatus(daemonUrl: string | null, traceId?: string): Promise<TelemetryCheck> {
  if (!daemonUrl) return { status: 'daemon_not_running' };
  try {
    const url = new URL('/api/telemetry/diagnostics', daemonUrl);
    if (traceId) url.searchParams.set('traceId', traceId);
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return { status: response.status === 404 ? 'diagnostics_unsupported_restart_required' : 'diagnostics_unavailable' };
    const diagnostics = await response.json() as TelemetryDiagnostics;
    if (diagnostics.schemaVersion !== 1 || !Array.isArray(diagnostics.recentTasks)
      || typeof diagnostics.readyToSend !== 'boolean' || !diagnostics.consent || !diagnostics.task?.effectiveSink) {
      return { status: 'diagnostics_invalid' };
    }
    return { status: diagnostics.readyToSend ? 'ready' : 'blocked', diagnostics };
  } catch { return { status: 'diagnostics_unavailable' }; }
}

/** Read-only, bounded, uses the existing ODEval login. Raw trace bodies never reach stdout. */
export async function queryOdevalTrace(traceId: string, profile?: string): Promise<unknown> {
  const args = ['session-observatory', `trace:${traceId}`, '--json'];
  if (profile) args.push('--profile', profile);
  const { stdout } = await execute('od-evals', args, { timeout: 45_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  return JSON.parse(stdout);
}

export async function verifyTelemetryTrace(
  local: TaskTelemetryReceipt,
  query: (traceId: string) => Promise<unknown>,
): Promise<{ status: string; traceId: string | null; taskExecutionId: string; remoteErrorCode?: string }> {
  const identity = { traceId: local.traceId, taskExecutionId: local.taskExecutionId };
  if (!local.traceId) return { ...identity, status: 'trace_identity_unavailable' };
  if (local.status !== 'accepted') return { ...identity, status: 'delivery_not_accepted' };
  let body: any;
  try { body = await query(local.traceId); }
  catch (error) {
    const failure = error as { code?: string; killed?: boolean };
    let remoteErrorCode = failure.code === 'ENOENT' ? 'odeval_not_installed'
      : failure.killed ? 'query_timeout' : 'query_failed';
    // Never forward stderr: it can include credentials or trace content.
    try {
      const parsed = JSON.parse((error as { stderr?: string }).stderr ?? '');
      if (['not_found', 'unauthorized', 'forbidden'].includes(parsed.code)) remoteErrorCode = parsed.code;
    } catch { /* opaque transport/process failure */ }
    return { ...identity, status: 'remote_query_failed', remoteErrorCode };
  }
  const matches = Array.isArray(body?.traces)
    ? body.traces.filter((entry: any) => entry?.trace?.id === local.traceId) : [];
  if (matches.length !== 1) return { ...identity, status: 'remote_trace_missing_or_ambiguous' };
  const trace = matches[0].trace;
  if (trace.sessionId !== local.conversationId || trace.metadata?.taskExecutionId !== local.taskExecutionId
    || trace.environment !== local.environment) return { ...identity, status: 'remote_identity_mismatch' };
  return { ...identity, status: 'verified' };
}

export function telemetrySummary(check: TelemetryCheck): string {
  const d = check.diagnostics;
  if (!d) return `telemetry: ${check.status}`;
  return `telemetry: ${check.status}${d.blockedReason ? ` (${d.blockedReason})` : ''}; task sink=${d.task.effectiveSink.kind}/${d.task.effectiveSink.host ?? 'none'}; environment=${d.task.environment ?? 'none'}; protocol=${d.task.taskProtocol}; remote=not_checked`;
}
