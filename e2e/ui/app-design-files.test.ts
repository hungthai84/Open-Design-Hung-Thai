import { ACTIVE_ARTIFACT_PREVIEW_SELECTOR } from '@/playwright/artifact-preview';
import { expectStableCount } from '@/playwright/assertions';
import { expect, test } from '@/playwright/suite';
import { openNewProjectModal as openNewProjectModalFromProjects } from '@/playwright/rail';
import { applyStandardMocks, routeAgents } from '@/playwright/mock-factory';
import { clickPreviewToolbarAction, expectAllProjectFilesActive, openAllProjectFiles } from '@/playwright/workspace';
import type { Locator, Page, Request } from '@playwright/test';
import { automatedUiScenarios } from '@/playwright/resources';
import type { UiScenario } from '@/playwright/resources';
import { T } from '@/timeouts';
import {
  expectRecoveryFrame, expectRecoveryPresenter, openPreviewPresenter, observePreviewScopeRecovery,
  previewDirectoryHref, previewRecoveryDeck, previewRecoveryWitness,
} from '@/playwright/preview-recovery';
import { warmPlaywrightDaemonRuntime } from '@/playwright/runtime-lifecycle';
import {
  PREVIEW_WHITE_SCREEN_CONFIRMATION_MS,
  PREVIEW_WHITE_SCREEN_TIMEOUT_MS,
} from '@open-design/contracts/runtime/preview-observability';

const STORAGE_KEY = 'open-design:config';
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5W6McAAAAASUVORK5CYII=';

interface CapturedSafetyEvent {
  event?: string;
  properties?: Record<string, unknown>;
}

test.describe.configure({ timeout: T.xlong });

test.beforeEach(async ({ page }) => {
  await applyStandardMocks(page);
});

test.afterEach(async ({ page }, testInfo) => {
  if ((!testInfo.title.includes('native preview recovery') && !testInfo.title.includes('direct srcdoc reload'))
    || testInfo.status === testInfo.expectedStatus) return;
  const pages = await Promise.all(page.context().pages().map(previewRecoveryWitness));
  await testInfo.attach('preview-recovery-witness', { body: JSON.stringify(pages, null, 2), contentType: 'application/json' });
});

const designFileFlows = new Set([
  'design-files-upload',
  'design-files-delete',
  'design-files-tab-persistence',
  'uploaded-image-renders-in-preview',
  'python-source-preview',
]);
const CRITICAL_DESIGN_FILE_SCENARIO_IDS = new Set([
  'design-files-upload',
  'design-files-delete',
  'design-files-tab-persistence',
]);

async function routeMockAgents(page: Page) {
  await routeAgents(page, [
    {
      id: 'mock',
      name: 'Mock Agent',
      bin: 'mock-agent',
      available: true,
      version: 'test',
      models: [{ id: 'default', label: 'Default' }],
    },
  ]);
}

async function captureSafetyTelemetry(page: Page): Promise<CapturedSafetyEvent[]> {
  const events: CapturedSafetyEvent[] = [];
  await page.unroute('**/api/app-config').catch(() => {});
  await page.addInitScript((key) => {
    window.localStorage.setItem(
      key,
      JSON.stringify({
        mode: 'daemon',
        apiKey: '',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-5',
        agentId: 'mock',
        skillId: null,
        designSystemId: null,
        onboardingCompleted: true,
        agentModels: {},
        privacyDecisionAt: 1,
        telemetry: { metrics: true, content: false, artifactManifest: false },
      }),
    );
  }, STORAGE_KEY);
  await page.route('**/api/app-config', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({
      json: {
        config: {
          onboardingCompleted: true,
          agentId: 'mock',
          skillId: null,
          designSystemId: null,
          agentModels: {},
          privacyDecisionAt: 1,
          telemetry: { metrics: true, content: false, artifactManifest: false },
        },
      },
    });
  });
  await page.route('**/api/analytics/config', async (route) => {
    await route.fulfill({
      json: {
        enabled: true,
        env: 'e2e',
        key: 'phc_e2e',
        host: 'https://analytics.open-design.test',
        installationId: 'e2e-installation',
      },
    });
  });
  await page.route('https://analytics.open-design.test/**', async (route) => {
    const body = route.request().postData();
    if (body) {
      try {
        events.push(JSON.parse(body) as CapturedSafetyEvent);
      } catch {
        // posthog-js can use non-JSON batch encodings; this witness owns only
        // the direct JSON safety-telemetry transport.
      }
    }
    await route.fulfill({ status: 200, json: { status: 1 } });
  });
  return events;
}

function capturedWhiteScreenEvents(
  events: CapturedSafetyEvent[],
): CapturedSafetyEvent[] {
  return events.filter((event) => event.event === 'client_preview_white_screen');
}

for (const entry of automatedUiScenarios().filter((scenario) => designFileFlows.has(scenario.flow ?? ''))) {
  test(`[${designFileScenarioPriority(entry)}]${criticalDesignFileScenarioTag(entry)} ${entry.id}: ${entry.title}`, async ({ page }) => {
    await routeMockAgents(page);

    await gotoEntryHome(page);
    await createProject(page, entry);
    await expectWorkspaceReady(page);

    if (entry.flow === 'design-files-upload') {
      await runDesignFilesUploadFlow(page);
      return;
    }
    if (entry.flow === 'design-files-delete') {
      await runDesignFilesDeleteFlow(page);
      return;
    }
    if (entry.flow === 'design-files-tab-persistence') {
      await runDesignFilesTabPersistenceFlow(page);
      return;
    }
    if (entry.flow === 'uploaded-image-renders-in-preview') {
      await runUploadedImageRendersInPreviewFlow(page, entry);
      return;
    }
    if (entry.flow === 'python-source-preview') {
      await runPythonSourcePreviewFlow(page, entry);
    }
  });
}

async function createProject(page: Page, entry: UiScenario) {
  await createProjectNameOnly(page, entry);
  await page.getByTestId('create-project').click();
}

async function createProjectViaApi(page: Page, name: string): Promise<string> {
  const projectId = `markdown-plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const response = await page.request.post('/api/projects', {
    data: {
      id: projectId,
      name,
      skillId: null,
      designSystemId: null,
      pendingPrompt: null,
      metadata: { kind: 'prototype' },
    },
  });
  expect(response.ok(), `create project: ${await response.text()}`).toBeTruthy();
  return projectId;
}

async function createProjectNameOnly(page: Page, entry: UiScenario) {
  await openNewProjectModal(page);
  if (entry.create.tab) {
    await page.getByTestId(`new-project-tab-${entry.create.tab}`).click();
  }
  await page.getByTestId('new-project-name').fill(entry.create.projectName);
}

async function gotoEntryHome(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForLoadingToClear(page);
  const privacyDialog = page.getByRole('dialog').filter({ hasText: 'Help us improve OpenDesign' });
  if (await privacyDialog.isVisible()) {
    await privacyDialog.getByRole('button', { name: /I get it|not now|got it|don't share/i }).click();
    await expect(privacyDialog).toHaveCount(0);
  }
  await expect(page.getByTestId('home-hero')).toBeVisible();
  await expect(page.getByTestId('home-hero-input')).toBeVisible();
}

async function openNewProjectModal(page: Page) {
  await openNewProjectModalFromProjects(page);
}

async function expectWorkspaceReady(page: Page) {
  await waitForLoadingToClear(page);
  await expect(page).toHaveURL(/\/projects\//);
  await expect(page.getByTestId('chat-composer')).toBeVisible();
  await expect(page.getByTestId('chat-composer-input')).toBeVisible();
  await expect(page.getByTestId('file-workspace')).toBeVisible();
}

async function getCurrentProjectContext(page: Page): Promise<{ projectId: string; conversationId: string }> {
  const current = new URL(page.url());
  const [, projects, projectId, maybeConversations, conversationId] = current.pathname.split('/');
  if (projects !== 'projects' || !projectId) {
    throw new Error(`unexpected project route: ${current.pathname}`);
  }
  if (maybeConversations === 'conversations' && conversationId) {
    return { projectId, conversationId };
  }

  const response = await page.request.get(`/api/projects/${projectId}/conversations`);
  expect(response.ok()).toBeTruthy();
  const { conversations } = (await response.json()) as {
    conversations: Array<{ id: string; updatedAt: number }>;
  };
  const active = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (!active) throw new Error(`no conversations found for project ${projectId}`);
  return { projectId, conversationId: active.id };
}

async function seedProjectFile(
  page: Page,
  projectId: string,
  name: string,
  content: string,
  encoding?: 'base64',
  artifactManifest?: Record<string, unknown>,
) {
  const response = await page.request.post(
    `/api/projects/${projectId}/files`,
    {
      data: {
        name,
        content,
        ...(encoding ? { encoding } : {}),
        ...(artifactManifest ? { artifactManifest } : {}),
      },
      timeout: 15_000,
    },
  );
  expect(response.ok()).toBeTruthy();
}

async function seedHtmlArtifact(page: Page, projectId: string, fileName: string, content: string) {
  const resp = await page.request.post(
    `/api/projects/${projectId}/files`,
    {
      data: {
        name: fileName,
        content,
        artifactManifest: {
          version: 1,
          kind: 'html',
          title: fileName,
          entry: fileName,
          renderer: 'html',
          exports: ['html'],
        },
      },
      timeout: 15_000,
    },
  );
  expect(resp.ok()).toBeTruthy();
}

async function listProjectFilesFromApi(
  page: Page,
  projectId: string,
): Promise<Array<{ name: string; kind: string }>> {
  const response = await page.request.get(`/api/projects/${projectId}/files`);
  expect(response.ok()).toBeTruthy();
  const { files } = (await response.json()) as { files: Array<{ name: string; kind: string }> };
  return files;
}

async function expectProjectFileToContain(
  page: Page,
  projectId: string,
  fileName: string,
  expected: string,
) {
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/projects/${projectId}/files/${fileName}`);
      if (!response.ok()) return '';
      return response.text();
    }, { timeout: 15_000 })
    .toContain(expected);
}

async function readProjectFileText(page: Page, projectId: string, fileName: string): Promise<string> {
  const response = await page.request.get(`/api/projects/${projectId}/files/${fileName}`);
  expect(response.ok()).toBeTruthy();
  return response.text();
}

async function expectScenarioFiles(
  page: Page,
  entry: UiScenario,
  projectId: string,
) {
  if (!entry.expectedFiles?.length) return;
  const files = await listProjectFilesFromApi(page, projectId);
  for (const expectedFile of entry.expectedFiles) {
    const actual = files.find((file) => file.name === expectedFile.name);
    expect(actual, `missing expected file ${expectedFile.name}`).toBeDefined();
    if (expectedFile.kind) {
      expect(actual?.kind).toBe(expectedFile.kind);
    }
    if (expectedFile.previewText) {
      await expectProjectFileToContain(page, projectId, expectedFile.name, expectedFile.previewText);
    }
  }
}

