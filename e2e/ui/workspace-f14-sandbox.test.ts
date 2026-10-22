import { writeFile } from 'node:fs/promises';
import { clusterTest as test, expect } from '@/playwright/suite';
import { startScopedFundingClient } from '@/playwright/workspace-funding-client';
import { readFundingRuntimeFixture, fundingHeaders, type FundingRuntimeFixture, type FundingSpace } from '@/playwright/workspace-funding-fixture';
import { T } from '@/timeouts';
type Fixture = FundingRuntimeFixture & { f14: { caseKey: 'client:UISTATE-F14-CLIENT'; roles: Record<'admin' | 'member', { actor: FundingRuntimeFixture['actor']; space: FundingSpace }> } };
for (const role of ['admin', 'member'] as const) {
  if (process.env.OD_F14_ACTOR && process.env.OD_F14_ACTOR !== role) continue;
  test(`[P0] F14 ${role} insufficient balance retains original step1 chatpanel draft and artifact`, async ({ page }, info) => {
    test.setTimeout(T.xlong * 7);
    const full = await readFundingRuntimeFixture() as Fixture; expect(full.f14.caseKey).toBe('client:UISTATE-F14-CLIENT');
    const given = full.f14.roles[role]; const fixture = { ...full, actor: given.actor }; const space = given.space;
    expect(space.actorRole).toBe(role); expect(space.actorMemberId).not.toBe(space.ownerMemberId);
    let client: Awaited<ReturnType<typeof startScopedFundingClient>> | undefined;
    const observations: unknown[] = []; const artifact = '<!doctype html><html><title>F14 preserved original artifact</title><h1>F14 original artifact remains unchanged</h1></html>'; const artifactName = 'f14-original.html';
    try {
      client = await startScopedFundingClient(page, info, { fixture, initialSpace: space, checkedSpaces: { target: space }, runtimeKey: space.runtimeKey, requireNamePrefix: true, preserveSelectedLocale: true, checkPreflight(_alias, _space, preflight) { expect(Number(preflight.balanceUsd)).toBe(0); expect(preflight.codingPlan.eligible).toBe(false); expect(preflight.fundingCheck).toBe('insufficient'); } });
      const projectId = await client.createProject(space);
      const fileUrl = client.runtime.url.web(`/api/projects/${projectId}/files/${artifactName}`);
      const file = await fetch(client.runtime.url.web(`/api/projects/${projectId}/files`), { method: 'POST', headers: { ...fundingHeaders(space), 'content-type': 'application/json' }, body: JSON.stringify({ name: artifactName, content: artifact, encoding: 'utf8' }) }); expect(file.ok).toBe(true);
      await page.goto(client.runtime.url.web('/'), { waitUntil: 'domcontentloaded', timeout: T.xlong });
      await page.evaluate(() => { localStorage.setItem('open-design:locale', 'zh-CN'); localStorage.setItem('open-design:locale-source', 'manual'); });
      await page.reload({ waitUntil: 'domcontentloaded', timeout: T.xlong }); await client.select(space);
      for (const surface of ['project'] as const) {
        if (surface === 'project') await page.goto(client.runtime.url.web(`/projects/${projectId}`), { waitUntil: 'domcontentloaded', timeout: T.xlong });
        const input = page.getByTestId('chat-composer-input'); const send = page.getByTestId('chat-send');
        await expect(input).toBeVisible({ timeout: T.xlong }); const draft = `F14 ${role} ${surface} 保留原输入，额度不足不能启动`; await input.fill(draft); await expect(send).toBeEnabled({ timeout: T.medium });
        const postsBefore = client.posts.length; const pathBefore = new URL(page.url()).pathname; const clickedAt = new Date().toISOString();
        await send.click({ timeout: T.medium }); const overlay = page.getByTestId('amr-balance-owner-dialog'); await expect(overlay).toBeVisible({ timeout: T.medium });
        const dialog = overlay.getByRole('dialog'); 
        const images = await dialog.locator('img').evaluateAll(elements => elements.map(el => { const img = el as HTMLImageElement; return { src: img.getAttribute('src'), complete: img.complete, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight }; }));
        await expect.poll(() => dialog.locator('img').evaluateAll(elements => elements.every(el => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0)), { timeout: T.medium }).toBe(true);
        const saved = await fetch(fileUrl, { headers: fundingHeaders(space) }); const savedArtifact = await saved.text();
        const actual = { role, surface, clickedAt, observedAt: new Date().toISOString(), pathBefore, actualPath: new URL(page.url()).pathname, dialogText: await dialog.innerText(), buttons: await dialog.getByRole('button').allTextContents(), geometry: await dialog.boundingBox(), images, draft, actualInput: await input.textContent(), artifactStatus: saved.status, artifactUnchanged: savedArtifact === artifact, posts: client.posts.slice(postsBefore), wholeQaPassed: false, originalStep2NotExecuted: true };
        observations.push(actual); await writeFile(info.outputPath(`${role}-${surface}-actual.safe.json`), JSON.stringify(actual, null, 2)); await page.screenshot({ path: info.outputPath(`${role}-${surface}-actual.png`) }); await dialog.screenshot({ path: info.outputPath(`${role}-${surface}-dialog.png`) });
        expect(actual.posts.filter(p => p.path === '/api/runs')).toEqual([]); expect(actual.actualInput).toBe(draft); expect(actual.artifactUnchanged).toBe(true);
        expect(images).toHaveLength(1); expect(images[0]?.src).toBe('/upgrade/cloud-signin-aurora.jpg');
        expect(actual.buttons.map(x => x.trim()).filter(Boolean)).toEqual(['知道了']);
        await expect(dialog).toContainText('额度不足'); await expect(dialog).toContainText('充值或升级订阅');
        await page.getByTestId('amr-balance-owner-dismiss').click({ timeout: T.medium }); await expect(overlay).toBeHidden({ timeout: T.short }); await expect(input).toHaveText(draft); await expect(input).toBeEditable();
      }
    } finally {
      await writeFile(info.outputPath(`${role}-firstpass-observations.safe.json`), JSON.stringify({ observations, wholeQaPassed: false, originalStep2: 'not executed; formal owner recovery is a separate remaining original obligation', telemetryIsNotFailureCriterion: true }, null, 2));
      if (client) await client.close({ preserveScratch: true });
    }
  });
}
