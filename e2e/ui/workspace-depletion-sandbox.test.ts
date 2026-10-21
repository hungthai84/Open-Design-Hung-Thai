import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { clusterTest as test, expect } from '@/playwright/suite';
import { startScopedFundingClient } from '@/playwright/workspace-funding-client';
import { fundingHeaders } from '@/playwright/workspace-funding-fixture';
import { readDepletionFixture } from '@/playwright/workspace-depletion-fixture';
import { T } from '@/timeouts';
type Frame = { receivedAtMs: number; eventName: string; data: Record<string, unknown> };
test('[P0] RUN-005 real charged Agent rounds stop at exhausted balance and receive causal notification', async ({
  page,
}, info) => {
  test.setTimeout(T.xlong * 8);
  const fixture = await readDepletionFixture();
  const given = fixture.depletion;
  if (!given) throw Error('Explicit RUN005 Given required');
  expect((await stat(given.proofPath)).mode & 0o077).toBe(0);
  const bytes = await readFile(given.proofPath);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(given.proofSha256);
  const proof = JSON.parse(bytes.toString());
  expect(proof.amrSha).toBe(fixture.upstream.amrSha);
  expect(proof.initialBalanceCredits).toBe('20000');
  expect(proof.space.workspaceId).toBe(given.space.workspaceId);
  expect(proof.deviceAuth.runtimeKeySource).toBe('cli_device');
  expect(createHash('sha256').update(given.deviceRuntimeKey).digest('hex')).toBe(
    proof.deviceAuth.runtimeKeySha256,
  );
  const frames: Frame[] = [];
  const sourceUrls = new Map<string, string>();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  cdp.on('Network.requestWillBeSent', (event) => {
    sourceUrls.set(event.requestId, event.request.url);
  });
  cdp.on('Network.eventSourceMessageReceived', (event) => {
    if (!sourceUrls.get(event.requestId)?.includes('/api/workspace/events')) return;
    try {
      const data = JSON.parse(event.data) as Record<string, unknown>;
      frames.push({ receivedAtMs: Date.now(), eventName: event.eventName, data });
    } catch {
      /* only complete real JSON frames qualify */
    }
  });
  const client = await startScopedFundingClient(page, info, {
    fixture,
    initialSpace: given.space,
    checkedSpaces: { depletion: given.space },
    runtimeKey: given.deviceRuntimeKey,
    requireNamePrefix: true,
    checkPreflight(_alias, _space, preflight) {
      expect(Number(preflight.balanceUsd)).toBe(Number(given.initialBalanceUsd));
      expect(preflight.codingPlan.eligible).toBe(false);
    },
  });
  const space = given.space;
  let runId: string | undefined;
  let terminal = false;
  const runReads: unknown[] = [];
  let bodyCompleted = false;
  const observations: Record<string, unknown> = { case: 'server:RUN-005', wholeQaPassed: false };
  const state = async () =>
    JSON.parse(await readFile(given.provider.statePath, 'utf8')) as {
      pid: number;
      sourceSha256: string;
      held: string[];
      events: Array<{ type: string; kind: string; id: string; requestIndex: number; at: string }>;
    };
  const backend = async () =>
    JSON.parse(await readFile(given.backendObservationPath, 'utf8')) as {
      runId: string;
      workspaceId: string;
      ready: boolean;
      depletionEvent: null | {
        payload: { at: string; revision: string; workspaceId: string; workspaceMemberId: string };
        facts: { fund_credits: string; debt_credits: string; revision: string };
        usage: unknown[];
        ledger: unknown[];
      };
      clockSamples: Array<{ offsetMinimumMs: number; offsetMaximumMs: number }>;
    };
  try {
    const before = await state();
    expect(before.pid).toBe(given.provider.pid);
    expect(before.sourceSha256).toBe(given.provider.sourceSha256);
    expect(before.events).toEqual([]);
    expect((await backend()).ready).toBe(true);
    await page.goto(client.runtime.url.web('/'), {
      waitUntil: 'domcontentloaded',
      timeout: T.xlong,
    });
    await client.select(space);
    await expect(page.getByTestId('home-hero-input')).toBeVisible({ timeout: T.xlong });
    const tag = `od-ws005-${given.attemptId}-b`;
    await page
      .getByTestId('home-hero-input')
      .fill(`QA:${JSON.stringify({ id: tag, scenario: 'WS-005', task: 'b' })}`);
    const created = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/runs' && r.request().method() === 'POST',
      { timeout: T.long },
    );
    await page.getByTestId('home-hero-submit').click({ timeout: T.medium });
    const response = await created;
    expect(response.status()).toBe(202);
    runId = (await response.json()).runId;
    expect(typeof runId).toBe('string');
    observations.runId = runId;
    await expect
      .poll(
        async () => {
          const r = await fetch(client.runtime.url.web(`/api/runs/${runId}`), {
            headers: fundingHeaders(space),
            signal: AbortSignal.timeout(T.short),
          });
          expect(r.ok).toBe(true);
          const value = (await r.json()) as { status: string };
          runReads.push(value);
          terminal = ['succeeded', 'failed', 'canceled'].includes(value.status);
          return terminal;
        },
        { timeout: T.xlong * 2, intervals: [100, 250, 500] },
      )
      .toBe(true);
    observations.actualTerminal = runReads.at(-1);
    observations.provider = await state();
    observations.runReads = runReads;
    const completed = (await state()).events.filter((e) => e.id === tag && e.type === 'completed');
    expect(completed.filter((e) => e.kind === 'main').length).toBeGreaterThanOrEqual(2);
    // The original task is terminal before any user cancellation; subsequent calls
    // must be rejected by real Link, not by exhausting the controlled provider plan.
    expect(
      (await state()).events.filter(
        (e) => e.id === tag && ['rejected', 'failed', 'disconnected'].includes(e.type),
      ),
    ).toEqual([]);
    await expect.soft(page.getByTestId('amr-balance-dialog')).toBeVisible({ timeout: T.long });
    observations.dialogVisibleAtMs = Date.now();
    await info.attach('RUN005-real-exhausted-dialog', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    await expect
      .poll(async () => Boolean((await backend()).depletionEvent), { timeout: T.long })
      .toBe(true);
    const actualBackend = await backend();
    expect(actualBackend.workspaceId).toBe(space.workspaceId);
    expect(actualBackend.runId).toBe(fixture.isolation.runId);
    const event = actualBackend.depletionEvent!;
    expect(BigInt(event.facts.fund_credits) - BigInt(event.facts.debt_credits)).toBeLessThanOrEqual(
      0n,
    );
    expect(event.payload.workspaceMemberId).toBe(space.actorMemberId);
    const beforeNew = await state();
    const denied = await fetch(new URL('/v1/chat/completions', fixture.upstream.linkUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${space.runtimeKey}`,
        'content-type': 'application/json',
        'x-vela-workspace-id': space.workspaceId,
      },
      body: JSON.stringify({
        model: fixture.runtime.modelId,
        messages: [{ role: 'user', content: `RUN005 direct insufficient API ${given.attemptId}` }],
        stream: false,
      }),
      signal: AbortSignal.timeout(T.long),
    });
    const deniedBody = await denied.json();
    observations.newApi = { status: denied.status, body: deniedBody };
    expect(denied.status).toBe(402);
    expect(JSON.stringify(deniedBody)).toContain('insufficient_balance');
    expect((await state()).events).toEqual(beforeNew.events);
    const received = frames.find(
      (f) =>
        f.eventName === 'wallet-balance-changed' &&
        f.data.workspaceId === space.workspaceId &&
        f.data.workspaceMemberId === space.actorMemberId &&
        f.data.revision === event.payload.revision,
    );
    observations.frames = frames;
    observations.backend = actualBackend;
    expect(
      received,
      'A real client-received frame must match the exact depleted wallet revision; client time alone is not evidence',
    ).toBeTruthy();
    const offsetMax = Math.max(
      ...actualBackend.clockSamples.map((s) =>
        Math.max(Math.abs(s.offsetMinimumMs), Math.abs(s.offsetMaximumMs)),
      ),
    );
    const latency = received!.receivedAtMs - Date.parse(event.payload.at);
    observations.notificationLatency = {
      backendEventAt: event.payload.at,
      clientReceivedAtMs: received!.receivedAtMs,
      measuredMs: latency,
      clockUncertaintyMs: offsetMax,
      upperBoundMs: latency + offsetMax,
    };
    expect(latency).toBeGreaterThanOrEqual(-offsetMax);
    expect(latency + offsetMax).toBeLessThanOrEqual(1000);
    bodyCompleted = true;
  } finally {
    try {
      observations.runId = runId;
      observations.frames = frames;
      observations.runReads = runReads;
      observations.provider = await state();
      observations.backend = await backend();
      if (runId && !terminal) {
        const response = await fetch(client.runtime.url.web(`/api/runs/${runId}/cancel`), {
          method: 'POST',
          headers: fundingHeaders(space),
        });
        observations.cleanupCancel = response.status;
      }
    } finally {
      await client.attach('RUN005-original-two-step-observations', observations);
      await cdp.detach().catch(() => {});
      await client.close({ preserveScratch: !bodyCompleted || info.errors.length > 0 });
    }
  }
});