async function expectScenarioPreviewText(page: Page, entry: UiScenario) {
  if (!entry.expectedPreviewText) return;
  const frame = page.frameLocator('[data-testid="artifact-preview-frame"]');
  await expect(frame.getByText(entry.expectedPreviewText, { exact: false })).toBeVisible();
}

async function expectScenarioProjectState(
  page: Page,
  entry: UiScenario,
  projectId: string,
) {
  await expectScenarioFiles(page, entry, projectId);
  await expectScenarioPreviewText(page, entry);
}

async function expectProjectFilesToIncludeSuffixes(
  page: Page,
  projectId: string,
  suffixes: string[],
) {
  await expect
    .poll(async () => {
      const names = (await listProjectFilesFromApi(page, projectId)).map((file) => file.name);
      return suffixes.every((suffix) => names.some((name) => name.endsWith(suffix)));
    })
    .toBe(true);
}

async function waitForSingleSketchFile(page: Page, projectId: string): Promise<string> {
  let sketchName = '';
  await expect
    .poll(async () => {
      const sketches = (await listProjectFilesFromApi(page, projectId))
        .filter((file) => file.kind === 'sketch' && file.name.endsWith('.sketch.json'));
      sketchName = sketches[0]?.name ?? '';
      return sketches.length;
    }, { timeout: 15_000 })
    .toBe(1);
  return sketchName;
}

async function openDesignFile(page: Page, fileName: string) {
  const fileTab = page.getByRole('tab', { name: new RegExp(fileName.replace(/\./g, '\\.'), 'i') });
  if (await fileTab.isVisible()) {
    if (await fileTab.getAttribute('aria-selected') !== 'true') {
      await fileTab.click();
    }
    await expect(fileTab).toHaveAttribute('aria-selected', 'true');
    return;
  }

  await openAllProjectFiles(page);
  const fileRow = await revealDesignFileRow(page, fileName);
  // #5517 deleted the preview pane and its Open button: a single click on the
  // row's primary target opens the file in a workspace tab.
  await fileRow.getByRole('button').first().click();
  await expect(fileTab).toHaveAttribute('aria-selected', 'true');
}

// Uploaded files can land under a deduplicated name, and #5517 image cards
// render no filename text, so match Design Files rows on the `data-testid`
// suffix rather than on rendered text.
function designFileRow(page: Page, fileName: string): Locator {
  return page.locator(`[data-testid^="design-file-row-"][data-testid$="${fileName}"]`).first();
}

// #5517 groups the panel behind per-category tabs, so a file is only listed
// while its own category tab is active. Land on the row the way a user would:
// look under the default category, otherwise page through the tab bar.
async function revealDesignFileRow(page: Page, fileName: string): Promise<Locator> {
  const row = designFileRow(page, fileName);
  if (await row.isVisible().catch(() => false)) return row;
  const categoryTabs = page.getByTestId('design-files-tabs').getByRole('tab');
  const count = await categoryTabs.count();
  for (let index = 0; index < count; index += 1) {
    await categoryTabs.nth(index).click();
    if (await row.isVisible().catch(() => false)) return row;
  }
  await expect(row).toBeVisible();
  return row;
}

async function waitForLoadingToClear(page: Page) {
  await page.getByText('Loading OpenDesign…').waitFor({ state: 'hidden', timeout: T.long });
}

async function expectVisibleAcrossAnimationFrames(locator: Locator) {
  await expect(locator).toBeVisible();
  const stayedVisible = await locator.evaluate(async (element) => {
    const isVisible = () => {
      const style = window.getComputedStyle(element);
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity) > 0 &&
        element.getClientRects().length > 0
      );
    };

    for (let frame = 0; frame < 3; frame += 1) {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      if (!isVisible()) return false;
    }
    return true;
  });
  expect(stayedVisible).toBe(true);
}

async function waitForObservedActivityQuiescence(
  page: Page,
  currentEpoch: () => number,
  recentActivity: () => readonly string[],
  label: string,
) {
  const deadline = Date.now() + T.short;
  let observedEpoch = currentEpoch();
  while (Date.now() < deadline) {
    const completed = await page.evaluate(
      ({ frameCount, timeoutMs }) => new Promise<boolean>((resolve) => {
        let frames = 0;
        const watchdog = window.setTimeout(() => resolve(false), timeoutMs);
        const next = () => {
          frames += 1;
          if (frames >= frameCount) {
            window.clearTimeout(watchdog);
            resolve(true);
            return;
          }
          window.requestAnimationFrame(next);
        };
        window.requestAnimationFrame(next);
      }),
      { frameCount: 36, timeoutMs: Math.max(1, deadline - Date.now()) },
    );
    if (!completed) break;
    const nextEpoch = currentEpoch();
    if (nextEpoch === observedEpoch) return;
    observedEpoch = nextEpoch;
  }
  throw new Error(
    `${label} did not settle within ${T.short}ms; recent activity: ${recentActivity().slice(-12).join(', ')}`,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function runUploadedImageRendersInPreviewFlow(page: Page, entry: UiScenario) {
  const { projectId } = await getCurrentProjectContext(page);
  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5W6McAAAAASUVORK5CYII=',
    'base64',
  );
  await page.getByTestId('design-files-upload-input').setInputFiles({
    name: 'brand.png',
    mimeType: 'image/png',
    buffer: pngBytes,
  });
  await expect(page.getByRole('tab', { name: /brand\.png/i })).toBeVisible();

  const uploadedImage = await page.request.get(
    `/api/projects/${encodeURIComponent(projectId)}/raw/brand.png`,
  );
  expect(uploadedImage.ok(), `uploaded image: ${await uploadedImage.text()}`).toBeTruthy();
  expect(uploadedImage.headers()['content-type']).toContain('image/png');

  await seedHtmlArtifact(
    page,
    projectId,
    'image-preview.html',
    // Generated pages commonly use site-root paths. Before the preview asset
    // normalization fix, this resolved against the OpenDesign app origin and
    // left the uploaded image broken even though its project raw URL was valid.
    '<!doctype html><html><body><main><h1>Image Preview</h1><img alt="Brand logo" src="/brand.png"></main></body></html>',
  );
  await page.reload();
  await expectWorkspaceReady(page);
  await openDesignFile(page, 'image-preview.html');

  const image = page.frameLocator('[data-testid="artifact-preview-frame"]').getByRole('img', { name: 'Brand logo' });
  await expect(image).toBeVisible();
  await expect
    .poll(async () => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
    .toBe(true);
  await expectScenarioProjectState(page, entry, projectId);
}

async function runPythonSourcePreviewFlow(page: Page, entry: UiScenario) {
  const { projectId } = await getCurrentProjectContext(page);
  await seedProjectFile(page, projectId, 'app.py', 'def greet():\n    return "hello from python"\n');
  await page.reload();
  await openDesignFile(page, 'app.py');

  await expect(page.locator('.code-viewer')).toContainText('def greet');
  await expect(page.locator('.code-viewer')).toContainText('hello from python');
  await expectScenarioFiles(page, entry, projectId);
}

async function runDesignFilesUploadFlow(page: Page) {
  const { projectId } = await getCurrentProjectContext(page);
  await page.getByTestId('design-files-upload-input').setInputFiles({
    name: 'moodboard.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5W6McAAAAASUVORK5CYII=',
      'base64',
    ),
  });

  await expect(page.getByRole('tab', { name: /moodboard\.png/i })).toBeVisible();
  await openAllProjectFiles(page);
  // #5517 deleted the preview pane that used to spell out kind / size /
  // download for the picked file. The panel's category tab bar is what states
  // the kind now, and the card grid itself is the preview: uploading an image
  // has to file it under Images and reopen it on a single click. (The row's ⋯
  // menu still carries Download — covered by the single-file actions spec.)
  const imagesTab = page.getByTestId('design-files-tab-cat:image');
  await expect(imagesTab).toBeVisible();
  await imagesTab.click();
  const fileRow = designFileRow(page, 'moodboard.png');
  await expect(fileRow).toBeVisible();

  await fileRow.getByRole('button').first().click();
  await expect(page.getByRole('tab', { name: /moodboard\.png/i })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expectProjectFilesToIncludeSuffixes(page, projectId, ['moodboard.png']);
}

async function runDesignFilesDeleteFlow(page: Page) {
  const { projectId } = await getCurrentProjectContext(page);
  page.on('dialog', async (dialog) => {
    await dialog.accept();
  });

  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5W6McAAAAASUVORK5CYII=',
    'base64',
  );

  await page.getByTestId('design-files-upload-input').setInputFiles({
    name: 'keep-me.png',
    mimeType: 'image/png',
    buffer: pngBytes,
  });
  await expect(page.getByRole('tab', { name: /keep-me\.png/i })).toBeVisible();

  await page.getByTestId('design-files-upload-input').setInputFiles({
    name: 'trash-me.png',
    mimeType: 'image/png',
    buffer: pngBytes,
  });

  await expect(page.getByRole('tab', { name: /trash-me\.png/i })).toBeVisible();
  await openAllProjectFiles(page);

  const fileRow = designFileRow(page, 'trash-me.png');
  await expect(fileRow).toBeVisible();
  await fileRow.hover();
  await fileRow.locator('[data-testid^="design-file-menu-"]').click();
  await expect(page.getByTestId('design-file-menu-popover')).toBeVisible();
  await page.locator('[data-testid^="design-file-delete-"]').click();

  await expect(fileRow).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /trash-me\.png/i })).toHaveCount(0);
  await expectAllProjectFilesActive(page);
  await expect(page.getByRole('tab', { name: /keep-me\.png/i })).toBeVisible();
  await expect
    .poll(async () => {
      const names = (await listProjectFilesFromApi(page, projectId)).map((file) => file.name);
      return (
        names.length === 1 &&
        names.some((name) => name.endsWith('keep-me.png')) &&
        names.every((name) => !name.endsWith('trash-me.png'))
      );
    })
    .toBe(true);
}

test('[P1] design files page keeps the current single-file menu actions', async ({ page }) => {
  await routeMockAgents(page);

  await gotoEntryHome(page);
  await openNewProjectModal(page);
  await page.getByTestId('new-project-name').fill('Design files current surface');
  await page.getByTestId('create-project').click();
  await expectWorkspaceReady(page);

  const { projectId } = await getCurrentProjectContext(page);
  await seedProjectFile(page, projectId, 'alpha.html', '<!doctype html><title>alpha</title><h1>alpha</h1>');
  await page.reload();
  await expectWorkspaceReady(page);
  await openAllProjectFiles(page);

  await expect(page.getByRole('button', { name: /filter by kind/i })).toHaveCount(0);
  await expect(page.getByTestId('design-files-batch-delete')).toHaveCount(0);

  const fileRow = page.getByTestId('design-file-row-alpha.html');
  await expect(fileRow).toBeVisible();
  await fileRow.hover();
  await page.getByTestId('design-file-menu-alpha.html').click();

  const menu = page.getByTestId('design-file-menu-popover');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('button', { name: /open in tab/i })).toBeVisible();
  await expect(menu.getByRole('button', { name: /rename/i })).toBeVisible();
  await expect(menu.getByRole('button', { name: /download/i })).toBeVisible();
  await expect(menu.getByRole('button', { name: /delete/i })).toBeVisible();
});

