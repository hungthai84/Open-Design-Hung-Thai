import type { Express, RequestHandler } from 'express';
import type { TelemetryDiagnostics } from '@open-design/contracts';

export function registerTelemetryDiagnosticsRoutes(app: Express, deps: {
  requireLocalDaemonRequest: RequestHandler;
  readDiagnostics: (traceId?: string) => Promise<TelemetryDiagnostics>;
}): void {
  app.get('/api/telemetry/diagnostics', deps.requireLocalDaemonRequest, async (req, res) => {
    const traceId = req.query.traceId;
    if (traceId !== undefined && (typeof traceId !== 'string' || !/^[A-Za-z0-9:_-]{1,200}$/.test(traceId))) {
      res.status(400).json({ error: 'invalid_trace_id' }); return;
    }
    try { res.json(await deps.readDiagnostics(traceId as string | undefined)); }
    catch { res.status(503).json({ error: 'telemetry_diagnostics_unavailable' }); }
  });
}
