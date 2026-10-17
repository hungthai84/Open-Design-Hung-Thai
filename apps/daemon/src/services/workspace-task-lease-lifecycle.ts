import {
  updateVelaTaskLease,
  VelaTaskLeaseError,
  type VelaTaskLease,
  type VelaTaskLeaseInput,
} from '../integrations/vela-task-leases.js';

type Entry = {
  input: VelaTaskLeaseInput;
  configuredEnv?: Record<string, string> | undefined;
  receipt: VelaTaskLease | null;
  timer: ReturnType<typeof setTimeout> | null;
  starting: Promise<VelaTaskLease> | null;
  checking: Promise<void> | null;
  recheckRequested: boolean;
  releaseInterest: (() => void) | null;
  onLost: (code: string) => Promise<void>;
};

/** One live root per physical run/attempt. Backend time owns expiry; any failed
 * heartbeat stops the local process instead of extending an offline lease.
 * A daemon crash stops heartbeats; the server's TTL releases its slot. */
export function createWorkspaceTaskLeaseLifecycle(deps: {
  update?: typeof updateVelaTaskLease;
  onReleaseFailure?: (runId: string) => void;
  retainWorkspace?: (workspaceId: string) => (() => void);
} = {}) {
  const update = deps.update ?? updateVelaTaskLease;
  const entries = new Map<string, Entry>();
  const finishing = new Map<string, Promise<void>>();
  const current = (entry: Entry) => entries.get(entry.input.runId) === entry;
  const release = async (entry: Entry) => {
    if (!entry.receipt) return;
    try {
      await update('release', { ...entry.input, workspaceId: entry.receipt.workspaceId, leaseToken: entry.receipt.leaseToken }, { configuredEnv: entry.configuredEnv });
    } catch {
      // No heartbeat is retained. A lost release cannot grant further calls;
      // the durable server lease expires, so cleanup is bounded by its TTL.
      deps.onReleaseFailure?.(entry.input.runId);
    }
  };
  const finish = (runId: string, attempt: number): Promise<void> => {
    const entry = entries.get(runId);
    if (!entry || entry.input.attempt !== attempt) return Promise.resolve();
    entries.delete(runId);
    entry.releaseInterest?.();
    entry.releaseInterest = null;
    if (entry.timer) clearTimeout(entry.timer);
    const completion = (async () => {
      if (!entry.receipt) {
        try { await entry.starting; } catch { /* Canceled admission may still have returned a receipt. */ }
      }
      await release(entry);
    })();
    finishing.set(runId, completion);
    void completion.finally(() => {
      if (finishing.get(runId) === completion) finishing.delete(runId);
    });
    return completion;
  };
  const lose = async (entry: Entry, code: string) => {
    if (!current(entry)) return;
    entries.delete(entry.input.runId);
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    entry.releaseInterest?.();
    entry.releaseInterest = null;
    try { await entry.onLost(code); }
    catch { deps.onReleaseFailure?.(entry.input.runId); }
    finally {
      // A revocation may arrive while admit is in flight. Release its eventual
      // receipt without ever starting the child or a new heartbeat.
      // Once a receipt exists, start may itself be awaiting this check. Do not
      // await that same start promise before releasing its admitted token.
      if (!entry.receipt) {
        try { await entry.starting; } catch { /* Admission was canceled or denied. */ }
      }
      await release(entry);
    }
  };
  const check = (entry: Entry): Promise<void> => {
    if (!current(entry) || !entry.receipt) return Promise.resolve();
    if (entry.checking) return entry.checking;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    const pending = (async () => {
      try {
        do {
          // An event received after this request began needs a newer authority
          // check; a delayed success cannot consume that invalidation.
          entry.recheckRequested = false;
          const updated = await update('heartbeat', {...entry.input, workspaceId:entry.receipt!.workspaceId, leaseToken:entry.receipt!.leaseToken}, {configuredEnv:entry.configuredEnv});
          if (!updated) throw new VelaTaskLeaseError('workspace_task_lease_invalid_response');
          if (current(entry)) entry.receipt = updated;
        } while (current(entry) && entry.recheckRequested);
      } catch (error) {
        await lose(entry, error instanceof VelaTaskLeaseError ? error.code : 'workspace_task_lease_unavailable');
      } finally {
        entry.checking = null;
        schedule(entry);
      }
    })();
    entry.checking = pending;
    return pending;
  };
  const schedule = (entry: Entry) => {
    if (!current(entry) || !entry.receipt) return;
    entry.timer = setTimeout(() => { void check(entry); }, entry.receipt.heartbeatIntervalMs);
    entry.timer.unref?.();
  };
  return {
    async start(input: VelaTaskLeaseInput, options: {
      configuredEnv?: Record<string, string> | undefined;
      onLost: (code: string) => Promise<void>;
    }): Promise<VelaTaskLease> {
      const previousFinish = finishing.get(input.runId);
      if (previousFinish) await previousFinish;
      const prior = entries.get(input.runId);
      if (prior) {
        if (prior.input.workspaceId !== input.workspaceId || prior.input.attempt !== input.attempt)
          throw new VelaTaskLeaseError('workspace_task_lease_identity_mismatch');
        if (!prior.starting) throw new VelaTaskLeaseError('workspace_task_lease_unavailable');
        return prior.starting;
      }
      const entry: Entry = {
        input, configuredEnv: options.configuredEnv, onLost: options.onLost,
        receipt: null, timer: null, starting: null, checking: null, recheckRequested: false, releaseInterest: null,
      };
      entries.set(input.runId, entry);
      entry.starting = (async () => {
        try {
          const receipt = await update('admit', input, { configuredEnv: entry.configuredEnv });
          if (!receipt) throw new VelaTaskLeaseError('workspace_task_lease_invalid_response');
          entry.receipt = receipt;
          if (!current(entry)) throw new VelaTaskLeaseError('workspace_task_canceled_before_start');
          entry.releaseInterest = deps.retainWorkspace?.(receipt.workspaceId) ?? null;
          if (entry.recheckRequested) await check(entry);
          else schedule(entry);
          if (!current(entry)) throw new VelaTaskLeaseError('workspace_task_canceled_before_start');
          return receipt;
        } catch (error) {
          if (current(entry)) entries.delete(input.runId);
          throw error;
        }
      })();
      return entry.starting;
    },
    finish,
    async recheckWorkspace(workspaceId: string): Promise<void> {
      await Promise.all([...entries.values()].filter(e => (e.receipt?.workspaceId ?? e.input.workspaceId) === workspaceId).map(entry => {
        entry.recheckRequested = true;
        return check(entry);
      }));
    },
    async revokeWorkspace(workspaceId: string): Promise<void> {
      await Promise.all([...entries.values()].filter(e => (e.receipt?.workspaceId ?? e.input.workspaceId) === workspaceId).map(e => lose(e, 'workspace_task_forbidden')));
    },
    reportTerminal(runId: string, attempt: number, report: () => void): void {
      try {
        report();
      } finally {
        // A failed terminal outbox write must not keep renewing a dead task.
        // Preserve the reporting error for the existing diagnostics/retry path.
        void finish(runId, attempt);
      }
    },
  };
}
