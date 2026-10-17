import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { test, expect } from 'vitest';
import { createSmokeSuite } from '@/vitest/suite';
import { requestJson } from '@/vitest/http';
import { startRun, readRun, cancelRun, waitForRunTerminal } from '@/vitest/runs';

type Fixture = {
  name: string; sourceSha: string; fixtureUrl: string; fixtureToken: string;
  workspace: string; velaBin: string; opencodeBin: string;
  urls: { api: string; link: string };
  profiles: { member: { home: string; memberId: string; user: string } };
};
type Evidence = {
  pendingProvider: number;
  runs: Array<{ open_design_run_id: string; admission_state: string; last_heartbeat_at: string }>;
};
const path = process.env.OD_TASK_NETWORK_FIXTURE;
test.skipIf(!path)('actual Owner deletion stops the member child before its scheduled heartbeat', async () => {
  const fixture = JSON.parse(readFileSync(path!, 'utf8')) as Fixture;
  expect(fixture.name).toBe('shared-task-leases');
  expect(new URL(fixture.fixtureUrl).hostname).toBe('127.0.0.1');
  const suite = await createSmokeSuite('task-roster-event-network');
  const control = <T>(action: string, body: object = {}) => requestJson<T>(fixture.fixtureUrl, `/control/${action}`, {
    body, headers: { authorization: `Bearer ${fixture.fixtureToken}` },
  });
  const evidence = () => control<Evidence>('evidence');
  const records: unknown[] = [];
  const startedAt = new Date().toISOString();
  try {
    await control('restore', { user: 'member' }); // fixture setup, not a product reinvitation claim
    await control('balance', { credits: 1000000 });
    await suite.with.toolsDev(async ({ webUrl }) => {
      await requestJson(webUrl, '/api/app-config', { method: 'PUT', body: {
        agentId: 'amr', agentModels: { amr: { model: 'deepseek-v4.1-flash', reasoning: 'default' } },
        agentCliEnv: { amr: { VELA_BIN: fixture.velaBin, VELA_OPENCODE_BIN: fixture.opencodeBin,
          OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1' } },
        designSystemId: null, skillId: null, onboardingCompleted: true,
        telemetry: { artifactManifest: false, content: false, metrics: false },
      } });
      const headers = { 'x-od-workspace-id': fixture.workspace,
        'x-od-workspace-member-id': fixture.profiles.member.memberId, 'x-od-app-user-id': fixture.profiles.member.user };
      const project = await requestJson<{ project: { id: string }; conversationId: string }>(webUrl, '/api/projects', {
        headers, body: { id: randomUUID(), name: 'Roster event task', metadata: { kind: 'prototype' }, designSystemId: null, skillId: null },
      });
      await control('hold', { hold: true });
      const { runId } = await startRun(webUrl, { agentId: 'amr', projectId: project.project.id,
        conversationId: project.conversationId, assistantMessageId: randomUUID(), clientRequestId: randomUUID(),
        message: 'Reply briefly. Do not use tools.', model: 'deepseek-v4.1-flash', reasoning: 'default', skillId: null, designSystemId: null }, headers);
      try {
        await expect.poll(async () => {
          const run = await readRun(webUrl, runId, { headers });
          if (['canceled', 'failed', 'succeeded'].includes(run.status)) throw new Error(`Ended before provider: ${run.status}/${run.errorCode}`);
          return (await evidence()).pendingProvider;
        }, { timeout: 60_000 }).toBe(1);
        const before = (await evidence()).runs.find(row => row.open_design_run_id === runId)!;
        expect(before.admission_state).toBe('running');
        const heartbeatAt = Date.parse(before.last_heartbeat_at);
        // Prove this witness cannot be satisfied by the normal 30s heartbeat.
        const remainingUntilHeartbeat = heartbeatAt + 30_000 - Date.now();
        expect(remainingUntilHeartbeat).toBeGreaterThan(10_000);
        const deleteStartedAt = Date.now();
        const removed = await control<{ status: number }>('remove', { user: 'member' });
        const deleteReturnedAt = Date.now();
        expect(removed.status).toBe(200);
        const stopped = await waitForRunTerminal(webUrl, runId, { timeoutMs: Math.min(10_000, remainingUntilHeartbeat - 1000) });
        const stoppedAt = Date.now();
        expect(stopped).toMatchObject({ status: 'canceled', errorCode: 'workspace_task_forbidden', childExited: true });
        expect(stoppedAt).toBeLessThan(heartbeatAt + 30_000);
        await expect.poll(async () => (await evidence()).runs.find(row => row.open_design_run_id === runId)?.admission_state).toBe('released');
        records.push({ status: 'pass', runId, caseIds: ['MEM-004', 'RUN-008'],
          coverage: 'Actual Owner DELETE, daemon workspace event subscription with no members UI open, child cancellation before scheduled heartbeat, persisted lease released; not full member removal/project/API Key case signoff.',
          heartbeatAt, deleteStartedAt, deleteReturnedAt, stoppedAt, eventStopElapsedMs: stoppedAt - deleteStartedAt });
      } finally {
        await cancelRun(webUrl, runId, { headers }).catch(() => undefined);
        await control('release');
      }
    }, { skipFatalLogCheck: true, env: {
      AMR_HOME: fixture.profiles.member.home, VELA_PROFILE: 'local', VELA_API_URL: fixture.urls.api,
      VELA_LINK_URL: fixture.urls.link, OD_NEXT_STRATEGY_ROLLOUT: 'off',
      OD_WORKSPACE_CONTEXT_SOURCE: 'vela',
    } });
  } catch (error) {
    records.push({ status: 'fail', error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    await suite.report.json('result.json', { startedAt, completedAt: new Date().toISOString(),
      amrSha: fixture.sourceSha, odSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: suite.root }).trim(),
      boundary: 'Real daemon/Vela/OpenCode/API/Link/PG/Redis. Local provider fixture and test Free cap=1. No timing SLA invented: comparison is specifically against the known scheduled heartbeat.', records });
  }
}, 150_000);
