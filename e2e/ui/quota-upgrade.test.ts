import { expect, test } from '@/playwright/suite';
import { applyStandardMocks } from '@/playwright/mock-factory';

test.use({ screenshot: 'off', video: 'off', trace: 'off' });

test('[P1] UI-002 scoped quota renders and SAFE-004 Upgrade opens the local console', async ({ page }) => {
  const workspace = {
    workspaceId: 'ui-quota-local',
    workspaceMemberId: 'ui-quota-owner',
    workspaceName: 'Quota local',
    workspaceType: 'team',
    role: 'owner',
    memberStatus: 'active',
    lifecycleState: 'active',
    billingState: 'active',
    planId: 'team_go',
    permissions: { canManageBilling: true, canInviteMembers: true, canViewWorkspaceSettings: true },
  };
  const localConsole = 'http://127.0.0.1:52677';
  await applyStandardMocks(page);
  await page.addInitScript(({ workspaceId, workspaceMemberId }) => {
    window.sessionStorage.setItem('od.workspaceSelection.v1', JSON.stringify({ workspaceId, workspaceMemberId }));
  }, workspace);
  await page.route('**/api/integrations/vela/status*', route => route.fulfill({ json: {
    loggedIn: true,
    loginInFlight: false,
    profile: 'local',
    consoleOrigin: localConsole,
    configPath: '/tmp/local-amr/config.json',
    user: { id: 'ui-quota-user', email: 'quota@example.invalid', name: 'Quota User', plan: 'team_go' },
  } }));
  await page.route('**/api/workspace/**', async route => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/api/workspace/directory') {
      await route.fulfill({ json: { items: [workspace], activeWorkspaceId: workspace.workspaceId } });
    } else if (pathname === '/api/workspace/context') {
      await route.fulfill({ json: { context: workspace } });
    } else if (pathname === '/api/workspace/billing/interests' || pathname.startsWith('/api/workspace/billing/interests/')) {
      const body = route.request().postDataJSON() as { generation?: string } | null;
      await route.fulfill({ json: body?.generation
        ? { clientId: 'ui-quota', acceptedGeneration: body.generation, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() }
        : { ok: true } });
    } else if (pathname === '/api/workspace/billing') {
      await route.fulfill({ json: {
        summary: null,
        workspaceBalance: { workspaceId: workspace.workspaceId, workspaceMemberId: workspace.workspaceMemberId,
          balanceUsd: '24.00', billingScopeVersion: 2, expiresAt: null, updatedAt: '2026-10-22T00:00:00Z' },
        workspaceSnapshot: {
          schemaVersion: 1,
          billingScopeVersion: 2,
          workspaceId: workspace.workspaceId,
          workspaceMemberId: workspace.workspaceMemberId,
          billing: { billingState: 'active', planId: 'team_go' },
          wallet: { balanceUsd: '24.00', expiresAt: null, updatedAt: '2026-10-22T00:00:00Z' },
          designPlanWindows: [
            { kind: '5h', windowStart: null, resetsAt: null, remainingCredits: '0', limitCredits: '1000000000000000000' },
            { kind: '7d', windowStart: null, resetsAt: null, remainingCredits: '750000', limitCredits: '1000000' },
          ],
          revisions: { billing: 'b1', wallet: 'w1' },
        },
      } });
    } else {
      await route.fallback();
    }
  });
  await page.context().route(`${localConsole}/dashboard**`, route => route.fulfill({ contentType: 'text/html', body: '<title>Local console</title>' }));
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  const pill = page.getByTestId('entry-top-right-credits');
  await expect(pill).toBeVisible();
  await pill.click();
  const panel = page.getByTestId('entry-top-right-credits-panel');
  await expect(panel).toBeVisible();
  const windows = panel.getByRole('progressbar');
  await expect(windows).toHaveCount(2);
  await expect(windows.nth(0)).toHaveAttribute('aria-valuenow', '0');
  await expect(windows.nth(1)).toHaveAttribute('aria-valuenow', '75');
  await expect(panel.getByText(/Details unavailable|明细暂不可用/)).toHaveCount(0);
  const popupPromise = page.waitForEvent('popup');
  await panel.getByRole('button', { name: 'Upgrade', exact: true }).click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(`${localConsole}/dashboard?workspaceId=${workspace.workspaceId}&source=open_design&billing=plan`);
  await popup.close();
});
