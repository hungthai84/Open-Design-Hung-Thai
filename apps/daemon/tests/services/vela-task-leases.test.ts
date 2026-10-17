import { describe, expect, it, vi } from 'vitest';
import { updateVelaTaskLease } from '../../src/integrations/vela-task-leases.js';

const input = { runId: 'root', workspaceId: '', attempt: 0 };
const receipt = { ...input, workspaceId: 'default-from-server', leaseToken: 'private-token', leaseExpiresAt: '2026-10-18T00:00:00Z', heartbeatIntervalMs: 30_000 };

describe('Vela task lease command adapter', () => {
  it('uses the configured Vela identity and server default when a project is unbound', async () => {
    const run = vi.fn(async (_args: string[], _env?: Record<string,string>) => JSON.stringify(receipt));
    const configuredEnv = { VELA_BIN: '/test/vela' };
    expect(await updateVelaTaskLease('admit', input, {run, configuredEnv})).toEqual(receipt);
    expect(run).toHaveBeenCalledWith(['run','lease','admit','--run-id','root','--attempt','0','--json'],configuredEnv);
  });
  it('passes the selected model only on admission, not mutable heartbeat identity', async () => {
    const run = vi.fn(async (_args: string[]) => JSON.stringify(receipt));
    await updateVelaTaskLease('admit', {...input,modelId:'deepseek-v4.1-flash'}, {run});
    expect(run.mock.calls[0]?.[0]).toContain('--model');
    expect(run.mock.calls[0]?.[0]?.at(-1)).toBe('deepseek-v4.1-flash');
    await updateVelaTaskLease('heartbeat', {...input, modelId:'other', leaseToken:receipt.leaseToken}, {run});
    expect(run.mock.calls[1]?.[0]).not.toContain('--model');
  });
  it('pins heartbeat to the original space, attempt and token', async () => {
    const run = vi.fn(async (_args: string[]) => JSON.stringify(receipt));
    await updateVelaTaskLease('heartbeat', {...input, workspaceId:receipt.workspaceId,leaseToken:receipt.leaseToken},{run});
    expect(run.mock.calls[0]?.[0]).toEqual(['run','lease','heartbeat','--run-id','root','--attempt','0','--json','--workspace-id',receipt.workspaceId,'--lease-token',receipt.leaseToken]);
    for (const changed of [{workspaceId:'different'}, {runId:'different'}, {attempt:1}]) {
      await expect(updateVelaTaskLease('heartbeat',{...input,workspaceId:receipt.workspaceId,leaseToken:receipt.leaseToken}, {run:async()=>JSON.stringify({...receipt,...changed})})).rejects.toThrow('workspace_task_lease_identity_mismatch');
    }
    await expect(updateVelaTaskLease('heartbeat',{...input,workspaceId:receipt.workspaceId,leaseToken:receipt.leaseToken},{run:async()=>JSON.stringify({...receipt,leaseToken:'replacement'})})).rejects.toThrow('workspace_task_lease_invalid_response');
  });
  it('only preserves the explicit server OFF code; transport or unsupported CLI are not OFF', async () => {
    await expect(updateVelaTaskLease('admit',input,{run:async()=>{throw Object.assign(new Error('exit1'),{stdout:JSON.stringify({error:'workspace_task_leases_not_enabled'})});}})).rejects.toThrow('workspace_task_leases_not_enabled');
    for (const failure of [new Error('unknown command'), Object.assign(new Error('network'),{stdout:'not-json'})]) {
      await expect(updateVelaTaskLease('admit',input,{run:async()=>{throw failure;}})).rejects.toThrow('workspace_task_lease_unavailable');
    }
  });
  it('does not accept a release for another attempt or a non-release response', async () => {
    const release = {...input,workspaceId:receipt.workspaceId,leaseToken:receipt.leaseToken};
    expect(await updateVelaTaskLease('release',release,{run:async()=>JSON.stringify({...receipt,released:true})})).toBeNull();
    await expect(updateVelaTaskLease('release',release,{run:async()=>JSON.stringify({...receipt,attempt:1,released:true})})).rejects.toThrow('workspace_task_lease_identity_mismatch');
    await expect(updateVelaTaskLease('release',release,{run:async()=>JSON.stringify(receipt)})).rejects.toThrow('workspace_task_lease_invalid_response');
  });
});
