import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, expect } from '@/playwright/suite';
import { seedBrowserConfig, expectWorkspaceReady, dismissPrivacyDialog, sendPrompt } from '@/playwright/amr';
import { warmPlaywrightDaemonRuntime, warmPlaywrightWebRuntime } from '@/playwright/runtime-lifecycle';
import { T } from '@/timeouts';

type Profile = { home: string; memberId: string };
type Fixture = {
  name: string; sourceSha: string; recoverySha: string;
  fixtureUrl: string; fixtureToken: string; recoveryUrl: string; recoveryToken: string;
  workspace: string; velaBin: string; opencodeBin: string;
  urls: { api: string; link: string }; profiles: { owner: Profile; member: Profile };
};
const fixturePath = process.env.OD_TASK_RECOVERY_FIXTURE;

for (const change of ['remove', 'fill'] as const) {
  test(`payment waiting: ${change} rejects final task admission without a child and restores the draft`, async ({ page, toolsDev }, testInfo) => {
    test.skip(!fixturePath, 'Needs the exclusively owned recovery transport and sandbox');
    test.setTimeout(T.xlong * 3);
    const fixture = JSON.parse(readFileSync(fixturePath!, 'utf8')) as Fixture;
    expect(fixture.name).toBe('shared-task-leases');
    expect(new URL(fixture.recoveryUrl).hostname).toBe('127.0.0.1');
    const control = async (action: string, body: object = {}) => {
      const response = await fetch(`${fixture.recoveryUrl}/test-control/${action}`, {
        method: 'POST', headers: { authorization: `Bearer ${fixture.recoveryToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(T.long),
      });
      expect(response.ok, await response.clone().text()).toBeTruthy();
      return response.json() as Promise<{ waiting: number; payments: { attemptId: string; phase: string }[]; requests: { path: string; status: number; body: { error?: string } }[]; attempts: { id: string; status: string; charge_amount_usd: string }[]; funds: { source_id: string; amount: string; balance: string }[]; rows: { open_design_run_id: string; admission_state: string }[] }>;
    };
    const provider = async (action: string, body: object = {}) => {
      const response = await fetch(`${fixture.fixtureUrl}/control/${action}`, {
        method: 'POST', headers: { authorization: `Bearer ${fixture.fixtureToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(T.long),
      });
      expect(response.ok).toBeTruthy();
      return response.json() as Promise<{ providerCalls: number; pendingProvider: number }>;
    };
    await control('prepare');
    const profile = fixture.profiles.member;
    await toolsDev.stopWeb();
    await toolsDev.startWeb({ AMR_HOME: profile.home, VELA_PROFILE: 'local',
      VELA_API_URL: fixture.urls.api, VELA_LINK_URL: fixture.urls.link, OD_WORKSPACE_CONTEXT_SOURCE: 'vela', OD_NEXT_STRATEGY_ROLLOUT: 'off' });
    await warmPlaywrightDaemonRuntime(toolsDev.url.daemon('/api/health'));
    await warmPlaywrightWebRuntime(toolsDev.url.web('/'));
    await page.unroute('**/api/integrations/vela/status*');
    const config = { mode: 'daemon', agentId: 'amr', skillId: null, designSystemId: null, onboardingCompleted: true,
      privacyDecisionAt: 1, agentModels: { amr: { model: 'deepseek-v4.1-flash', reasoning: 'default' } },
      agentCliEnv: { amr: { VELA_BIN: fixture.velaBin, VELA_OPENCODE_BIN: fixture.opencodeBin, OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1' } },
      telemetry: { artifactManifest: false, content: false, metrics: false } };
    const configured = await page.request.put(toolsDev.url.web('/api/app-config'), { data: config });
    expect(configured.ok(), await configured.text()).toBeTruthy();
    await seedBrowserConfig(page, config);
    const headers = { 'x-od-workspace-id': fixture.workspace, 'x-od-workspace-member-id': profile.memberId };
    const created = await page.request.post(toolsDev.url.web('/api/projects'), { headers, data: { id: randomUUID(), name: `Payment ${change}`, metadata: { kind: 'prototype' }, skillId: null, designSystemId: null } });
    expect(created.ok(), await created.text()).toBeTruthy();
    const project = await created.json() as { project: { id: string } };
    let runId: string | undefined;
    let retryRunId: string | undefined;
    let status: number | undefined;
    await page.route('**/api/runs', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      // Upload placeholders display the filename before the attachment exists.
      expect(route.request().postDataJSON().attachments).toContain('payment-context.txt');
      // Change persisted money after actual GET preflight, not its HTTP response.
      await control('empty');
      const response = await route.fetch();
      status = response.status(); runId = (await response.json() as { runId?: string }).runId;
      await route.fulfill({ response });
    });
    try {
      await page.goto(toolsDev.url.web(`/projects/${project.project.id}`), { waitUntil: 'domcontentloaded' });
      await dismissPrivacyDialog(page); await expectWorkspaceReady(page);
      const prompt = `Keep my payment-waiting draft ${randomUUID()}`;
      await page.getByTestId('chat-file-input').setInputFiles({ name: 'payment-context.txt', mimeType: 'text/plain', buffer: Buffer.from('Keep this file when final authority changes during payment.') });
      await expect(page.getByTestId('staged-attachments').locator('.msg-att-doc[title="payment-context.txt"]')).not.toHaveClass(/is-up|is-fail/);
      const before = await provider('evidence');
      const paymentIdsBefore = new Set((await control('state')).payments.map(p => p.attemptId));
      const paymentBefore = paymentIdsBefore.size;
      await sendPrompt(page, prompt);
      await expect.poll(() => runId, { timeout: T.long }).toBeTruthy();
      expect(status).toBe(202);
      await expect.poll(async () => (await control('state')).waiting, { timeout: T.long }).toBeGreaterThan(0);
      const waiting = await (await page.request.get(toolsDev.url.web(`/api/runs/${runId}`), { headers })).json();
      expect(waiting.childPid).toBeNull();
      expect((await provider('evidence')).providerCalls).toBe(before.providerCalls);
      const changedAt = new Date().toISOString();
      await control(change, { case: randomUUID() });
      await control('release');
      await expect.poll(async () => (await (await page.request.get(toolsDev.url.web(`/api/runs/${runId}`), { headers })).json()).status, { timeout: T.long }).toMatch(/failed|canceled/);
      const rejected = await (await page.request.get(toolsDev.url.web(`/api/runs/${runId}`), { headers })).json();
      expect(rejected.childPid).toBeNull();
      expect(rejected.errorCode).toBe(change === 'fill' ? 'workspace_task_concurrency_exceeded' : 'workspace_task_forbidden');
      await expect(page.getByTestId('chat-composer-input')).toHaveText(prompt, { timeout: T.long });
      await expect(page.getByTestId('staged-attachments')).toContainText('payment-context.txt');
      if (change === 'remove') await expect(page.getByText('This run was stopped at your request.', { exact: true })).toHaveCount(0);
      expect((await provider('evidence')).providerCalls).toBe(before.providerCalls);
      const state = await control('state');
      const admission = state.requests.find(r => r.path === `/api/v1/open-design/runs/${runId}/lease/admit`);
      expect(admission).toMatchObject({ status: change === 'fill' ? 429 : 403, body: { error: change === 'fill' ? 'workspace_task_concurrency_exceeded' : 'workspace_task_forbidden' } });
      const paymentId = state.payments.find(p => !paymentIdsBefore.has(p.attemptId))!.attemptId;
      expect(state.attempts.filter(a => a.id === paymentId)).toHaveLength(1);
      expect(state.attempts.find(a => a.id === paymentId)?.status).toBe('succeeded');
      expect(Number(state.attempts.find(a => a.id === paymentId)?.charge_amount_usd)).toBe(10);
      expect(state.funds.filter(f => f.source_id === paymentId)).toEqual([{source_id:paymentId,amount:'100000',balance:'100000'}]);
      expect(new Set(state.payments.map(p => p.attemptId)).size - paymentBefore).toBe(1);
      expect(state.rows.filter(row => row.open_design_run_id === runId && row.admission_state === 'running')).toHaveLength(0);
      await testInfo.attach(`${change}-no-child`, { body: await page.screenshot(), contentType: 'image/png' });
      await testInfo.attach(`${change}-evidence`, { body: JSON.stringify({ amrRecoverySha: fixture.recoverySha, linkApiBaseline: fixture.sourceSha, runId, status, changedAt,
        admission, funding: state.funds.filter(f => f.source_id === paymentId), rejected: { status: rejected.status, errorCode: rejected.errorCode, childPid: rejected.childPid }, paymentDelta: 1, providerCalls: before.providerCalls, restoredAttachment: 'payment-context.txt' }), contentType: 'application/json' });
      if (change === 'fill') {
        await control('clear'); await page.unroute('**/api/runs'); await provider('hold', { hold: true });
        const queued = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/runs');
        await page.getByTestId('chat-composer-input').press('Enter');
        const accepted = await queued; expect(accepted.status()).toBe(202);
        retryRunId = (await accepted.json() as { runId: string }).runId;
        await expect.poll(async () => (await provider('evidence')).pendingProvider, { timeout: T.xlong }).toBe(1);
        const running = await (await page.request.get(toolsDev.url.web(`/api/runs/${retryRunId}`), { headers })).json();
        expect(running.childPid).toBeGreaterThan(0);
        await expect(page.getByTestId('chat-composer-input')).toHaveText('');
        await expect(page.getByTestId('staged-attachments')).toHaveCount(0);
        expect((await control('state')).payments.length).toBe(state.payments.length);
        await page.request.post(toolsDev.url.web(`/api/runs/${retryRunId}/cancel`), { headers, data: {} });
        await expect.poll(async () => (await (await page.request.get(toolsDev.url.web(`/api/runs/${retryRunId}`), { headers })).json()).status).toBe('canceled');
        const events = await page.request.get(toolsDev.url.web(`/api/runs/${retryRunId}/events`), { headers });
        expect((await events.text()).match(/^event: start$/gm)).toHaveLength(1);
        await testInfo.attach('retry-after-capacity-released', { body: JSON.stringify({ runId: retryRunId, childPid: running.childPid, starts: 1, extraPayments: 0 }), contentType: 'application/json' });
      }
    } finally {
      await control('release'); await control('clear');
      if (runId) await page.request.post(toolsDev.url.web(`/api/runs/${runId}/cancel`), { headers, data: {} }).catch(() => undefined);
      if (retryRunId) await page.request.post(toolsDev.url.web(`/api/runs/${retryRunId}/cancel`), { headers, data: {} }).catch(() => undefined);
      await provider('hold', { hold: false }); await control('prepare');
    }
  });
}