test('[P1] design files new sketch creates a persisted sketch tab and restores it after reload', async ({ page }) => {
  test.setTimeout(90_000);
  await routeMockAgents(page);

  const projectId = await createProjectViaApi(page, 'Design files sketch restore');
  await page.goto(`/projects/${projectId}`, { waitUntil: 'domcontentloaded' });
  await expectWorkspaceReady(page);

  await openAllProjectFiles(page);
  await page.getByTestId('design-files-empty-new-sketch').click();

  const sketchName = await waitForSingleSketchFile(page, projectId);
  const sketchTab = page.getByTestId('file-workspace').getByRole('tab', {
    name: new RegExp(escapeRegExp(sketchName), 'i'),
  });
  await expect(sketchTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('sketch-excalidraw-editor')).toBeVisible();
  await expect(page.getByTestId('sketch-save-state')).toContainText(/saved|saving/i);
  await expectProjectFileToContain(page, projectId, sketchName, '"type": "excalidraw"');
  await expectProjectFileToContain(page, projectId, sketchName, `"name": "${sketchName}"`);

  await page.reload();
  await expectWorkspaceReady(page);
  await expect(page.getByTestId('file-workspace').getByRole('tab', {
    name: new RegExp(escapeRegExp(sketchName), 'i'),
  })).toBeVisible();
  await expect(page.getByTestId('sketch-excalidraw-editor')).toBeVisible();
});

test('[P1] design files tab launcher creates a sketch and exposes editor menu actions', async ({ page }) => {
  test.setTimeout(90_000);
  await routeMockAgents(page);

  await gotoEntryHome(page);
  await openNewProjectModal(page);
  await page.getByTestId('new-project-name').fill('Design files sketch launcher');
  await page.getByTestId('create-project').click();
  await expectWorkspaceReady(page);
  const { projectId } = await getCurrentProjectContext(page);
  await seedProjectFile(page, projectId, 'alpha.html', '<!doctype html><title>alpha</title><h1>alpha</h1>');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expectWorkspaceReady(page);
  await openAllProjectFiles(page);

  await expect(page.getByTestId('design-file-row-alpha.html')).toBeVisible();
  await page.getByTestId('workspace-add-tab').click();
  const launcher = page.getByTestId('tab-launcher-menu');
  await expect(launcher).toBeVisible();
  await launcher.getByRole('button', { name: /^New Sketch$/i }).click();

  const sketchName = await waitForSingleSketchFile(page, projectId);
  await expect(page.getByTestId('file-workspace').getByRole('tab', {
    name: new RegExp(escapeRegExp(sketchName), 'i'),
  })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('sketch-excalidraw-editor')).toBeVisible();
  await expect(page.getByTestId('sketch-save-state')).toContainText(/saved|saving/i);

  await page.getByTestId('sketch-excalidraw-editor').getByTestId('main-menu-trigger').click();
  await expect(page.getByTestId('sketch-menu-save')).toBeVisible();
  await expect(page.getByTestId('sketch-menu-export-image')).toBeVisible();
  await expect(page.getByTestId('sketch-menu-export-image')).toBeDisabled();
  await expect(page.getByTestId('sketch-menu-clear')).toBeVisible();
  await expect(page.getByTestId('sketch-menu-clear')).toBeDisabled();
});

test('[P1] new Excalidraw sketch emits analytics dimensions', async ({ page }) => {
  test.setTimeout(90_000);
  const analyticsBodies: string[] = [];
  await page.unroute('**/api/app-config').catch(() => {});
  await page.addInitScript((key) => {
    window.localStorage.setItem(
      key,
      JSON.stringify({
        mode: 'daemon',
        apiKey: '',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-5',
        agentId: 'mock',
        skillId: null,
        designSystemId: null,
        onboardingCompleted: true,
        agentModels: {},
        privacyDecisionAt: 1,
        telemetry: { metrics: true, content: false, artifactManifest: false },
      }),
    );
  }, STORAGE_KEY);
  await page.route('**/api/app-config', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({
      json: {
        config: {
          onboardingCompleted: true,
          agentId: 'mock',
          skillId: null,
          designSystemId: null,
          agentModels: {},
          privacyDecisionAt: 1,
          telemetry: { metrics: true, content: false, artifactManifest: false },
        },
      },
    });
  });
  await page.route('**/api/analytics/config', async (route) => {
    await route.fulfill({
      json: {
        enabled: true,
        env: 'e2e',
        key: 'phc_e2e',
        host: 'https://analytics.open-design.test',
        installationId: 'e2e-installation',
      },
    });
  });
  await page.route('https://analytics.open-design.test/**', async (route) => {
    analyticsBodies.push(route.request().postData() ?? '');
    await route.fulfill({ status: 200, json: { status: 1 } });
  });
  await routeMockAgents(page);

  const projectId = await createProjectViaApi(page, 'Sketch analytics');
  await page.goto(`/projects/${projectId}`, { waitUntil: 'domcontentloaded' });
  await expectWorkspaceReady(page);
  // The session-mode picker left the composer (#7635), so `session_mode_toggle`
  // can no longer be produced from here; the sketch action is the analytics
  // under test.
  await expect(page.getByTestId('chat-composer').getByTestId('composer-mode-trigger')).toHaveCount(0);
  await openAllProjectFiles(page);
  await page.getByTestId('design-files-empty-new-sketch').click();

  const sketchName = await waitForSingleSketchFile(page, projectId);
  await expect(page.getByTestId('sketch-excalidraw-editor')).toBeVisible();
  await expectProjectFileToContain(page, projectId, sketchName, '"type": "excalidraw"');

  await expect.poll(() => analyticsBodies.join('\n'), { timeout: T.medium }).toContain('new_sketch');
  const raw = analyticsBodies.join('\n');
  expect(raw).not.toContain('session_mode_toggle');
  expect(raw).toContain(projectId);
});

test('[P1] markdown plan documents support code, split, preview, and autosaved edits', async ({ page }) => {
  await routeMockAgents(page);

  await gotoEntryHome(page);
  await openNewProjectModal(page);
  await page.getByTestId('new-project-name').fill('Markdown plan editor modes');
  await page.getByTestId('create-project').click();
  await expectWorkspaceReady(page);
  const { projectId } = await getCurrentProjectContext(page);
  await seedProjectFile(
    page,
    projectId,
    'plan.md',
    [
      '# Seeded Plan',
      '',
      '## Scope',
      '- Confirm markdown editing modes.',
      '',
    ].join('\n'),
  );

  await page.goto(`/projects/${projectId}/files/plan.md`, { waitUntil: 'domcontentloaded' });
  await expectWorkspaceReady(page);
  await expect(page.getByTestId('file-workspace').getByRole('tab', { name: /plan\.md/i })).toBeVisible();

  const markdownModes = page.getByRole('tablist', { name: /markdown view mode/i });
  const codeTab = markdownModes.getByRole('tab', { name: /^Code$/ });
  const splitTab = markdownModes.getByRole('tab', { name: /^Split$/ });
  const previewTab = markdownModes.getByRole('tab', { name: /^Preview$/ });
  const editor = page.getByRole('textbox', { name: /markdown editor/i });
  const preview = page.getByLabel(/markdown preview/i);

  await expect(codeTab).toBeEnabled();
  await expect(splitTab).toBeEnabled();
  await previewTab.click();
  await expect(previewTab).toHaveAttribute('aria-selected', 'true');
  await expect(editor).toHaveCount(0);
  await expect(preview).toContainText('Scope');

  await codeTab.click();
  await expect(codeTab).toHaveAttribute('aria-selected', 'true');
  await expect(editor).toBeVisible();
  await expect(preview).toHaveCount(0);
  await editor.fill(`${await editor.inputValue()}\n## Code Edit\n- Edited from code mode.\n`);
  await expectProjectFileToContain(page, projectId, 'plan.md', 'Edited from code mode.');

  await splitTab.click();
  await expect(splitTab).toHaveAttribute('aria-selected', 'true');
  await expect(editor).toBeVisible();
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('Code Edit');
  await editor.fill(`${await readProjectFileText(page, projectId, 'plan.md')}\n## Split Edit\n- Edited from split mode.\n`);
  await expectProjectFileToContain(page, projectId, 'plan.md', 'Edited from split mode.');
  await expect(preview).toContainText('Split Edit');

  await previewTab.click();
  await expect(previewTab).toHaveAttribute('aria-selected', 'true');
  await expect(editor).toHaveCount(0);
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('Edited from code mode.');
  await expect(preview).toContainText('Edited from split mode.');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expectWorkspaceReady(page);
  await expect(codeTab).toBeEnabled();
  await previewTab.click();
  await expect(previewTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel(/markdown preview/i)).toContainText('Edited from split mode.');
  await codeTab.click();
  await expect(page.getByRole('textbox', { name: /markdown editor/i })).toHaveValue(/Edited from code mode/);
});

test('[P1] design files batch delete removes selected files and keeps cancel retryable', async ({ page }) => {
  await routeMockAgents(page);

  await gotoEntryHome(page);
  await openNewProjectModal(page);
  await page.getByTestId('new-project-name').fill('Design files batch delete');
  await page.getByTestId('create-project').click();
  await expectWorkspaceReady(page);

  const { projectId } = await getCurrentProjectContext(page);
  await seedProjectFile(page, projectId, 'batch-alpha.txt', 'alpha');
  await seedProjectFile(page, projectId, 'batch-beta.txt', 'beta');
  await seedProjectFile(page, projectId, 'batch-keep.txt', 'keep');
  await page.reload();
  await expectWorkspaceReady(page);
  await openAllProjectFiles(page);

  const alpha = page.getByTestId('design-file-row-batch-alpha.txt');
  const beta = page.getByTestId('design-file-row-batch-beta.txt');
  const keep = page.getByTestId('design-file-row-batch-keep.txt');
  await expect(alpha).toBeVisible();
  await expect(beta).toBeVisible();
  await expect(keep).toBeVisible();
  await alpha.getByRole('checkbox').click();
  await beta.getByRole('checkbox').click();

  const batchBar = page.getByTestId('design-files-batch-bar');
  await expect(batchBar).toBeVisible();
  await expect(batchBar).toContainText('2');

  page.once('dialog', async (dialog) => {
    await dialog.dismiss();
  });
  await page.getByTestId('design-files-batch-delete').click();
  await expect(batchBar).toBeVisible();
  await expect(alpha.getByRole('checkbox')).toHaveAttribute('aria-checked', 'true');
  await expect(beta.getByRole('checkbox')).toHaveAttribute('aria-checked', 'true');

  page.once('dialog', async (dialog) => {
    await dialog.accept();
  });
  await page.getByTestId('design-files-batch-delete').click();

  await expect(alpha).toHaveCount(0);
  await expect(beta).toHaveCount(0);
  await expect(keep).toBeVisible();
  await expect(page.getByTestId('design-files-batch-bar')).toHaveCount(0);
  await expect
    .poll(async () => {
      const names = (await listProjectFilesFromApi(page, projectId)).map((file) => file.name);
      return (
        names.includes('batch-keep.txt') &&
        !names.includes('batch-alpha.txt') &&
        !names.includes('batch-beta.txt')
      );
    })
    .toBe(true);
});

