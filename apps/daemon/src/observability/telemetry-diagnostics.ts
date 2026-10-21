import type Database from 'better-sqlite3';
import type { TelemetryDiagnostics, TaskTelemetryReceipt } from '@open-design/contracts';
import type { TelemetryPrefs } from '../app-config.js';
import type { TaskObservationRolloutDiagnostic } from './task-observation-rollout.js';

/** Capture identity at export time; never infer historical IDs from today's config. */
export function initializeTaskTraceReceipts(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS strategy_task_trace_receipts (
    task_execution_id TEXT PRIMARY KEY,
    trace_id TEXT NOT NULL,
    protocol TEXT NOT NULL,
    FOREIGN KEY(task_execution_id) REFERENCES strategy_task_executions(task_execution_id) ON DELETE CASCADE
  )`);
}
export function recordTaskTraceReceipt(db: Database.Database, taskId: string, traceId: string, protocol: string): void {
  db.prepare(`INSERT INTO strategy_task_trace_receipts VALUES (?, ?, ?)
    ON CONFLICT(task_execution_id) DO UPDATE SET trace_id = excluded.trace_id, protocol = excluded.protocol`)
    .run(taskId, traceId, protocol);
}
export function readTelemetryDiagnostics(db: Database.Database, prefs: TelemetryPrefs, task: TaskObservationRolloutDiagnostic, traceId?: string): TelemetryDiagnostics {
  const blockedReason = prefs.metrics !== true ? 'metrics_consent_off'
    : prefs.content !== true ? 'content_consent_off' : task.blockedReason;
  const recentTasks = db.prepare(`SELECT d.task_execution_id AS taskExecutionId,
    t.conversation_id AS conversationId, r.trace_id AS traceId, r.protocol,
    d.environment, d.status, d.attempt_count AS attemptCount, d.drop_reason AS dropReason,
    d.updated_at AS updatedAt
    FROM strategy_task_observation_delivery d
    JOIN strategy_task_executions t ON t.task_execution_id = d.task_execution_id
    LEFT JOIN strategy_task_trace_receipts r ON r.task_execution_id = d.task_execution_id
    WHERE (? IS NULL OR r.trace_id = ?)
    ORDER BY d.updated_at DESC, d.task_execution_id LIMIT 20`).all(traceId ?? null, traceId ?? null) as TaskTelemetryReceipt[];
  return {
    schemaVersion: 1,
    consent: { metrics: prefs.metrics === true, content: prefs.content === true },
    readyToSend: blockedReason === null, blockedReason,
    task: { environment: task.environment, effectiveMode: task.effectiveMode,
      taskProtocol: task.taskProtocol, effectiveSink: task.effectiveSink },
    recentTasks, remoteVerification: 'not_checked',
  };
}
