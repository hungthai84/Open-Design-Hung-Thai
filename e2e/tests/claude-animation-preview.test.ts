import { readFile, stat } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { InstalledPluginRecord } from '@open-design/contracts';

const previewModule = Object.values(import.meta.glob<{
  inferPluginPreview: (record: InstalledPluginRecord, opts: { preferBaked: boolean }) => unknown;
}>('../../apps/web/src/components/plugins-home/preview.ts', { eager: true }))[0]!;
const facetsModule = Object.values(import.meta.glob<{
  extractCategories: (record: InstalledPluginRecord) => string[];
  extractSubcategories: (record: InstalledPluginRecord, category: string) => string[];
}>('../../apps/web/src/components/plugins-home/facets.ts', { eager: true }))[0]!;

const modelCatalogues = import.meta.glob<{
  MEDIA_PROVIDERS: { id: string; label: string; hint: string }[];
  VIDEO_MODELS: { id: string; label: string; hint: string; provider: string }[];
}>('../../apps/{daemon,web}/src/media/models.ts', { eager: true });

it.each(Object.entries(modelCatalogues))('keeps the public animation name and compatible IDs in %s', async (_path, catalogue) => {
  const manifest = JSON.parse(await readFile(new URL('../../plugins/_official/examples/claude-animation/open-design.json', import.meta.url), 'utf8'));
  expect(manifest.title).toBe('Hand-painted character animation');
  expect(catalogue.MEDIA_PROVIDERS.find(({ id }) => id === 'claude-animation')).toMatchObject({
    label: manifest.title,
    hint: 'Local hand-painted character animation · 5s · 16:9 · silent',
  });
  expect(catalogue.VIDEO_MODELS.find(({ id }) => id === 'claude-animation-p5')).toMatchObject({
    label: manifest.title,
    hint: 'Local hand-painted character animation · 5s · 16:9 · silent',
    provider: 'claude-animation',
  });
});

it('shows the bundled hand-painted animation sample in Home and the Community video category without a CDN bake', async () => {
  const root = fileURLToPath(new URL('../../plugins/_official/examples/claude-animation/', import.meta.url));
  const manifest = JSON.parse(await readFile(path.join(root, 'open-design.json'), 'utf8'));
  const record = { id: manifest.name, title: manifest.title, manifest } as InstalledPluginRecord;
  const preview = previewModule.inferPluginPreview(record, { preferBaked: true });
  expect(preview).toMatchObject({
    kind: 'media',
    mediaType: 'video',
    poster: '/api/plugins/example-claude-animation/asset/assets/poster.jpg',
    videoUrl: '/api/plugins/example-claude-animation/asset/assets/example.mp4',
  });
  expect(facetsModule.extractCategories(record)).toEqual(['video']);
  expect(facetsModule.extractSubcategories(record, 'video')).toEqual(['motion-effects']);
  for (const asset of [manifest.od.preview.poster, manifest.od.preview.video]) {
    expect((await stat(path.join(root, asset))).size).toBeGreaterThan(0);
  }
});

it('ships the independent character recipe and separate p5 license/source notices', async () => {
  const root = fileURLToPath(new URL('../../design-templates/claude-animation/', import.meta.url));
  const starter = await readFile(path.join(root, 'assets/template.html'), 'utf8');
  expect(starter).toContain('function bird(t)');
  expect(starter).not.toMatch(/clawd\(|Clawd/);
  await expect(stat(path.join(root, 'assets/runtime/clawd.js'))).rejects.toThrow();
  await expect(stat(path.join(root, 'references/emotions.jpg'))).rejects.toThrow();
  await expect(stat(path.join(root, 'references/views.jpg'))).rejects.toThrow();
  expect(await readFile(path.join(root, 'LICENSE'), 'utf8')).toContain('Copyright (c) 2026 John Heibel');
  expect(await readFile(path.join(root, 'licenses/p5-LGPL-2.1.txt'), 'utf8')).toContain('Version 2.1, February 1999');
  expect(await readFile(path.join(root, 'licenses/p5.brush-MIT.txt'), 'utf8')).toContain('Alejandro Campos Uribe');
  const source = await readFile(path.join(root, 'licenses/p5-2.3.3-source.tar.gz'));
  expect(createHash('sha256').update(source).digest('hex'))
    .toBe('82ce89f35c4a4155ac9c3c7ec43d399e9a63ba905314abbb7a699e27e23ebd61');
  const archive = gunzipSync(source).toString('utf8');
  expect(archive).toContain('p5.js-2.3.3/src/');
  expect(archive).toContain('rollup.config.mjs');
  expect(archive).toContain('package-lock.json');
});