test('[P1] design files batch download posts selected names to the archive endpoint', async ({ page }) => {
  await routeMockAgents(page);

  await gotoEntryHome(page);
  await openNewProjectModal(page);
  await page.getByTestId('new-project-name').fill('Design files batch download');
  await page.getByTestId('create-project').click();
  await expectWorkspaceReady(page);

  const { projectId } = await getCurrentProjectContext(page);
  let archiveRequest: { files?: string[] } | null = null;
  await page.route(`**/api/projects/${projectId}/archive/batch`, async (route) => {
    archiveRequest = route.request().postDataJSON() as { files?: string[] };
    await route.fulfill({
      status: 200,
      headers: {
        'content-type': 'application/zip',
        'content-disposition': "attachment; filename*=UTF-8''selected-design-files.zip",
      },
      body: Buffer.from('PK\x05\x06batch-download'),
    });
  });

  await seedProjectFile(page, projectId, 'download-alpha.txt', 'alpha');
  await seedProjectFile(page, projectId, 'download-beta.txt', 'beta');
  await seedProjectFile(page, projectId, 'download-skip.txt', 'skip');
  await page.reload();
  await expectWorkspaceReady(page);
  await openAllProjectFiles(page);

  const alpha = page.getByTestId('design-file-row-download-alpha.txt');
  const beta = page.getByTestId('design-file-row-download-beta.txt');
  await expect(alpha).toBeVisible();
  await expect(beta).toBeVisible();
  await alpha.getByRole('checkbox').click();
  await beta.getByRole('checkbox').click();

  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('design-files-batch-bar').getByRole('button', { name: /^Download$/i }).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toBe('selected-design-files.zip');
  expect(archiveRequest).toEqual({ files: ['download-alpha.txt', 'download-beta.txt'] });
});

for (const srcdoc of [false, true]) {
  test(`[P1] hash initialization preserves the HTML preview (${srcdoc ? 'srcDoc' : 'URL-load'})`, async ({ page }, testInfo) => {
    await routeMockAgents(page);
    const projectId = await createProjectViaApi(page, 'Hash preview regression');
    await seedProjectFile(page, projectId, 'styles.css', 'h1 { color: rgb(0, 128, 0); }');
    await seedProjectFile(page, projectId, 'boot.js', 'window.bootLoaded = true;');
    await seedProjectFile(page, projectId, 'logo.png', TINY_PNG_B64, 'base64');
    await seedProjectFile(page, projectId, 'index.html', `<!doctype html><html><head>
      <link rel="stylesheet" href="./styles.css"><script src="./boot.js"></script>
      </head><body>${srcdoc ? '<section class="slide active">' : '<main>'}<h1>Hash home</h1><img src="./logo.png" alt="Logo">
      <a href="#/details">Details</a><a href="#/home">Home</a><a href="#/leave" id="stay">Stay</a>
      <script>
        var logo = document.createElement('img');
        logo.alt = 'Concatenated logo';
        logo.src = document.baseURI + 'logo.png';
        document.body.appendChild(logo);
        document.getElementById('stay').addEventListener('click', function (event) { event.preventDefault(); });
        function render() { document.querySelector('h1').textContent = location.hash === '#/details' ? 'Hash details' : 'Hash home'; }
        window.addEventListener('hashchange', render);
        if (!location.hash) location.replace('#/home');
        render();
      </script>${srcdoc ? '</section><section class="slide"><h2>Second slide</h2></section>' : '</main>'}</body></html>`, undefined, {
      version: 1,
      kind: srcdoc ? 'deck' : 'html',
      title: 'Hash preview',
      entry: 'index.html',
      // Deck previews use srcDoc through the production renderer contract.
      renderer: srcdoc ? 'deck-html' : 'html',
      exports: ['html'],
    });
    const directoryRequests: string[] = [];
    page.on('request', (request) => {
      const pathname = new URL(request.url()).pathname;
      if (new RegExp('/api/projects/' + projectId + '/preview/[^/]+/$').test(pathname)) directoryRequests.push(pathname);
    });
    await page.goto(`/projects/${projectId}`, { waitUntil: 'domcontentloaded' });
    await expectWorkspaceReady(page);
    await openDesignFile(page, 'index.html');
    await expect(page.getByTestId('artifact-preview-frame'))
      .toHaveAttribute('data-od-render-mode', srcdoc ? 'srcdoc' : 'url-load');
    const preview = page.frameLocator('[data-testid="artifact-preview-frame"]');
    await expect(preview.getByRole('heading', { name: 'Hash home' })).toBeVisible();
    await expect(preview.getByRole('heading', { name: 'Hash home' })).toHaveCSS('color', 'rgb(0, 128, 0)');
    await expect.poll(() => preview.locator('body').evaluate(() => (window as unknown as { bootLoaded: boolean }).bootLoaded)).toBe(true);
    await expect.poll(() => preview.getByRole('img', { name: 'Logo', exact: true }).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
    await expect.poll(() => preview.getByRole('img', { name: 'Concatenated logo' }).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
    await preview.getByRole('link', { name: 'Stay', exact: true }).click();
    expect(await preview.locator('body').evaluate(() => location.hash)).toBe('#/home');
    await preview.getByRole('link', { name: 'Details' }).click();
    await expect(preview.getByRole('heading', { name: 'Hash details' })).toBeVisible();
    await preview.getByRole('link', { name: 'Details' }).click();
    await expect(preview.getByRole('heading', { name: 'Hash details' })).toBeVisible();
    await preview.getByRole('link', { name: 'Home', exact: true }).click();
    await expect(preview.getByRole('heading', { name: 'Hash home' })).toBeVisible();
    await preview.locator('body').evaluate(() => history.back());
    await expect(preview.getByRole('heading', { name: 'Hash details' })).toBeVisible();
    await preview.locator('body').evaluate(() => history.back());
    await expect(preview.getByRole('heading', { name: 'Hash home' })).toBeVisible();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(preview.getByRole('heading', { name: 'Hash home' })).toBeVisible();
    if (srcdoc) {
      await expect(page.locator('.deck-thumbnail-loading')).toHaveCount(0);
      await page.locator('.deck-thumbnail-button').nth(1).click();
      await expect(preview.getByRole('heading', { name: 'Second slide' })).toBeVisible();
      await page.locator('.deck-thumbnail-button').first().click();
      await page.getByRole('button', { name: 'Present', exact: true }).click();
      const popupPromise = page.waitForEvent('popup');
      await page.getByRole('menuitem').filter({ hasText: /in this tab/i }).click();
      const presenter = await popupPromise;
      await expect(page.frameLocator('iframe[title="present"]').getByRole('heading', { name: 'Hash home' })).toBeVisible();
      await expect(presenter.frameLocator('#current').getByRole('heading', { name: 'Hash home' })).toBeVisible();
      await page.locator('.present-exit-btn').click();
    }
    expect(directoryRequests).toHaveLength(0);
    await page.screenshot({ path: testInfo.outputPath('preview-working.png') });
  });
}

for (const [name, initializer, bodyOnload, htmlPrefix] of [
  ['alias', "const go = location.replace.bind(location); go('#/home');", false, ''],
  ['computed property', "location['replace']('#/home');", false, ''],
  ['body onload alias', "const go = location.replace.bind(location); go('#/home');", true, ''],
  ['odd HTML comment', "const go = location.replace.bind(location); go('#/home');", false, '<!-->'],
] as const) {
  test(`[P1] native preview recovery supports ${name} hash initialization in a personal deck`, async ({ page }) => {
    await routeMockAgents(page);
    const projectId = await createProjectViaApi(page, 'Native alias deck');
    await seedPreviewRecoveryDeck(page, projectId, initializer, false, bodyOnload, htmlPrefix);
    const directories: string[] = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname.startsWith(`/api/projects/${projectId}/preview/`) && url.pathname.endsWith('/')) directories.push(url.pathname);
    });
    await page.goto(`/projects/${projectId}`, { waitUntil: 'domcontentloaded' });
    await expectWorkspaceReady(page);
    await openDesignFile(page, 'index.html');
    await expectRecoveryFrame(page.frameLocator('[data-testid="artifact-preview-frame"]'), 0, undefined, '#/home');
    const documentUrl = await page.frameLocator('[data-testid="artifact-preview-frame"]').locator('body').evaluate(() => location.href);
    expect(new URL(documentUrl).pathname).toMatch(new RegExp(`/api/projects/${projectId}/preview/[^/]+/index\\.html$`));
    await expectRecoveryFrame(page.frameLocator('[data-testid="artifact-preview-frame"]'), 0, previewDirectoryHref(documentUrl), '#/home');
    expect(directories, 'hash initialization left the bound file for its directory').toEqual([]);
  });
}

