import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { test, expect } from '@/playwright/suite';
import { seedBrowserConfig, expectWorkspaceReady, dismissPrivacyDialog, sendPrompt } from '@/playwright/amr';
import { warmPlaywrightDaemonRuntime, warmPlaywrightWebRuntime } from '@/playwright/runtime-lifecycle';

type Fixture = {
  name: string; sourceSha: string; fixtureUrl: string; fixtureToken: string;
  workspace: string; velaBin: string; opencodeBin: string;
  urls: { api: string; link: string }; profiles: { owner: { home: string; memberId: string } };
};
const fixturePath = process.env.OD_TASK_NETWORK_FIXTURE;

test('final shared task admission rejection restores the real composer draft', async ({ page, toolsDev }, testInfo) => {
  test.skip(!fixturePath, 'Needs the explicitly owned shared-task-leases sandbox');
  test.setTimeout(180_000);
  const fixture = JSON.parse(readFileSync(fixturePath!, 'utf8')) as Fixture;
  expect(fixture.name).toBe('shared-task-leases');
  expect(new URL(fixture.fixtureUrl).hostname).toBe('127.0.0.1');
  const control = async (action: string, body: object = {}) => {
    const response = await fetch(`${fixture.fixtureUrl}/control/${action}`, {
      method: 'POST', headers: { authorization: `Bearer ${fixture.fixtureToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(response.ok).toBeTruthy();
    return response.json() as Promise<Record<string, unknown>>;
  };
  await toolsDev.stopWeb();
  await toolsDev.startWeb({
    AMR_HOME: fixture.profiles.owner.home, VELA_PROFILE: 'local',
    VELA_API_URL: fixture.urls.api, VELA_LINK_URL: fixture.urls.link, OD_NEXT_STRATEGY_ROLLOUT: 'off',
  });
  await warmPlaywrightDaemonRuntime(toolsDev.url.daemon('/api/health'));
  await warmPlaywrightWebRuntime(toolsDev.url.web('/'));
  await page.unroute('**/api/integrations/vela/status*');
  const config = {
    mode: 'daemon', agentId: 'amr', skillId: null, designSystemId: null, onboardingCompleted: true,
    privacyDecisionAt: 1,
    agentModels: { amr: { model: 'deepseek-v4.1-flash', reasoning: 'default' } },
    agentCliEnv: { amr: { VELA_BIN: fixture.velaBin, VELA_OPENCODE_BIN: fixture.opencodeBin,
      OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1' } },
    telemetry: { artifactManifest: false, content: false, metrics: false },
  };
  const configured = await page.request.put(toolsDev.url.web('/api/app-config'), { data: config });
  expect(configured.ok(), await configured.text()).toBeTruthy();
  await seedBrowserConfig(page, config);
  const headers = { 'x-od-workspace-id': fixture.workspace, 'x-od-workspace-member-id': fixture.profiles.owner.memberId };
  const created = await page.request.post(toolsDev.url.web('/api/projects'), { headers, data: {
    id: randomUUID(), name: 'Final admission draft', metadata: { kind: 'prototype' }, skillId: null, designSystemId: null,
  } });
  expect(created.ok(), await created.text()).toBeTruthy();
  const project = await created.json() as { project: { id: string } };
  let runId: string | undefined;
  let queueStatus: number | undefined;
  let retryRunId: string | undefined;
  // This barrier only changes the owned fixture between the real preflight and
  // final admission. Both HTTP responses come from the actual daemon/API.
  await page.route('**/api/runs', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    await control('balance', { credits: 0 });
    const response = await route.fetch();
    queueStatus = response.status();
    runId = (await response.json() as { runId?: string }).runId;
    await route.fulfill({ response });
  });
  try {
    await control('balance', { credits: 1000000 });
    const before = await control('evidence');
    await page.goto(toolsDev.url.web(`/projects/${project.project.id}`), { waitUntil: 'domcontentloaded' });
    await dismissPrivacyDialog(page);
    await expectWorkspaceReady(page);
    await page.getByTestId('chat-file-input').setInputFiles({ name: 'draft-context.txt', mimeType: 'text/plain', buffer: Buffer.from('Retain this exact attachment when final admission rejects.') });
    await expect(page.getByTestId('staged-attachments')).toContainText('draft-context.txt');
    const prompt = `Preserve this rejected draft ${randomUUID()}`;
    await sendPrompt(page, prompt);
    await expect.poll(() => runId, { timeout: 30_000 }).toBeTruthy();
    expect(queueStatus).toBe(202);
    await expect(page.getByTestId('chat-composer-input')).toHaveText(prompt, { timeout: 30_000 });
    await expect(page.getByTestId('chat-send-pending')).toHaveCount(0);
    const response = await page.request.get(toolsDev.url.web(`/api/runs/${runId}`), { headers });
    const run = await response.json();
    expect(run).toMatchObject({ status: 'failed', errorCode: 'insufficient_balance', childPid: null });
    await expect(page.getByTestId('staged-attachments')).toContainText('draft-context.txt');
    const after = await control('evidence');
    expect(after.providerCalls).toBe(before.providerCalls);
    await testInfo.attach('final-admission-rejected', { body: await page.screenshot(), contentType: 'image/png' });
    await testInfo.attach('real-admission-evidence', { body: JSON.stringify({ amrSha: fixture.sourceSha,
      queueStatus, runId, run: { status: run.status, errorCode: run.errorCode, childPid: run.childPid }, providerCallsBefore: before.providerCalls, providerCallsAfter: after.providerCalls }), contentType: 'application/json' });
    await page.unroute('**/api/runs');
    await control('balance', { credits: 1000000 });
    await control('hold', { hold: true });
    const queued = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/runs');
    await page.getByTestId('chat-composer-input').press('Enter');
    const accepted = await queued;
    expect(accepted.status()).toBe(202);
    retryRunId = (await accepted.json() as { runId: string }).runId;
    expect(retryRunId).not.toBe(runId);
    await expect(page.getByTestId('chat-send-pending')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId('chat-composer-input')).toHaveText('');
    await expect(page.getByTestId('staged-attachments')).toHaveCount(0);
    await expect.poll(async () => (await control('evidence')).pendingProvider, { timeout: 60_000 }).toBe(1);
    const runningResponse = await page.request.get(toolsDev.url.web(`/api/runs/${retryRunId}`), { headers });
    const running = await runningResponse.json();
    expect(running).toMatchObject({ status: 'running' });
    expect(running.childPid).toBeGreaterThan(0);
    const canceled = await page.request.post(toolsDev.url.web(`/api/runs/${retryRunId}/cancel`), { headers, data: {} });
    expect(canceled.ok()).toBeTruthy();
    await expect.poll(async () => {
      const response = await page.request.get(toolsDev.url.web(`/api/runs/${retryRunId}`), { headers });
      return (await response.json()).status;
    }).toBe('canceled');
    const events = await page.request.get(toolsDev.url.web(`/api/runs/${retryRunId}/events`), { headers });
    expect((await events.text()).match(/^event: start$/gm)).toHaveLength(1);
    await testInfo.attach('successful-retry-evidence', { body: JSON.stringify({ runId: retryRunId,
      childPid: running.childPid, status: 'canceled', starts: 1, retainedAttachment: 'draft-context.txt' }), contentType: 'application/json' });
  } finally {
    if (retryRunId) await page.request.post(toolsDev.url.web(`/api/runs/${retryRunId}/cancel`), { headers, data: {} }).catch(() => undefined);
    await control('hold', { hold: false });
    await control('balance', { credits: 1000000 });
  }
});
