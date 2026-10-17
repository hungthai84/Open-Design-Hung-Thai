import { runVelaCommand, velaCommandStdout } from './vela-command.js';

export interface VelaTaskLease {
  workspaceId: string;
  runId: string;
  attempt: number;
  leaseToken: string;
  leaseExpiresAt: string;
  heartbeatIntervalMs: number;
}
export interface VelaTaskLeaseInput {
  workspaceId: string;
  runId: string;
  attempt: number;
  leaseToken?: string;
  modelId?: string;
}
export class VelaTaskLeaseError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'VelaTaskLeaseError';
  }
}
export type RunTaskLeaseCommand = (args: string[], configuredEnv?: Record<string, string>) => Promise<string>;

/** All task control uses the signed-in Vela identity. Tokens stay inside the
 * daemon and subprocess environment; they are never UI state or diagnostics. */
export async function updateVelaTaskLease(
  action: 'admit' | 'heartbeat' | 'release',
  input: VelaTaskLeaseInput,
  options: { run?: RunTaskLeaseCommand; configuredEnv?: Record<string, string> | undefined } = {},
): Promise<VelaTaskLease | null> {
  const args = ['run', 'lease', action, '--run-id', input.runId, '--attempt', String(input.attempt), '--json'];
  if (input.workspaceId) args.push('--workspace-id', input.workspaceId);
  if (input.leaseToken) args.push('--lease-token', input.leaseToken);
  if (action === 'admit' && input.modelId) args.push('--model', input.modelId);
  const run = options.run ?? ((command, configuredEnv) => runVelaCommand(command, { ...(configuredEnv ? {configuredEnv} : {}), timeoutMs: 20_000 }));
  let raw: unknown;
  try {
    raw = JSON.parse(await run(args, options.configuredEnv));
  } catch (error) {
    let code = 'workspace_task_lease_unavailable';
    try {
      const failure = JSON.parse(velaCommandStdout(error)) as { error?: unknown };
      if (typeof failure.error === 'string' && /^\w+$/.test(failure.error)) code = failure.error;
    } catch { /* No trustworthy server error body: remain unavailable. */ }
    throw new VelaTaskLeaseError(code);
  }
  if (!raw || typeof raw !== 'object') throw new VelaTaskLeaseError('workspace_task_lease_invalid_response');
  const receipt = raw as VelaTaskLease & { released?: boolean };
  if ((!receipt.workspaceId || (input.workspaceId && receipt.workspaceId !== input.workspaceId)) || receipt.runId !== input.runId || receipt.attempt !== input.attempt)
    throw new VelaTaskLeaseError('workspace_task_lease_identity_mismatch');
  if (action === 'release') {
    if (receipt.released !== true) throw new VelaTaskLeaseError('workspace_task_lease_invalid_response');
    return null;
  }
  if (typeof receipt.leaseToken !== 'string' || !receipt.leaseToken ||
    !Number.isFinite(Date.parse(receipt.leaseExpiresAt)) || !Number.isSafeInteger(receipt.heartbeatIntervalMs) ||
    receipt.heartbeatIntervalMs < 1 || receipt.heartbeatIntervalMs > 30_000 ||
    (action === 'heartbeat' && receipt.leaseToken !== input.leaseToken))
    throw new VelaTaskLeaseError('workspace_task_lease_invalid_response');
  return receipt;
}