for (const initialIndex of [0, 2, 1]) {
  test(`[P1] native preview recovery replaces presenter scopes twice from slide ${initialIndex + 1}`, async ({ page, toolsDev }, testInfo) => {
    test.setTimeout(T.xlong * 2);
    await routeMockAgents(page);
    await page.clock.install();
    const projectId = await createProjectViaApi(page, 'Native presenter recovery');
    await seedPreviewRecoveryDeck(page, projectId, "location.replace('#/1');");
    const { scopes, renewalStatuses } = await observePreviewScopeRecovery(page, projectId);
    await page.goto(`/projects/${projectId}`, { waitUntil: 'domcontentloaded' });
    await expectWorkspaceReady(page);
    await openDesignFile(page, 'index.html');
    await expectRecoveryFrame(page.frameLocator('[data-testid="artifact-preview-frame"]'), 0);
    await expect(page.locator('.deck-thumbnail-loading')).toHaveCount(0);
    await page.locator('.deck-thumbnail-button').nth(initialIndex).click();
    await expectRecoveryFrame(page.frameLocator('[data-testid="artifact-preview-frame"]'), initialIndex);
    const presenter = await openPreviewPresenter(page);
    await expectRecoveryPresenter(presenter, initialIndex);
    await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now()) + T.short));
    try {
      for (let cycle = 0; cycle < 2; cycle++) {
        const slots = ['current', ...(initialIndex > 0 ? ['previous'] : []), ...(initialIndex < 2 ? ['next'] : [])];
        const locations = await Promise.all(slots.map(slot => presenter.frameLocator('#' + slot).locator('body').evaluate(() => ({ search: location.search, hash: location.hash }))));
        const previous = scopes.at(-1);
        expect(previous, 'native document did not acquire an initial capability').toBeTruthy();
        await toolsDev.restartDaemon();
        await warmPlaywrightDaemonRuntime(toolsDev.url.daemon('/api/health'));
        const oldAsset = await page.request.get(previewDirectoryHref(previous!) + 'logo.png');
        expect(oldAsset.status(), 'daemon restart must invalidate the previous asset capability').toBe(404);
        await page.clock.fastForward(T.long);
        await expect.poll(() => scopes.at(-1), { timeout: T.long }).not.toBe(previous);
        expect(renewalStatuses.at(-1), 'the running product did not observe the expired-scope HTTP renewal failure').toBe(404);
        const currentBase = previewDirectoryHref(scopes.at(-1)!);
        await expectRecoveryPresenter(presenter, initialIndex, currentBase);
        await expectRecoveryFrame(page.frameLocator('iframe[title="present"]'), initialIndex, currentBase);
        const restoredLocations = await Promise.all(slots.map(slot => presenter.frameLocator('#' + slot).locator('body').evaluate(() => ({ search: location.search, hash: location.hash }))));
        expect(restoredLocations, 'scope replacement changed an already loaded presenter route').toEqual(locations);
      }
      expect(new Set(scopes).size, 'two recoveries must mint two fresh capabilities').toBe(3);
      // At an edge, one neighbor was never mounted before either recovery.
      // Moving to the middle must create that cell from the latest snapshot.
      if (initialIndex !== 1) await presenter.keyboard.press(initialIndex === 0 ? 'ArrowRight' : 'ArrowLeft');
      await expectRecoveryPresenter(presenter, 1, previewDirectoryHref(scopes.at(-1)!));
      await expectRecoveryFrame(page.frameLocator('iframe[title="present"]'), 1, previewDirectoryHref(scopes.at(-1)!));
      await presenter.screenshot({ path: testInfo.outputPath('presenter-after-two-scope-replacements.png') });
      await testInfo.attach('scope-recovery', { body: JSON.stringify({ scopes, renewalStatuses }, null, 2), contentType: 'application/json' });
    } catch (error) {
      await testInfo.attach('presenter-before-close', { body: JSON.stringify(await previewRecoveryWitness(presenter), null, 2), contentType: 'application/json' });
      throw error;
    } finally {
      await presenter.close();
      await page.clock.resume();
    }
  });
}

test('[P1] native preview recovery survives query-only history, scope replacement and real preview/Present reloads', async ({ page, toolsDev }, testInfo) => {
  test.setTimeout(T.xlong * 2);
  await routeMockAgents(page);
  await page.clock.install();
  const projectId = await createProjectViaApi(page, 'Native reload recovery');
  await seedPreviewRecoveryDeck(page, projectId, "location.replace('#/1');");
  const { scopes, renewalStatuses } = await observePreviewScopeRecovery(page, projectId);
  await page.goto(`/projects/${projectId}`, { waitUntil: 'domcontentloaded' });
  await expectWorkspaceReady(page);
  await openDesignFile(page, 'index.html');
  const preview = page.frameLocator('[data-testid="artifact-preview-frame"]');
  await expectRecoveryFrame(preview, 0);
  await page.locator('.deck-thumbnail-button').nth(1).click();
  await expectRecoveryFrame(preview, 1);
  const previewReload = page.waitForResponse(response => response.request().isNavigationRequest() && new URL(response.url()).searchParams.get('phase') === 'preview');
  await preview.locator('body').evaluate(() => { history.replaceState(null, '', '?phase=preview' + location.hash); location.reload(); });
  await previewReload;
  await expectRecoveryFrame(preview, 1);
  await expect.poll(() => preview.locator('body').evaluate(() => location.search)).toBe('?phase=preview');
  const previousScope = scopes.at(-1);
  const previousLocation = await preview.locator('body').evaluate(() => ({ search: location.search, hash: location.hash }));
  await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now()) + T.short));
  try {
    await toolsDev.restartDaemon();
    await warmPlaywrightDaemonRuntime(toolsDev.url.daemon('/api/health'));
    expect((await page.request.get(previewDirectoryHref(previousScope!) + 'logo.png')).status()).toBe(404);
    await page.clock.fastForward(T.long);
    await expect.poll(() => scopes.at(-1), { timeout: T.long }).not.toBe(previousScope);
    await expectRecoveryFrame(preview, 1, previewDirectoryHref(scopes.at(-1)!));
    expect(await preview.locator('body').evaluate(() => ({ search: location.search, hash: location.hash }))).toEqual(previousLocation);
    expect(renewalStatuses.at(-1)).toBe(404);
  } finally { await page.clock.resume(); }
  await testInfo.attach('query-scope-recovery', { body: JSON.stringify({ scopes, renewalStatuses, previousLocation }, null, 2), contentType: 'application/json' });
  const presenter = await openPreviewPresenter(page);
  try {
    await expectRecoveryPresenter(presenter, 1);
    const present = page.frameLocator('iframe[title="present"]');
    const presentReload = page.waitForResponse(response => response.request().isNavigationRequest() && new URL(response.url()).searchParams.get('phase') === 'present');
    await present.locator('body').evaluate(() => { history.replaceState(null, '', '?phase=present' + location.hash); location.reload(); });
    await presentReload;
    await expectRecoveryFrame(present, 1);
    await expect.poll(() => present.locator('body').evaluate(() => location.search)).toBe('?phase=present');
    const currentDocument = await presenter.frameLocator('#current').locator('body').evaluate(() => location.href);
    const currentReload = presenter.waitForResponse(response => response.request().isNavigationRequest() && new URL(response.url()).pathname === new URL(currentDocument).pathname);
    await presenter.frameLocator('#current').locator('body').evaluate(() => location.reload());
    await currentReload;
    await expectRecoveryPresenter(presenter, 1);
  } catch (error) {
    await testInfo.attach('presenter-before-close', { body: JSON.stringify(await previewRecoveryWitness(presenter), null, 2), contentType: 'application/json' });
    throw error;
  } finally { await presenter.close(); }
});

