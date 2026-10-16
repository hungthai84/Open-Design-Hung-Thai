import { expect } from '@playwright/test';
import type { FrameLocator, Page } from '@playwright/test';
import { T } from '../timeouts.ts';

/** Authored deck bytes only; preview transports and presenter code come from the running app. */
export function previewRecoveryDeck(initializer: string, authoredNavigation = true, bodyOnload = false, htmlPrefix = ''): string {
  return `<!doctype html>${htmlPrefix}<html><head><style>
    html, body { margin: 0; width: 100%; height: 100%; background: #fff; overflow: hidden; }
    .slide { display: none; width: 100%; height: 100%; }
    .slide.active { display: block; }
    h1 { margin: 0; color: rgb(0, 128, 0); }
  </style></head><body${bodyOnload ? ` onload="if (!location.hash) { ${initializer.replace(/"/g, '&quot;')} }"` : ''}>
    ${[1, 2, 3].map(index => `<section class="slide${index === 1 ? ' active' : ''}">
      <h1>Recovery slide ${index}</h1><img src="./logo.png" alt="Logo ${index}">
      <img class="joined-logo" alt="Joined logo ${index}">
    </section>`).join('')}
    <script>
      ${bodyOnload ? '' : `if (!location.hash) { ${initializer} }`}
      ${authoredNavigation ? `
      function activeRoute() {
        var match = location.hash.match(/^#\\/(\\d+)$/);
        return match ? Math.max(0, Math.min(2, Number(match[1]) - 1)) : 0;
      }
      function renderRoute() {
        var active = activeRoute();
        document.querySelectorAll('.slide').forEach(function(slide, index) { slide.classList.toggle('active', index === active); });
      }
      window.addEventListener('hashchange', renderRoute);
      window.addEventListener('keydown', function(event) {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
        event.preventDefault();
        var index = Math.max(0, Math.min(2, activeRoute() + (event.key === 'ArrowRight' ? 1 : -1)));
        location.hash = '#/' + (index + 1);
      });
      renderRoute();
      ` : ''}
      document.querySelectorAll('.joined-logo').forEach(function(image) {
        image.src = document.baseURI + 'logo.png';
      });
    </script>
  </body></html>`;
}

export async function openPreviewPresenter(page: Page): Promise<Page> {
  await page.getByRole('button', { name: 'Present', exact: true }).click();
  const popup = page.waitForEvent('popup');
  await page.getByRole('menuitem').filter({ hasText: /in this tab/i }).click();
  return await popup;
}

export async function expectRecoveryFrame(frame: FrameLocator, index: number, baseHref?: string, hash = '#/' + (index + 1), heading = `Recovery slide ${index + 1}`): Promise<void> {
  await expect(frame.getByRole('heading', { name: heading, exact: true })).toBeVisible({ timeout: T.medium });
  for (const label of [`Logo ${index + 1}`, `Joined logo ${index + 1}`]) {
    const image = frame.getByRole('img', { name: label, exact: true });
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth), { timeout: T.medium }).toBe(1);
    if (baseHref) {
      await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.src), { timeout: T.medium }).toBe(baseHref + 'logo.png');
    }
  }
  await expect.poll(() => frame.locator('body').evaluate(() => location.hash), { timeout: T.medium }).toBe(hash);
  if (baseHref) await expect.poll(() => frame.locator('body').evaluate(() => document.baseURI), { timeout: T.medium }).toBe(baseHref);
}

export async function expectRecoveryPresenter(presenter: Page, index: number, baseHref?: string): Promise<void> {
  await expect(presenter.locator('#counter')).toHaveText(`${index + 1} / 3`);
  await expectRecoveryFrame(presenter.frameLocator('#current'), index, baseHref);
  if (index > 0) {
    await expect(presenter.locator('#previous-section')).toBeVisible();
    await expectRecoveryFrame(presenter.frameLocator('#previous'), index - 1, baseHref);
  } else await expect(presenter.locator('#previous-section')).toBeHidden();
  if (index < 2) {
    await expect(presenter.locator('#next-section')).toBeVisible();
    await expectRecoveryFrame(presenter.frameLocator('#next'), index + 1, baseHref);
  } else await expect(presenter.locator('#next-section')).toBeHidden();
}

export function previewDirectoryHref(documentUrl: string): string {
  const url = new URL(documentUrl);
  url.pathname = url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1);
  url.search = '';
  url.hash = '';
  return url.href;
}

export async function observePreviewScopeRecovery(page: Page, projectId: string): Promise<{ scopes: string[]; renewalStatuses: number[] }> {
  const scopes: string[] = [];
  const renewalStatuses: number[] = [];
  const context = page.context();
  context.on('response', response => {
    const url = new URL(response.url());
    if (url.pathname.startsWith(`/api/projects/${projectId}/preview/`) && url.pathname.endsWith('/renew')) renewalStatuses.push(response.status());
  });
  await context.route(`**/api/projects/${projectId}/preview-url?**`, async route => {
    const response = await route.fetch();
    const body = await response.json() as { url?: string; documentMode?: string; expiresAt?: number };
    if (response.ok() && typeof body.url === 'string' && body.documentMode?.startsWith('bootstrap')) {
      const href = new URL(body.url, page.url()).href;
      if (scopes.at(-1) !== href) scopes.push(href);
      // Only accelerate the host's schedule. Tests really restart their daemon
      // to invalidate the old capability; this endpoint mints its replacement.
      body.expiresAt = await page.evaluate(() => Date.now()) + 5 * 60 * 1000 + T.long;
    }
    await route.fulfill({ response, json: body });
  });
  return { scopes, renewalStatuses };
}

export async function previewRecoveryWitness(page: Page): Promise<unknown> {
  const frames = await Promise.all(page.frames().map(async frame => {
    try {
      return await frame.evaluate(() => ({
        url: location.href,
        baseURI: document.baseURI,
        documentId: (window as unknown as { __odSrcdocTransportDocumentId?: string }).__odSrcdocTransportDocumentId,
        editing: document.documentElement.hasAttribute('data-od-edit-mode'),
        viewport: { width: innerWidth, height: innerHeight, scrollHeight: document.documentElement.scrollHeight, scrollY },
        deckState: (window as unknown as { __odDeckSlideState?: () => unknown }).__odDeckSlideState?.(),
        slides: Array.from(document.querySelectorAll('.slide')).map(element => ({
          text: element.textContent?.trim(), className: element.className,
          display: getComputedStyle(element).display,
        })),
      }));
    } catch (error) { return { url: frame.url(), error: String(error) }; }
  }));
  const hosts = await page.evaluate(() => Array.from(document.querySelectorAll('iframe')).map(frame => ({
    id: frame.id, title: frame.title, src: frame.src,
    presenterState: (frame as unknown as { __od?: unknown }).__od,
  }))).catch(error => ({ error: String(error) }));
  return { url: page.url(), frames, hosts };
}
