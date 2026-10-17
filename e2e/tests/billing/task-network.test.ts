// Opt-in cross-repository witness against an owned AMR named sandbox.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { test, expect } from 'vitest';
import { createSmokeSuite } from '@/vitest/suite';
import { requestJson } from '@/vitest/http';
import { startRun, cancelRun, readRun, waitForRunStatus, waitForRunTerminal } from '@/vitest/runs';

type Profile = { home: string; user: string; memberId: string };
type Fixture = {
  name: string; sourceSha: string; fixtureId: string; fixtureUrl: string;
  fixtureToken: string; workspace: string; velaBin: string; opencodeBin: string;
  urls: { api: string; link: string }; profiles: { owner: Profile; member: Profile };
};
type Evidence = {
  providerCalls: number; pendingProvider: number;
  runs: Array<{ open_design_run_id: string; app_user_id: string; admission_state: string; lease_attempt: string; lease_expires_at: string }>;
  usage: Array<{ request_id: string; provider_id: string | null; public_model_id: string | null; success: boolean; charge_credits: string | null }>;
};
const fixturePath = process.env.OD_TASK_NETWORK_FIXTURE;
test.skipIf(!fixturePath)('real task admission, stop, fenced retry and member removal', async () => {
  if (!fixturePath) throw new Error('fixture required');
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;
  expect(fixture.name).toBe('shared-task-leases');
  expect(new URL(fixture.fixtureUrl).hostname).toBe('127.0.0.1');
  const suite = await createSmokeSuite('workspace-task-network');
  const records: unknown[] = [];
  const control = <T>(action: string, body: object = {}) => requestJson<T>(fixture.fixtureUrl, `/control/${action}`, {
    body, headers: { authorization: `Bearer ${fixture.fixtureToken}` },
  });
  const evidence = () => control<Evidence>('evidence');
  const runtimeEnv = (p: Profile) => ({
    // This fixture exercises billing, not the independent artifact-delivery strategy.
    OD_NEXT_STRATEGY_ROLLOUT: 'off', AMR_HOME: p.home, VELA_PROFILE: 'local',
    VELA_API_URL: fixture.urls.api, VELA_LINK_URL: fixture.urls.link,
  });
  const cli = (p: Profile, args: string[]) => {
    try {
      return { ok: true, data: JSON.parse(execFileSync(fixture.velaBin, args, {
        env: { ...process.env, ...runtimeEnv(p) }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000,
      })) as Record<string, unknown> };
    } catch (error) {
      const stdout = (error as { stdout?: string }).stdout;
      if (!stdout) throw error;
      return { ok: false, data: JSON.parse(stdout) as Record<string, unknown> };
    }
  };
  const configure = async (webUrl: string) => {
    await requestJson(webUrl, '/api/app-config', { method: 'PUT', body: {
      agentCliEnv: { amr: { VELA_BIN: fixture.velaBin, VELA_OPENCODE_BIN: fixture.opencodeBin,
        OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1' } },
      agentId: 'amr', agentModels: { amr: { model: 'deepseek-v4.1-flash', reasoning: 'default' } },
      designSystemId: null, onboardingCompleted: true, skillId: null,
      telemetry: { artifactManifest: false, content: false, metrics: false },
    } });
  };
  const newRequest = async (webUrl: string, headers?: Record<string, string>) => {
    const project = await requestJson<{ conversationId: string; project: { id: string } }>(webUrl, '/api/projects', {
      body: { id: randomUUID(), name: 'Task network fixture', metadata: { kind: 'prototype' }, designSystemId: null, skillId: null },
      ...(headers ? { headers } : {}),
    });
    return { agentId: 'amr', assistantMessageId: randomUUID(), clientRequestId: randomUUID(),
      conversationId: project.conversationId, projectId: project.project.id,
      message: 'Reply with one short sentence. Do not use tools.', model: 'deepseek-v4.1-flash',
      reasoning: 'default', skillId: null, designSystemId: null };
  };
  const waitProvider = async (webUrl: string, runId: string, headers?: Record<string, string>) => {
    await expect.poll(async () => {
      const run = await readRun(webUrl, runId, headers ? { headers } : {});
      if (['failed', 'canceled', 'succeeded'].includes(run.status)) throw new Error(`Terminated before provider: ${JSON.stringify(run)}`);
      return { evidence: await evidence(), status: run.status };
    }, { timeout: 60000, interval: 250 }).toMatchObject({ evidence: { pendingProvider: 1 }, status: 'running' });
  };
  const released = async (runId: string, attempt: string) => {
    await expect.poll(evidence, { timeout: 15000 }).toMatchObject({ runs: expect.arrayContaining([
      expect.objectContaining({ open_design_run_id: runId, admission_state: 'released', lease_attempt: attempt }),
    ]) });
  };
  const startedAt = new Date().toISOString();
  try {
    const spoofed = await control<{status:number;providerCallsBefore:number;providerCallsAfter:number}>('spoof-auxiliary');
    expect(spoofed.status).toBe(403);
    expect(spoofed.providerCallsAfter).toBe(spoofed.providerCallsBefore);
    records.push({name:'Free member cannot spoof auxiliary role for a routable non-Flash model',status:'pass',evidence:spoofed});
    await suite.with.toolsDev(async ({ webUrl }) => {
      await configure(webUrl);
      const request = await newRequest(webUrl);
      await control('hold', { hold: true });
      const { runId } = await startRun(webUrl, request);
      try {
        await waitProvider(webUrl, runId);
        const running = await evidence();
        expect(running.runs.filter(r => r.admission_state === 'running' && Date.parse(r.lease_expires_at) > Date.now())).toHaveLength(1);
        records.push({ name: 'real OD root and model child occupy one slot', status: 'pass', runId, evidence: running });
        const denied = cli(fixture.profiles.member, ['run', 'lease', 'admit', '--run-id', randomUUID(), '--workspace-id', fixture.workspace, '--json']);
        expect(denied).toMatchObject({ ok: false, data: { error: 'workspace_task_concurrency_exceeded' } });
        records.push({ name: 'another authenticated member shares the root cap', status: 'pass', code: denied.data.error });
        await cancelRun(webUrl, runId);
        await waitForRunStatus(webUrl, runId, 'canceled');
        await released(runId, '0');
        records.push({ name: 'manual stop terminates actual child and releases slot', status: 'pass', runId });
      } finally {
        await cancelRun(webUrl, runId).catch(() => {});
        await control('release');
      }
      // Existing recharge retry reuses the physical run, but needs a new attempt.
      await control('balance', { credits: 0 });
      const retryRequest = { ...request, assistantMessageId: randomUUID(), clientRequestId: randomUUID() };
      const failed = await startRun(webUrl, retryRequest);
      const failure = await waitForRunTerminal(webUrl, failed.runId, { timeoutMs: 30000 });
      expect(failure).toMatchObject({ status: 'failed', failureAction: 'recharge' });
      await released(failed.runId, '0');
      const old = await control<{ lease_token: string }>('lease', { runId: failed.runId });
      await control('balance', { credits: 1000000 });
      await control('hold', { hold: true });
      const resumed = await requestJson<{ runId: string }>(webUrl, '/api/runs', { body: { ...retryRequest, resume: true } });
      expect(resumed.runId).toBe(failed.runId);
      try {
        await waitProvider(webUrl, resumed.runId);
        for (const action of ['heartbeat', 'release']) {
          const stale = cli(fixture.profiles.owner, ['run', 'lease', action, '--run-id', resumed.runId,
            '--workspace-id', fixture.workspace, '--attempt', '0', '--lease-token', old.lease_token, '--json']);
          expect(stale.ok).toBe(false);
          records.push({ name: `old attempt ${action} rejected while retry runs`, status: 'pass', code: stale.data.error });
        }
        const oldTerminal = cli(fixture.profiles.owner, ['run', 'terminal', '--run-id', resumed.runId,
          '--outcome', 'failed', '--terminal-at', new Date(failure.updatedAt).toISOString(), '--json']);
        expect(oldTerminal.ok).toBe(true);
        records.push({ name: 'old terminal report cannot free the new attempt', status: 'pass', runId: resumed.runId });
        const active = await evidence();
        expect(active.runs.find(r => r.open_design_run_id === resumed.runId)).toMatchObject({ admission_state: 'running', lease_attempt: '1' });
        await control('release');
        await waitForRunStatus(webUrl, resumed.runId, 'succeeded', { timeoutMs: 60000 });
        await released(resumed.runId, '1');
        records.push({ name: 'same-run recharge retry attempt 1 executes and releases', status: 'pass', runId: resumed.runId });
      } finally {
        await control('release');
        await cancelRun(webUrl, resumed.runId).catch(() => {});
      }
    }, { skipFatalLogCheck: true, env: runtimeEnv(fixture.profiles.owner) });

    // A separate authenticated member daemon. Removal uses the actual Owner API.
    await suite.with.toolsDev(async ({ webUrl }) => {
      await configure(webUrl);
      const headers = { 'x-od-workspace-id': fixture.workspace,
        'x-od-workspace-member-id': fixture.profiles.member.memberId, 'x-od-app-user-id': fixture.profiles.member.user };
      const request = await newRequest(webUrl, headers);
      await control('hold', { hold: true });
      const running = await startRun(webUrl, request, headers);
      try {
        await waitProvider(webUrl, running.runId, headers);
        const removed = await control<{ status: number }>('remove', { user: 'member' });
        expect(removed.status).toBe(200);
        // Real cross-process timer boundary: observe production heartbeat at
        // 30s. Narrow lifecycle tests cover timing with a virtual clock.
        const stopped = await waitForRunTerminal(webUrl, running.runId, { timeoutMs: 40000 });
        expect(stopped).toMatchObject({ status: 'canceled', errorCode: 'workspace_task_forbidden' });
        await released(running.runId, '0');
        records.push({ name: 'Owner removal API stops a running member child on heartbeat', status: 'pass', runId: running.runId,
          caseIds: ['MEM-004', 'MEM-009'], coverage: 'Actual Owner removal API, daemon process cancellation and lease cleanup; not full project/Key/UI case signoff.' });
      } finally {
        await control('release');
        await cancelRun(webUrl, running.runId).catch(() => {});
      }
    }, { skipFatalLogCheck: true, env: runtimeEnv(fixture.profiles.member) });
    const all = await evidence();
    expect(all.usage.filter(u => u.provider_id !== null && u.provider_id !== `${fixture.fixtureId}-provider`)).toEqual([]);
    records.push({ name: 'main and auxiliary requests use only the local provider fixture', status: 'pass', usage: all.usage });
    const settled = await control<{ usages: unknown[] }>('settle');
    expect(settled.usages.length).toBeGreaterThan(0);
    records.push({ name: 'actual successful model usage settles', status: 'pass', settled });
  } catch (error) {
    records.push({ status: 'fail', error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    await suite.report.json('result.json', { startedAt, finishedAt: new Date().toISOString(),
      amrSha: fixture.sourceSha, odSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: suite.root }).trim(),
      boundary: 'Real OD, Vela/OpenCode, API/Link/Postgres. Local provider and fixture Free cap=1; no visual or full RUN case signoff.', records });
  }
}, 240000);