test('[P1] native preview recovery preserves directory routes and saved Manual Edit text across daemon restart and a real reload', async ({ page, toolsDev }, testInfo) => {
  test.setTimeout(T.xlong * 2);
  await routeMockAgents(page);
  await page.clock.install();
  const projectId = await createProjectViaApi(page, 'Native saved edit recovery');
  await seedPreviewRecoveryDeck(page, projectId, "location.replace('#/1');");
  const { scopes, renewalStatuses } = await observePreviewScopeRecovery(page, projectId);
  await page.goto(`/projects/${projectId}`, { waitUntil: 'domcontentloaded' });
  await expectWorkspaceReady(page);
  await openDesignFile(page, 'index.html');
  const preview = page.frameLocator('[data-testid="artifact-preview-frame"]');
  await expectRecoveryFrame(preview, 0);
  const initialScope = scopes.at(-1)!;
  expect(initialScope, 'native edit workflow did not mint a bootstrap capability').toBeTruthy();
  const directoryHref = previewDirectoryHref(initialScope);
  const directoryNavigation = page.waitForResponse(response => response.request().isNavigationRequest()
    && new URL(response.url()).pathname === new URL(directoryHref).pathname);
  await preview.locator('body').evaluate(() => location.replace(new URL('#/details', document.baseURI).href));
  await directoryNavigation;
  await expectRecoveryFrame(preview, 0, directoryHref, '#/details');
  await preview.locator('body').evaluate(() => history.replaceState(null, '', '?phase=directory' + location.hash));
  const directoryLocation = await preview.locator('body').evaluate(() => ({ pathname: location.pathname, search: location.search, hash: location.hash }));
  expect(directoryLocation).toEqual({ pathname: new URL(directoryHref).pathname, search: '?phase=directory', hash: '#/details' });

  await clickPreviewToolbarAction(page, 'manual-edit-mode-toggle', /^Edit$/);
  await expect(page.getByTestId('manual-edit-mode-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(preview.locator('html[data-od-edit-mode]')).toHaveCount(1);
  await preview.getByRole('heading', { name: 'Recovery slide 1', exact: true }).click();
  const textInput = page.locator('.manual-edit-content-inspector textarea');
  await expect(textInput).toBeVisible();
  const savedText = 'Saved native edit text';
  await textInput.fill(savedText);
  const savedResponse = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/projects/${projectId}/files`);
  await page.locator('.manual-edit-modal').getByRole('button', { name: /^Save$/ }).click();
  const saved = await savedResponse;
  expect(saved.ok(), 'Manual Edit did not persist its text patch').toBe(true);
  const savedSource = (saved.request().postDataJSON() as { content: string }).content;
  expect(savedSource).toContain(savedText);
  await expectRecoveryFrame(preview, 0, directoryHref, '#/details', savedText);
  await expect.poll(async () => (await page.request.get(`/api/projects/${projectId}/files/index.html`)).text()).toContain(savedText);
  const savedDocumentId = await preview.locator('body').evaluate(() =>
    (window as unknown as { __odSrcdocTransportDocumentId?: string }).__odSrcdocTransportDocumentId);
  expect(savedDocumentId, 'the saved live editing document has no identity').toBeTruthy();

  await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now()) + T.short));
  try {
    await toolsDev.restartDaemon();
    await warmPlaywrightDaemonRuntime(toolsDev.url.daemon('/api/health'));
    expect((await page.request.get(directoryHref + 'logo.png')).status(), 'restart did not invalidate the old capability').toBe(404);
    await page.clock.fastForward(T.long);
    await expect.poll(() => scopes.at(-1), { timeout: T.long }).not.toBe(initialScope);
    expect(renewalStatuses.at(-1)).toBe(404);
    const replacementBase = previewDirectoryHref(scopes.at(-1)!);
    await expectRecoveryFrame(preview, 0, replacementBase, '#/details', savedText);
    await expect(page.getByTestId('manual-edit-mode-toggle')).toHaveAttribute('aria-pressed', 'true');
    await expect(preview.locator('html[data-od-edit-mode]')).toHaveCount(1);
    const recovered = await preview.locator('body').evaluate(() => ({
      href: location.href, search: location.search, hash: location.hash,
      documentId: (window as unknown as { __odSrcdocTransportDocumentId?: string }).__odSrcdocTransportDocumentId,
    }));
    expect({ search: recovered.search, hash: recovered.hash }, 'directory-entry recovery lost query or hash').toEqual({ search: directoryLocation.search, hash: directoryLocation.hash });
    expect(recovered.documentId).not.toBe(savedDocumentId);
    await expect.poll(async () => (await page.request.get(`/api/projects/${projectId}/files/index.html`)).text()).toContain(savedText);
    const reloadedResponse = page.waitForResponse(response => response.request().isNavigationRequest()
      && new URL(response.url()).pathname === new URL(recovered.href).pathname
      && new URL(response.url()).search === recovered.search);
    await preview.locator('body').evaluate(() => location.reload());
    await reloadedResponse;
    await expectRecoveryFrame(preview, 0, replacementBase, '#/details', savedText);
    await expect(page.getByTestId('manual-edit-mode-toggle')).toHaveAttribute('aria-pressed', 'true');
    await expect(preview.locator('html[data-od-edit-mode]')).toHaveCount(1);
    await expect.poll(() => preview.locator('body').evaluate(() =>
      (window as unknown as { __odSrcdocTransportDocumentId?: string }).__odSrcdocTransportDocumentId)).not.toBe(recovered.documentId);
    await expect.poll(async () => (await page.request.get(`/api/projects/${projectId}/files/index.html`)).text()).toContain(savedText);
    await testInfo.attach('saved-edit-native-recovery', { body: JSON.stringify({ scopes, renewalStatuses, directoryLocation, savedSource, savedDocumentId, recovered }, null, 2), contentType: 'application/json' });
  } finally { await page.clock.resume(); }
});

test('[P1] direct srcdoc reload preserves saved Manual Edit text without remounting the iframe', async ({ page }, testInfo) => {
  await routeMockAgents(page);
  const projectId = await createProjectViaApi(page, 'Direct saved edit reload');
  const beforeText = 'Before direct reload';
  const savedText = 'Saved direct edit text';
  // An authored base disables the native carrier; Edit materializes direct
  // srcdoc. No asset requests or external services participate in this reload.
  await seedHtmlArtifact(page, projectId, 'index.html', `<!doctype html><html><head>
    <base href="/authored-base/"><style>body { padding: 40px; font: 24px sans-serif; }</style>
    </head><body><main><h1>${beforeText}</h1></main></body></html>`);
  await page.goto(`/projects/${projectId}`, { waitUntil: 'domcontentloaded' });
  await expectWorkspaceReady(page);
  await openDesignFile(page, 'index.html');
  const acks: Array<{ documentId: string; generation: string; probeId: string }> = [];
  await page.exposeFunction('recordDirectSrcdocAck', (ack: typeof acks[number]) => { acks.push(ack); });
  await page.evaluate(() => {
    window.addEventListener('message', (event) => {
      const frame = document.querySelector<HTMLIFrameElement>('iframe[data-od-render-mode="srcdoc"][data-od-active="true"]');
      const data = event.data;
      if (event.source !== frame?.contentWindow || data?.type !== 'od:srcdoc-transport-activated'
        || data.bodyComplete !== true || typeof data.documentId !== 'string'
        || typeof data.generation !== 'string' || typeof data.probeId !== 'string') return;
      void (window as unknown as { recordDirectSrcdocAck: (ack: {
        documentId: string; generation: string; probeId: string;
      }) => Promise<void> }).recordDirectSrcdocAck({ documentId: data.documentId, generation: data.generation, probeId: data.probeId });
    });
  });
  await clickPreviewToolbarAction(page, 'manual-edit-mode-toggle', /^Edit$/);
  const iframe = page.locator(ACTIVE_ARTIFACT_PREVIEW_SELECTOR);
  const preview = page.frameLocator(ACTIVE_ARTIFACT_PREVIEW_SELECTOR);
  await expect(iframe).toHaveAttribute('data-od-render-mode', 'srcdoc');
  await expect(iframe).toHaveAttribute('src', 'about:blank');
  await expect(preview.locator('html[data-od-edit-mode]')).toHaveCount(1);
  await expect(preview.getByRole('heading', { name: beforeText, exact: true })).toBeVisible();
  const originalFrame = await iframe.elementHandle();
  if (!originalFrame) throw new Error('Direct srcdoc iframe is missing');
  const originalWindow = await originalFrame.evaluateHandle((element) => (element as HTMLIFrameElement).contentWindow);
  const readDocumentId = () => preview.locator('body').evaluate(() =>
    (window as unknown as { __odSrcdocTransportDocumentId?: string }).__odSrcdocTransportDocumentId);
  await expect.poll(async () => {
    const documentId = await readDocumentId();
    return acks.some((ack) => ack.documentId === documentId);
  }, { timeout: T.medium, message: 'Direct Edit document never completed a real readiness probe' }).toBe(true);

  await preview.getByRole('heading', { name: beforeText, exact: true }).click();
  const textInput = page.locator('.manual-edit-content-inspector textarea');
  await expect(textInput).toBeVisible();
  await textInput.fill(savedText);
  const savedResponse = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/projects/${projectId}/files`);
  await page.locator('.manual-edit-modal').getByRole('button', { name: /^Save$/ }).click();
  expect((await savedResponse).ok(), 'Manual Edit did not persist its text patch').toBe(true);
  await expectProjectFileToContain(page, projectId, 'index.html', savedText);
  await expect(preview.getByRole('heading', { name: savedText, exact: true })).toBeVisible();
  const savedDocumentId = await readDocumentId();
  const savedOwner = acks.filter((ack) => ack.documentId === savedDocumentId).at(-1);
  expect(savedOwner, 'Saved live document has no completed readiness probe').toBeTruthy();
  expect(await iframe.getAttribute('srcdoc'), 'Saved edits should retain the live document until reload').toContain(beforeText);
  const beforeReload = acks.length;

  await preview.locator('body').evaluate(() => location.reload());
  await expect.poll(() => acks.slice(beforeReload).some((ack) => ack.generation === savedOwner!.generation
    && ack.documentId !== savedDocumentId && ack.probeId !== savedOwner!.probeId),
  { timeout: T.medium, message: 'Reloaded direct document did not answer a fresh probe in its existing generation' }).toBe(true);
  await expect(preview.getByRole('heading', { name: savedText, exact: true })).toBeVisible();
  await expect.poll(async () => {
    const documentId = await readDocumentId();
    return acks.slice(beforeReload).some((ack) => ack.documentId === documentId);
  }, { timeout: T.medium, message: 'Saved replacement document never completed its readiness probe' }).toBe(true);
  expect(await readDocumentId()).not.toBe(savedDocumentId);
  expect(await preview.locator('body').evaluate(() => location.href)).toBe('about:srcdoc');
  await expect(iframe).toHaveAttribute('src', 'about:blank');
  await expect(page.getByTestId('manual-edit-mode-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(preview.locator('html[data-od-edit-mode]')).toHaveCount(1);
  // Observe beyond the recovery probe deadline without mutating browser time.
  await expectStableCount(async () => await originalFrame.evaluate((element, previousWindow) =>
    element.isConnected && (element as HTMLIFrameElement).contentWindow === previousWindow, originalWindow) ? 1 : 0,
  1, { timeout: T.short, message: 'Healthy direct reload remounted its iframe during the recovery window' });
  await expect(preview.getByRole('heading', { name: savedText, exact: true })).toBeVisible();
  await expectProjectFileToContain(page, projectId, 'index.html', savedText);
  await testInfo.attach('direct-srcdoc-saved-reload', { body: JSON.stringify({ savedDocumentId, savedOwner, acks }, null, 2), contentType: 'application/json' });
});

async function seedPreviewRecoveryDeck(page: Page, projectId: string, initializer: string, authoredNavigation = true, bodyOnload = false, htmlPrefix = ''): Promise<void> {
  await seedProjectFile(page, projectId, 'logo.png', TINY_PNG_B64, 'base64');
  await seedProjectFile(page, projectId, 'index.html', previewRecoveryDeck(initializer, authoredNavigation, bodyOnload, htmlPrefix), undefined, {
    version: 1, kind: 'deck', title: 'Preview recovery deck', entry: 'index.html', renderer: 'deck-html', exports: ['html'],
  });
}

test('[P0] @critical file workspace restores HTML preview after switching through a source file', async ({ page }) => {
  await routeMockAgents(page);

  await gotoEntryHome(page);
  await openNewProjectModal(page);
  await page.getByTestId('new-project-name').fill('File workspace preview restore');
  await page.getByTestId('create-project').click();
  await expectWorkspaceReady(page);

  const { projectId } = await getCurrentProjectContext(page);
  await seedHtmlArtifact(
    page,
    projectId,
    'dashboard.html',
    '<!doctype html><html><body><main><h1>Risk Dashboard</h1><p>Preview survives file switches.</p></main></body></html>',
  );
  await seedProjectFile(page, projectId, 'logic.ts', 'export const riskScore = 17.3;\n');
  await page.reload();
  await expectWorkspaceReady(page);

  await openDesignFile(page, 'dashboard.html');
  await expect(page.getByRole('tab', { name: /dashboard\.html/i })).toHaveAttribute('aria-selected', 'true');
  await expect(page.frameLocator('[data-testid="artifact-preview-frame"]').getByRole('heading', {
    name: 'Risk Dashboard',
  })).toBeVisible();

  await openAllProjectFiles(page);
  const sourceRow = await revealDesignFileRow(page, 'logic.ts');
  // #5517: one click on the row opens the file — no preview card in between.
  await sourceRow.getByRole('button').first().click();
  await expect(page.getByRole('tab', { name: /logic\.ts/i })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.code-viewer')).toContainText('riskScore');

  await page.getByRole('tab', { name: /dashboard\.html/i }).click();
  await expect(page.getByRole('tab', { name: /dashboard\.html/i })).toHaveAttribute('aria-selected', 'true');
  await expect(page.frameLocator('[data-testid="artifact-preview-frame"]').getByRole('heading', {
    name: 'Risk Dashboard',
  })).toBeVisible();
  await expect(page.getByTestId('file-workspace')).toBeVisible();
});

test('[P0] @critical white-screen monitoring recovers layout stalls and confirms persistent blanks', async ({ page }) => {
  const safetyEvents = await captureSafetyTelemetry(page);
  await routeMockAgents(page);

  const projectId = await createProjectViaApi(page, 'Preview white-screen monitoring');
  await seedHtmlArtifact(
    page,
    projectId,
    'recoverable-blank.html',
    `<!doctype html>
      <html>
        <head><style>main { display: none; }</style></head>
        <body data-monitor-fixture="recoverable" data-monitor-recovered="false">
          <main><h1>Recovered preview paint</h1></main>
          <script>
            window.__monitorFixtureStartedAt = performance.now();
            window.addEventListener('resize', function () {
              if (performance.now() - window.__monitorFixtureStartedAt < 4500) return;
              document.querySelector('main').style.display = 'block';
              document.body.dataset.monitorRecovered = 'true';
            });
          </script>
        </body>
      </html>`,
  );
  await seedHtmlArtifact(
    page,
    projectId,
    'persistent-blank.html',
    `<!doctype html>
      <html>
        <body data-monitor-fixture="persistent">
          <script>window.__monitorFixtureReady = true;</script>
        </body>
      </html>`,
  );

  await page.goto(`/projects/${projectId}?forceInline=1`, { waitUntil: 'domcontentloaded' });
  await expectWorkspaceReady(page);
  await openDesignFile(page, 'recoverable-blank.html');

  const activePreview = page.frameLocator('[data-testid="artifact-preview-frame"]');
  const recoverableBody = activePreview.locator('body[data-monitor-fixture="recoverable"]');
  const recoverableMain = recoverableBody.locator('main');
  await expect(recoverableBody).toBeVisible();
  await expect(recoverableBody).toHaveAttribute('data-monitor-recovered', 'true', {
    timeout: PREVIEW_WHITE_SCREEN_TIMEOUT_MS + T.short,
  });
  await expect(recoverableMain).toHaveCSS('display', 'block', {
    timeout: PREVIEW_WHITE_SCREEN_TIMEOUT_MS + T.short,
  });
  await page.waitForTimeout(PREVIEW_WHITE_SCREEN_CONFIRMATION_MS + 100);
  expect(capturedWhiteScreenEvents(safetyEvents)).toEqual([]);

  await openAllProjectFiles(page);
  const persistentRow = await revealDesignFileRow(page, 'persistent-blank.html');
  await persistentRow.getByRole('button').first().click();
  await expect(page.getByRole('tab', { name: /persistent-blank\.html/i }))
    .toHaveAttribute('aria-selected', 'true');
  const persistentBody = activePreview.locator('body[data-monitor-fixture="persistent"]');
  await expect(persistentBody).toBeAttached();

  await page.waitForTimeout(PREVIEW_WHITE_SCREEN_TIMEOUT_MS - 500);
  expect(capturedWhiteScreenEvents(safetyEvents)).toEqual([]);

  await expect.poll(
    () => capturedWhiteScreenEvents(safetyEvents).length,
    { timeout: PREVIEW_WHITE_SCREEN_CONFIRMATION_MS + T.short },
  ).toBe(1);
  const [whiteScreen] = capturedWhiteScreenEvents(safetyEvents);
  expect(whiteScreen?.properties).toMatchObject({
    blank_observation_count: 2,
    sample_interval_ms: PREVIEW_WHITE_SCREEN_CONFIRMATION_MS,
    visible_element_count: 0,
    visibility_state: 'visible',
  });
});

test('[P0] @critical HTML file list and previews stay stable across repeated switches', async ({ page }) => {
  await routeMockAgents(page);

  const projectId = await createProjectViaApi(page, 'Uploaded file switching stability');
  const seededHtml = new Map([
    ['stable-alpha.html', '<!doctype html><html><body><main><h1>Stable Alpha</h1></main></body></html>'],
    ['stable-beta.html', '<!doctype html><html><body><main><h1>Stable Beta</h1></main></body></html>'],
  ]);
  const seededFiles = [...seededHtml.keys()].map((name, index) => ({
    name,
    size: Buffer.byteLength(seededHtml.get(name) ?? ''),
    mtime: 1_785_570_000_000 + index,
    kind: 'html',
    mime: 'text/html',
  }));
  await page.route(`**/api/projects/${projectId}/files`, async (route) => {
    await route.fulfill({ json: { files: seededFiles } });
  });
  await page.route(`**/api/projects/${projectId}/text-preview/*`, async (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1) ?? '');
    const text = seededHtml.get(name) ?? '';
    await route.fulfill({
      json: {
        text,
        truncated: false,
        size: Buffer.byteLength(text),
        limit: 131_072,
        mime: 'text/html',
        kind: 'html',
        poweredPreview: { required: false, scannedBytes: Buffer.byteLength(text), complete: true },
      },
    });
  });
  await page.route(`**/api/projects/${projectId}/raw/*`, async (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1) ?? '');
    await route.fulfill({ contentType: 'text/html', body: seededHtml.get(name) ?? '' });
  });
  let warmReadEpoch = 0;
  const warmReadUrls: string[] = [];
  const recordWarmProjectRead = (request: Request) => {
    if (request.method() !== 'GET') return;
    const pathname = new URL(request.url()).pathname;
    const projectPrefix = `/api/projects/${encodeURIComponent(projectId)}/`;
    if (pathname === `${projectPrefix}files` || pathname.startsWith(`${projectPrefix}raw/`)) {
      warmReadEpoch += 1;
      warmReadUrls.push(request.url());
    }
  };
  page.on('request', recordWarmProjectRead);
  await page.goto(`/projects/${projectId}`, { waitUntil: 'domcontentloaded' });
  await expectWorkspaceReady(page);

  // Project restore asynchronously opens the newest HTML file. If Design
  // Files is clicked while that restore is still committing, the late file
  // selection wins and immediately switches the tab back, making the list
  // assertion race startup instead of testing file stability. Let the restore
  // own its initial selection, then enter Design Files as the user would.
  await expect(page.getByRole('tab', { name: /stable-(?:alpha|beta)\.html/i })).toBeVisible();
  await expect(page.locator('iframe[data-od-active="true"]')).toBeVisible();

  await openAllProjectFiles(page);
  const alphaRow = await revealDesignFileRow(page, 'stable-alpha.html');
  const betaRow = designFileRow(page, 'stable-beta.html');
  await expectVisibleAcrossAnimationFrames(alphaRow);
  await expectVisibleAcrossAnimationFrames(betaRow);
  await alphaRow.getByRole('button').first().click();

  const alphaTab = page.getByRole('tab', { name: /stable-alpha\.html/i });
  const alphaHeading = page.frameLocator('[data-testid="artifact-preview-frame"]').getByRole('heading', {
    name: 'Stable Alpha',
  });
  type WarmFrame = HTMLIFrameElement & { __odWarmLoadCount?: number };
  const captureWarmFrame = async (fileName: string) => {
    const activeFrame = page.locator(`iframe[title="${fileName}"][data-od-active="true"]`);
    await expect(activeFrame).toHaveCount(1);
    const handle = await activeFrame.elementHandle();
    if (!handle) throw new Error(`Missing active preview frame for ${fileName}`);
    await handle.evaluate((node) => {
      const frame = node as WarmFrame;
      frame.__odWarmLoadCount = 0;
      frame.addEventListener('load', () => {
        frame.__odWarmLoadCount = (frame.__odWarmLoadCount ?? 0) + 1;
      });
    });
    return handle;
  };
  const expectWarmFrameUnchanged = async (
    fileName: string,
    handle: Awaited<ReturnType<typeof captureWarmFrame>>,
    active: boolean,
  ) => {
    expect(await handle.evaluate((node) => node.isConnected), `${fileName} iframe was detached`).toBe(true);
    if (active) {
      const activeFrame = page.locator(`iframe[title="${fileName}"][data-od-active="true"]`);
      expect(
        await activeFrame.evaluate((node, original) => node === original, handle),
        `${fileName} iframe was remounted`,
      ).toBe(true);
    }
    expect(
      await handle.evaluate((node) => (node as WarmFrame).__odWarmLoadCount ?? 0),
      `${fileName} iframe navigated again`,
    ).toBe(0);
  };
  await expect(alphaTab).toHaveAttribute('aria-selected', 'true');
  await expect(alphaHeading).toBeVisible();
  const alphaFrameHandle = await captureWarmFrame('stable-alpha.html');

  await openAllProjectFiles(page);
  // #7007 regressed only when the active viewer had already cached the HTML
  // source and Design Files mounted its thumbnail from that cache on the very
  // first render. Exercise that exact browser path, not just the jsdom style
  // contract: the thumbnail must start with the desktop layout viewport and
  // immediately paint the cached document.
  const warmAlphaRow = await revealDesignFileRow(page, 'stable-alpha.html');
  const warmAlphaThumbnail = warmAlphaRow.locator('.df-card-thumb iframe');
  await expect(warmAlphaThumbnail).toHaveCSS('width', '1200px');
  await expect(warmAlphaThumbnail).toHaveCSS('height', '675px');
  await expect(warmAlphaRow.frameLocator('.df-card-thumb iframe').getByRole('heading', {
    name: 'Stable Alpha',
  })).toBeVisible();
  await betaRow.getByRole('button').first().click();
  const betaTab = page.getByRole('tab', { name: /stable-beta\.html/i });
  const betaHeading = page.frameLocator('[data-testid="artifact-preview-frame"]').getByRole('heading', {
    name: 'Stable Beta',
  });
  await expect(betaTab).toHaveAttribute('aria-selected', 'true');
  await expect(betaHeading).toBeVisible();
  const betaFrameHandle = await captureWarmFrame('stable-beta.html');
  await expectWarmFrameUnchanged('stable-alpha.html', alphaFrameHandle, false);

  // Warm both mounted previews before observing the repeated-switch path. A
  // first render may legitimately load; once warm, switching must not put the
  // workspace back into loading or an empty viewer.
  await alphaTab.click();
  await expect(alphaHeading).toBeVisible();
  await expectWarmFrameUnchanged('stable-alpha.html', alphaFrameHandle, true);
  await expectWarmFrameUnchanged('stable-beta.html', betaFrameHandle, false);
  await betaTab.click();
  await expect(betaHeading).toBeVisible();
  await expectWarmFrameUnchanged('stable-alpha.html', alphaFrameHandle, false);
  await expectWarmFrameUnchanged('stable-beta.html', betaFrameHandle, true);
  await waitForObservedActivityQuiescence(
    page,
    () => warmReadEpoch,
    () => warmReadUrls,
    'Warm project file reads',
  );
  page.off('request', recordWarmProjectRead);

  let rawFileReads = 0;
  const rawFileReadUrls: string[] = [];
  let fileListReads = 0;
  const fileListReadUrls: string[] = [];
  let measurementStep = 'idle';
  page.on('request', (request) => {
    if (request.method() !== 'GET') return;
    const pathname = new URL(request.url()).pathname;
    const projectPrefix = `/api/projects/${encodeURIComponent(projectId)}/`;
    if (pathname.startsWith(`${projectPrefix}raw/`)) {
      rawFileReads += 1;
      rawFileReadUrls.push(`${measurementStep}: ${request.url()}`);
    }
    if (pathname === `${projectPrefix}files`) {
      fileListReads += 1;
      fileListReadUrls.push(`${measurementStep}: ${request.url()}`);
    }
  });

  await page.evaluate(() => {
    const state = { loadingSeen: false };
    const isVisible = (element: Element) => {
      const htmlElement = element as HTMLElement;
      const style = window.getComputedStyle(htmlElement);
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity) > 0 &&
        htmlElement.getClientRects().length > 0
      );
    };
    const observeLoading = () => {
      state.loadingSeen ||= Array.from(
        document.querySelectorAll('.viewer-loading, [data-testid="design-files-reloading"]'),
      ).some(isVisible);
    };
    observeLoading();
    const observer = new MutationObserver(observeLoading);
    observer.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    (window as typeof window & { __odFileSwitchStability?: typeof state }).__odFileSwitchStability = state;
  });

  for (let round = 0; round < 3; round += 1) {
    measurementStep = `round-${round}-design-files`;
    await openAllProjectFiles(page);
    const alphaRow = await revealDesignFileRow(page, 'stable-alpha.html');
    const betaRow = designFileRow(page, 'stable-beta.html');
    await expectVisibleAcrossAnimationFrames(alphaRow);
    await expectVisibleAcrossAnimationFrames(betaRow);
    await expectVisibleAcrossAnimationFrames(alphaTab);
    await expectVisibleAcrossAnimationFrames(betaTab);

    measurementStep = `round-${round}-alpha`;
    await alphaRow.getByRole('button').first().click();
    await expect(alphaTab).toHaveAttribute('aria-selected', 'true');
    await expect(alphaHeading).toBeVisible();
    await expectVisibleAcrossAnimationFrames(page.getByTestId('artifact-preview-frame'));
    await expectVisibleAcrossAnimationFrames(betaTab);
    await expectWarmFrameUnchanged('stable-alpha.html', alphaFrameHandle, true);
    await expectWarmFrameUnchanged('stable-beta.html', betaFrameHandle, false);

    measurementStep = `round-${round}-beta`;
    await betaTab.click();
    await expect(betaTab).toHaveAttribute('aria-selected', 'true');
    await expect(betaHeading).toBeVisible();
    await expectVisibleAcrossAnimationFrames(page.getByTestId('artifact-preview-frame'));
    await expectVisibleAcrossAnimationFrames(alphaTab);
    await expectWarmFrameUnchanged('stable-alpha.html', alphaFrameHandle, false);
    await expectWarmFrameUnchanged('stable-beta.html', betaFrameHandle, true);
  }

  const loadingSeen = await page.evaluate(() => (
    window as typeof window & { __odFileSwitchStability?: { loadingSeen: boolean } }
  ).__odFileSwitchStability?.loadingSeen ?? false);
  expect(loadingSeen, 'a warm file list or preview returned to a loading state').toBe(false);
  // Both previews are warm before measurement. Switching among already-open
  // tabs must keep their iframe documents connected and never reload raw HTML.
  expect(rawFileReads, `warm preview switching reloaded raw HTML: ${rawFileReadUrls.join(', ')}`).toBe(0);
  // The warmed Design Files snapshot also stays resident; reopening the tab
  // must not refetch the file list on every switch.
  expect(fileListReads, `warm switching refetched the project file list: ${fileListReadUrls.join(', ')}`).toBe(0);
  await expectWarmFrameUnchanged('stable-alpha.html', alphaFrameHandle, false);
  await expectWarmFrameUnchanged('stable-beta.html', betaFrameHandle, true);
});

