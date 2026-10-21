/** Allowlisted diagnostics: never contains keys, prompts, headers or URL paths. */
export interface TaskTelemetryReceipt {
  taskExecutionId: string;
  conversationId: string;
  traceId: string | null;
  protocol: string | null;
  environment: string;
  status: string;
  attemptCount: number;
  dropReason: string | null;
  updatedAt: number;
}
export interface TelemetryDiagnostics {
  schemaVersion: 1;
  consent: { metrics: boolean; content: boolean };
  readyToSend: boolean;
  blockedReason: string | null;
  task: {
    environment: string | null;
    effectiveMode: string;
    taskProtocol: string;
    effectiveSink: { kind: string; host: string | null; protocol: string | null };
  };
  recentTasks: TaskTelemetryReceipt[];
  remoteVerification: 'not_checked';
}
