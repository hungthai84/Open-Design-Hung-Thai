import { execFile } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { clusterTest as test, expect } from '@/playwright/suite';
import { startScopedFundingClient } from '@/playwright/workspace-funding-client';
import { readRecoveryFixture } from '@/playwright/workspace-recovery-fixture';
import { verifyFundingLease, withFundingLease } from '@/playwright/workspace-funding-lease';
import { T } from '@/timeouts';
import { startWorkspaceTransport } from '@/playwright/workspace-transport';

type Json = Record<string, unknown>;
type Run = {
  id: string;
  status: string;
  exitCode: number;
  errorCode: string;
  cancelRequested: boolean;
};
type Billing = {
  workspaceBalance?: { workspaceId: string; workspaceMemberId: string; balanceUsd: string };
};
for (const alias of ['a', 'b'] as const) {
  test(`[P0] RUN-010 group ${alias}: recharge and real reconnect require explicit resubmission`, async ({
    page,
  }, info) => {
    test.setTimeout(T.xlong * 8);
    const f = await readRecoveryFixture();
    const given = f.recovery;
    const wallet = given.wallets[alias];
    const output = join(process.env.OD_FUNDING_EVIDENCE_DIR!, `group-${alias}`);
    await mkdir(output, { mode: 0o700 });
    const save = async (name: string, value: unknown) =>
      writeFile(join(output, name), JSON.stringify(value, null, 2), { mode: 0o600 });
    const requests: Array<{ at: number; method: string; path: string; body?: unknown }> = [];
    const frames: Array<{ at: number; event: string; data: Json }> = [];
    const bills: Array<{ at: number; url: string; status: number; body: Billing }> = [];
    const networkFailures: Array<{ at: number; url: string; error: unknown }> = [];
    const cdp = await page.context().newCDPSession(page);
    const urls = new Map<string, string>();
    await cdp.send('Network.enable');
    cdp.on('Network.requestWillBeSent', (e) => urls.set(e.requestId, e.request.url));
    cdp.on('Network.eventSourceMessageReceived', (e) => {
      if (urls.get(e.requestId)?.includes('/api/workspace/events'))
        try {
          frames.push({ at: Date.now(), event: e.eventName, data: JSON.parse(e.data) as Json });
        } catch {
          /* only real JSON frames qualify */
        }
    });
    page.on('request', (r) => {
      const path = new URL(r.url()).pathname;
      if (path.startsWith('/api/'))
        requests.push({
          at: Date.now(),
          method: r.method(),
          path,
          ...(r.method() === 'POST' && path.startsWith('/api/runs')
            ? { body: r.postDataJSON() }
            : {}),
        });
    });
    page.on('requestfailed', (r) =>
      networkFailures.push({ at: Date.now(), url: r.url(), error: r.failure() }),
    );
    page.on('response', async (r) => {
      if (new URL(r.url()).pathname === '/api/workspace/billing')
        try {
          bills.push({
            at: Date.now(),
            url: r.url(),
            status: r.status(),
            body: (await r.json()) as Billing,
          });
        } catch {
          /* disconnected bodies are recorded by requestfailed */
        }
    });
    const provider = async () =>
      JSON.parse(await readFile(given.provider.statePath, 'utf8')) as {
        pid: number;
        sourceSha256: string;
        events: Array<{ type: string; task: string; kind: string; requestIndex: number }>;
        held: string[];
      };
    const originalPrompt = `QA:${JSON.stringify({ id: `od-ws005-${given.attemptId}-${alias}`, scenario: 'WS-005', task: alias })} Reply ok only.`;
    let client: Awaited<ReturnType<typeof startScopedFundingClient>> | undefined;
    let originalRunId: string | undefined;
    let transport: Awaited<ReturnType<typeof startWorkspaceTransport>> | undefined;
    const results: Json = {
      case: 'server:RUN-010',
      alias,
      formalHttpRechargePassed: false,
      wholeQaPassed: false,
    };
    const mutation = (r: { method: string; path: string }) =>
      r.method === 'POST' &&
      (r.path === '/api/projects' ||
        r.path === '/api/runs' ||
        /^\/api\/runs\/[^/]+\/resume$/.test(r.path));
    try {
      const initialProvider = await provider();
      expect(initialProvider.pid).toBe(given.provider.pid);
      expect(initialProvider.sourceSha256).toBe(given.provider.sourceSha256);
      expect(initialProvider.events.filter((e) => e.task === alias)).toEqual([]);
      client = await startScopedFundingClient(page, info, {
        fixture: { ...f, actor: wallet.actor },
        initialSpace: wallet.space,
        checkedSpaces: { original: wallet.space },
        runtimeKey: wallet.deviceRuntimeKey,
        identitySuffix: alias,
        attachmentPrefix: `RUN010-${alias}-`,
        requireNamePrefix: true,
        checkPreflight(_name, space, p) {
          expect(p.workspaceId).toBe(space.workspaceId);
          expect(Number(p.balanceUsd)).toBe(Number(wallet.initialBalanceUsd));
          expect(p.codingPlan.windows).toHaveLength(2);
          expect(p.codingPlan.windows.every((w) => Number(w.remainingCredits) === 0)).toBe(true);
        },
      });
      const runtime = client.runtime;
      const run = async (id: string): Promise<Run> => {
        const r = await fetch(runtime.url.web(`/api/runs/${id}`));
        expect(r.ok).toBe(true);
        return (await r.json()) as Run;
      };
      transport = await startWorkspaceTransport({ target: runtime.url.web('/'), namespace: runtime.namespace, workspaceId: wallet.space.workspaceId, memberId: wallet.space.actorMemberId! });
      await page.goto(transport.origin, { waitUntil: 'domcontentloaded', timeout: T.xlong });
      await client.select(wallet.space);
      await expect(page.getByTestId('home-hero-input')).toBeVisible({ timeout: T.xlong });
      await page.getByTestId('home-hero-input').fill(originalPrompt);
      const index = requests.length;
      if (alias === 'a') {
        await page.getByTestId('home-hero-submit').click({ timeout: T.medium });
        await expect(page.getByTestId('amr-balance-dialog')).toBeVisible({ timeout: T.long });
        expect(requests.slice(index).filter(mutation)).toEqual([]);
        expect((await provider()).events.filter((e) => e.task === alias)).toEqual([]);
        await expect(page.getByTestId('home-hero-input')).toHaveText(originalPrompt);
        await page.screenshot({ path: join(output, 'before-send-blocked.png') });
        await page
          .getByTestId('amr-balance-dialog')
          .getByRole('button', { name: 'Close', exact: true })
          .click();
      } else {
        const created = page.waitForResponse(
          (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/runs',
          { timeout: T.long },
        );
        await page.getByTestId('home-hero-submit').click({ timeout: T.medium });
        const response = await created;
        expect(response.status()).toBe(202);
        originalRunId = ((await response.json()) as { runId: string }).runId;
        results.originalRunId = originalRunId;
        // Go offline only after an actual same-scope negative wallet response.
        // The real Agent can reach its existing stop boundary while this browser is disconnected.
        await expect
          .poll(
            () =>
              bills.some(
                (b) =>
                  b.status === 200 &&
                  b.body.workspaceBalance?.workspaceId === wallet.space.workspaceId &&
                  b.body.workspaceBalance.workspaceMemberId === wallet.space.actorMemberId &&
                  Number(b.body.workspaceBalance.balanceUsd) <= 0,
              ),
            { timeout: T.xlong * 2 },
          )
          .toBe(true);
        results.negativeWallet = bills.find(
          (b) =>
            b.body.workspaceBalance?.workspaceId === wallet.space.workspaceId &&
            Number(b.body.workspaceBalance.balanceUsd) <= 0,
        );
      }
      const beforeOffline = requests.length;
      const beforeEvents = (await provider()).events;
      const offlineAt = Date.now();
      expect(transport.activeScoped).toBeGreaterThan(0);
      await page.context().setOffline(true);
      transport.disconnect();
      const offlineProbe = await page.evaluate(async () => {
        try {
          await fetch('/api/workspaces');
          return { rejected: false };
        } catch (e) {
          return { rejected: true, error: String(e) };
        }
      });
      expect(offlineProbe.rejected).toBe(true);
      await expect
        .poll(
          () =>
            networkFailures.some(
              (e) => e.at >= offlineAt && e.url.includes('/api/workspace/events'),
            ),
          { timeout: T.long },
        )
        .toBe(true);
      await expect.poll(() => transport!.events.some(e => e.type === 'upstream-response-close'), { timeout: T.long }).toBe(true);
      results.offline = { at: offlineAt, offlineProbe, failures: networkFailures, transportEvents: transport.events };
      if (originalRunId) {
        await expect
          .poll(async () => (await run(originalRunId!)).status, {
            timeout: T.xlong,
            intervals: [100, 250],
          })
          .toBe('failed');
        const terminal = await run(originalRunId);
        expect(terminal.errorCode).toBe('AMR_INSUFFICIENT_BALANCE');
        expect(terminal.cancelRequested).toBe(false);
        results.originalTerminal = terminal;
      }
      await save('before-recharge.private.json', {
        requests,
        frames,
        bills,
        provider: await provider(),
        results,
      });
      const action = given.recharge;
      const directory = join(output, 'service-recharge');
      const verified = await verifyFundingLease(f, T.xlong * 3);
      const actionResult = await withFundingLease(
        async () => {
          await verifyFundingLease(f, T.xlong * 2);
        },
        () =>
          promisify(execFile)(
            'python3',
            [
              'e2e/helper/e2e_ownership.py',
              'run',
              '--label',
              `run010-${alias}-signed-recharge`,
              '--',
              'corepack',
              'pnpm',
              '--filter',
              '@vela/api',
              'exec',
              'tsx',
              action.helperPath,
              given.serverDirectory,
              alias,
              directory,
              action.helperSha256,
            ],
            {
              cwd: f.owner.sourceRoot,
              env: verified.env,
              timeout: T.xlong,
              maxBuffer: 1024 * 1024,
            },
          ),
      );
      await save('service-recharge-command.private.json', {
        stdout: actionResult.stdout,
        stderr: actionResult.stderr,
      });
      const charge = JSON.parse(await readFile(join(directory, 'result.safe.json'), 'utf8'));
      expect(charge.completed).toBe(true);
      results.serviceRecharge = charge;
      expect(requests.slice(beforeOffline).filter(mutation)).toEqual([]);
      const readyBefore = frames.filter((frame) => frame.event === 'ready').length;
      const reconnectAt = Date.now();
      transport.restore();
      await page.context().setOffline(false);
      await expect
        .poll(() => frames.filter((frame) => frame.event === 'ready').length, { timeout: T.xlong })
        .toBeGreaterThan(readyBefore);
      await expect
        .poll(
          () =>
            bills.some(
              (b) =>
                b.at >= reconnectAt &&
                b.status === 200 &&
                b.body.workspaceBalance?.workspaceId === wallet.space.workspaceId &&
                Number(b.body.workspaceBalance.balanceUsd) > 0,
            ),
          { timeout: T.xlong },
        )
        .toBe(true);
      // The absence window follows a real completed reconnect, not a guessed sleep.
      const auto = await page
        .waitForEvent('request', {
          predicate: (r) => mutation({ method: r.method(), path: new URL(r.url()).pathname }),
          timeout: 2000,
        })
        .catch(() => null);
      expect(auto).toBeNull();
      expect(requests.slice(beforeOffline).filter(mutation)).toEqual([]);
      expect((await provider()).events).toEqual(beforeEvents);
      if (alias === 'a')
        await expect(page.getByTestId('home-hero-input')).toHaveText(originalPrompt);
      else expect((await run(originalRunId!)).status).toBe('failed');
      await save('step1-completed.private.json', {
        reconnectAt,
        frames,
        bills,
        requests,
        provider: await provider(),
        originalRunId,
      });
      const dialog = page.getByTestId('amr-balance-dialog');
      if (await dialog.isVisible())
        await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      const input = page.getByTestId(alias === 'a' ? 'home-hero-input' : 'chat-composer-input');
      await expect(input).toBeVisible({ timeout: T.long });
      await input.fill(originalPrompt);
      const recheckIndex = requests.length;
      const manual = page.waitForResponse(
        (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/runs',
        { timeout: T.long },
      );
      await page
        .getByTestId(alias === 'a' ? 'home-hero-submit' : 'chat-send')
        .click({ timeout: T.medium });
      const accepted = await manual;
      expect(accepted.status()).toBe(202);
      const manualRunId = ((await accepted.json()) as { runId: string }).runId;
      results.manualRunId = manualRunId;
      await expect
        .poll(async () => (await run(manualRunId)).status, {
          timeout: T.xlong * 2,
          intervals: [100, 250],
        })
        .toBe('succeeded');
      results.manualTerminal = await run(manualRunId);
      const rechecks = requests.slice(recheckIndex);
      expect(rechecks.some((r) => r.path === '/api/workspace/billing/request-concurrency')).toBe(
        true,
      );
      expect(rechecks.some((r) => r.path === '/api/workspace/billing/preflight')).toBe(true);
      await page.screenshot({ path: join(output, 'manual-succeeded.png') });
      results.serviceAndUiStepsCompleted = true;
    } finally {
      await page
        .context()
        .setOffline(false)
        .catch(() => undefined);
      await save('observations.private.json', {
        results,
        requests,
        frames,
        bills,
        networkFailures,
        provider: await provider(),
        backend: JSON.parse(await readFile(given.backendObservationPath, 'utf8')),
        concurrency: JSON.parse(await readFile(given.concurrencyObservationPath, 'utf8')),
        transport: transport ? { origin: transport.origin, events: transport.events } : null,
      });
      await info.attach(`RUN010-${alias}-observations`, {
        path: join(output, 'observations.private.json'),
        contentType: 'application/json',
      });
      await cdp.detach().catch(() => undefined);
      if (client) await client.close({ preserveScratch: true });
      if (transport) await transport.close();
    }
  });
}