async function runDesignFilesTabPersistenceFlow(page: Page) {
  const { projectId } = await getCurrentProjectContext(page);
  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5W6McAAAAASUVORK5CYII=',
    'base64',
  );

  await page.getByTestId('design-files-upload-input').setInputFiles({
    name: 'first-tab.png',
    mimeType: 'image/png',
    buffer: pngBytes,
  });
  await expect(page.getByRole('tab', { name: /first-tab\.png/i })).toBeVisible();

  await page.getByTestId('design-files-upload-input').setInputFiles({
    name: 'second-tab.png',
    mimeType: 'image/png',
    buffer: pngBytes,
  });
  const firstTab = page.getByRole('tab', { name: /first-tab\.png/i });
  const secondTab = page.getByRole('tab', { name: /second-tab\.png/i });
  await expect(firstTab).toBeVisible();
  await expect(secondTab).toBeVisible();

  await firstTab.click();
  await expect(firstTab).toHaveAttribute('aria-selected', 'true');
  await expect(secondTab).toHaveAttribute('aria-selected', 'false');

  await page.reload();

  const restoredFirstTab = page.getByRole('tab', { name: /first-tab\.png/i });
  await expect(restoredFirstTab).toBeVisible();
  await expect(restoredFirstTab).toHaveAttribute('aria-selected', 'true');

  const restoredSecondTab = page.getByRole('tab', { name: /second-tab\.png/i });
  const secondTabAlreadyRestored = await restoredSecondTab
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (secondTabAlreadyRestored) {
    await restoredSecondTab.click();
  } else {
    // Depending on restoration timing, inactive files can either be restored as
    // tabs already or remain available from the Design Files list.
    await openAllProjectFiles(page);
    const secondFileRow = designFileRow(page, 'second-tab.png');
    await expect(secondFileRow).toBeVisible();
    // #5517: one click on the row opens the file — no preview card in between.
    await secondFileRow.getByRole('button').first().click();
  }

  await expect(restoredSecondTab).toBeVisible();
  await expect(restoredSecondTab).toHaveAttribute('aria-selected', 'true');
  await expect(restoredFirstTab).toHaveAttribute('aria-selected', 'false');
  await expectProjectFilesToIncludeSuffixes(page, projectId, ['first-tab.png', 'second-tab.png']);
}

