import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@/playwright/suite';
import { T } from '@/timeouts';

test.use({ launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } });

test('[P1] editable paper-story source remains listed and playable when video export fails', async ({ page }, testInfo) => {
  const config = await page.request.put('/api/app-config', { data: {
    onboardingCompleted: true, agentId: 'mock', agentModels: {}, agentCliEnv: {},
    skillId: null, designSystemId: null, odNextStrategyMode: 'off',
  } });
  expect(config.ok()).toBe(true);
  const id = randomUUID();
  const created = await page.request.post('/api/projects', { data: {
    id, name: `Motion source recovery ${id}`, metadata: { kind: 'video', intent: 'motion-design' },
  } });
  expect(created.ok(), await created.text()).toBe(true);
  const { conversationId } = await created.json() as { conversationId: string };
  const compositionDir = 'motion-source/paper-story';
  const scaffold = await page.request.post(`/api/projects/${id}/media/hyperframes/scaffold`, { data: { compositionDir } });
  expect(scaffold.ok(), await scaffold.text()).toBe(true);
  const reference = new URL('../../plugins/_official/examples/motion-visual-lesson/', import.meta.url);
  const html = (await readFile(new URL('example.html', reference), 'utf8'))
    .replace('</head>', '<link rel="alternate" type="video/mp4" href="../../paper-story.mp4"></head>');
  const files = ['assets/gsap.min.js', 'assets/short-stack-regular.ttf', 'assets/short-stack-OFL.txt', 'assets/soundtrack.mp3'];
  for (const name of ['index.html', ...files]) {
    const content = name === 'index.html' ? Buffer.from(html) : await readFile(new URL(name, reference));
    const written = await page.request.post(`/api/projects/${id}/files`, { data: {
      name: `${compositionDir}/${name}`, content: content.toString('base64'), encoding: 'base64',
    } });
    expect(written.ok(), await written.text()).toBe(true);
  }
  const sourcePath = `${compositionDir}/index.html`;
  const listed = async () => {
    const response = await page.request.get(`/api/projects/${id}/files`);
    expect(response.ok()).toBe(true);
    const body = await response.json() as { files: { path: string }[] };
    return body.files.map(file => file.path);
  };
  expect(await listed()).toContain(sourcePath);
  await page.addInitScript(() => localStorage.setItem('open-design:config', JSON.stringify({
    mode: 'daemon', agentId: 'mock', onboardingCompleted: true, apiKey: '', baseUrl: '', model: '',
  })));
  const previewPath = `/projects/${id}/conversations/${conversationId}/files/${sourcePath}`;
  await page.goto(previewPath);
  const source = page.frameLocator(`iframe[src*="/projects/${id}/raw/${sourcePath}"]`).first();
  await expect(source.locator('[data-composition-id]')).toBeVisible({ timeout: T.long });
  await expect.poll(() => source.locator('audio').evaluate((audio: HTMLAudioElement) => !audio.paused && audio.currentTime > 0), { timeout: T.long }).toBe(true);
  const exported = await page.request.post(`/api/projects/${id}/media/generate`, { data: {
    surface: 'video', model: 'hyperframes-html', compositionDir, output: 'paper-story.mp4',
  } });
  expect(exported.status()).toBe(202);
  const { taskId } = await exported.json() as { taskId: string };
  // The suite owns daemon/web only: the real dispatcher reports desktop unavailable.
  await expect.poll(async () => {
    const response = await page.request.post(`/api/media/tasks/${taskId}/wait`, { data: { timeoutMs: 0 } });
    expect(response.ok()).toBe(true);
    return response.json();
  }, { timeout: T.long }).toMatchObject({ status: 'failed', error: { message: expect.stringMatching(/desktop/i) } });
  expect(await listed()).toContain(sourcePath);
  expect(await listed()).not.toContain('paper-story.mp4');
  await page.reload();
  await expect(source.locator('[data-composition-id]')).toBeVisible({ timeout: T.long });
  await expect.poll(() => source.locator('audio').evaluate((audio: HTMLAudioElement) => !audio.paused && audio.currentTime > 0), { timeout: T.long }).toBe(true);
  await expect(source.locator('html')).toHaveAttribute('data-od-preview-ready', 'true', { timeout: T.long });
  await testInfo.attach('source-playing-after-export-failure', { body: await page.screenshot(), contentType: 'image/png' });
  await page.getByTestId('design-files-tab').click();
  await expect(page.frameLocator('.df-card-thumb iframe').first().locator('[data-composition-id]')).toBeVisible({ timeout: T.long });
  await testInfo.attach('source-available-after-export-failure', { body: await page.screenshot(), contentType: 'image/png' });
});