function homeDesignCard(page: Page, name: string): Locator {
  return page.locator('.design-card', {
    has: page.locator('.design-card-name', { hasText: name }),
  });
}

function designFileScenarioPriority(entry: UiScenario): 'P0' | 'P1' {
  switch (entry.flow) {
    case 'design-files-upload':
    case 'design-files-delete':
    case 'design-files-tab-persistence':
      return 'P0';
    case 'uploaded-image-renders-in-preview':
    case 'python-source-preview':
    default:
      return 'P1';
  }
}

function criticalDesignFileScenarioTag(entry: UiScenario): string {
  return CRITICAL_DESIGN_FILE_SCENARIO_IDS.has(entry.id) ? ' @critical' : '';
}


for (const hashNavigation of [false, true]) {
  test(`[P1] edit bridge survives ${hashNavigation ? 'hash initialization' : 'ordinary HTML control'}`, async ({ page }, testInfo) => {
    await routeMockAgents(page);
    const projectId = await createProjectViaApi(page, 'Review preview edit');
    await seedHtmlArtifact(page, projectId, 'index.html', `<!doctype html><html><head></head><body>
      <h1 data-od-id="hero">Review editable hero</h1>
      <script>${hashNavigation ? "if (!location.hash) location.replace('#/home');" : ''}</script>
      </body></html>`);
    await page.goto(`/projects/${projectId}`, { waitUntil: 'domcontentloaded' });
    await expectWorkspaceReady(page);
    await openDesignFile(page, 'index.html');
    const frame = page.frameLocator(ACTIVE_ARTIFACT_PREVIEW_SELECTOR);
    await expect(frame.getByRole('heading', { name: 'Review editable hero' })).toBeVisible();
    await clickPreviewToolbarAction(page, 'manual-edit-mode-toggle', /^Edit$/);
    await expect(page.getByTestId('manual-edit-mode-toggle')).toHaveAttribute('aria-pressed', 'true');
    try {
      await expect(frame.locator('html[data-od-edit-mode]')).toHaveCount(1);
      await frame.locator('[data-od-id="hero"]').click();
      await expect(frame.locator('[data-od-id="hero"]')).toHaveAttribute('data-od-edit-selected', 'true');
      const fontSize = page.locator('.manual-edit-modal .cc-section').filter({ hasText: 'Parameters' })
        .locator('.cc-row').filter({ hasText: 'Font size' }).locator('input');
      await fontSize.fill('48');
      await expect(frame.locator('[data-od-id="hero"]')).toHaveCSS('font-size', '48px');
      await page.locator('.manual-edit-modal').getByRole('button', { name: /^Save$/ }).click();
      await expect.poll(async () => (await page.request.get(`/api/projects/${projectId}/raw/index.html`)).text()).toContain('font-size: 48px');
      await expect(page.locator('.manual-edit-error')).toHaveCount(0);
      await clickPreviewToolbarAction(page, 'manual-edit-mode-toggle', /^Edit$/);
      await expect(frame.getByRole('heading', { name: 'Review editable hero' })).toBeVisible();
      await clickPreviewToolbarAction(page, 'manual-edit-mode-toggle', /^Edit$/);
      await expect(frame.locator('html[data-od-edit-mode]')).toHaveCount(1);


    } finally {
      const state = await page.frameLocator('[data-od-render-mode=srcdoc]').locator('html').evaluate((el) => ({
        url: location.href,
        editMode: el.getAttribute('data-od-edit-mode'),
        scripts: Array.from(document.scripts).map(s => Array.from(s.attributes).map(a => a.name)),
      }));
      await testInfo.attach('review-state', { body: JSON.stringify(state, null, 2), contentType: 'application/json' });
    }
  });
}

for (const hashNavigation of [false, true]) {
  test(`[P1] remote resources survive ${hashNavigation ? 'hash initialization' : 'ordinary HTML control'}`, async ({ page }, testInfo) => {
    await routeMockAgents(page);
    const errors: string[] = [];
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('https://preview-cdn.invalid/boot.js', route => route.fulfill({
      contentType: 'application/javascript', body: "document.querySelector('h1').textContent = 'CDN app mounted';",
    }));
    const projectId = await createProjectViaApi(page, 'Review CDN preview');
    await seedHtmlArtifact(page, projectId, 'index.html', `<!doctype html><html><head></head><body>
      <h1>CDN app waiting</h1>
      <script>${hashNavigation ? "if (!location.hash) location.replace('#/home');" : ''}</script>
      <script src="https://preview-cdn.invalid/boot.js"></script>
      </body></html>`);
    await page.goto(`/projects/${projectId}`, { waitUntil: 'domcontentloaded' });
    await expectWorkspaceReady(page);
    await openDesignFile(page, 'index.html');
    const frame = page.frameLocator(ACTIVE_ARTIFACT_PREVIEW_SELECTOR);
    if (hashNavigation) await expect.poll(() => frame.locator('body').evaluate(() => location.hash)).toBe('#/home');
    try {
      await expect(frame.getByRole('heading', { name: 'CDN app mounted' })).toBeVisible();
    } finally {
      const state = await frame.locator('body').evaluate(() => ({ url: location.href, text: document.querySelector('h1')?.textContent }));
      const evidence = { ...state, errors };
      await testInfo.attach('cdn-state', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
    }
  });
}
