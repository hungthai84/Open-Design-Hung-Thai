import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';

const cliEntry = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const exec = promisify(execFile);
let cwd: string;

beforeEach(async () => { cwd = await mkdtemp(path.join(tmpdir(), 'od-stock-cli-')); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

it('writes a Pexels 429 to stderr and preserves it in a successful fallback JSON result', async () => {
  // Preload replaces all network I/O in the real CLI process, including CDN bytes.
  const mockNetwork = 'data:text/javascript,' + encodeURIComponent(`
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.startsWith('https://api.pexels.com/')) return new Response('{}', {
        status: 429, headers: { 'retry-after': '60' },
      });
      if (url.startsWith('https://pixabay.com/api/')) return Response.json({ hits: [{
        tags: 'mapo tofu', pageURL: 'https://pixabay.com/photos/tofu/',
        webformatURL: 'https://cdn.pixabay.com/photo/tofu.jpg',
      }] });
      if (url === 'https://cdn.pixabay.com/photo/tofu.jpg') return new Response(new Uint8Array([
        255,216,255,192,0,17,8,3,32,4,176,3,1,34,0,
      ]));
      throw new Error('Unexpected network request');
    };
  `);
  const result = await exec(process.execPath, [
    '--import', import.meta.resolve('tsx'), '--import', mockNetwork, cliEntry,
    'media', 'stock-search', '--slots', JSON.stringify([{ id: 'tofu', query: 'mapo tofu' }]),
  ], {
    cwd,
    timeout: 10_000,
    env: {
      ...process.env, NODE_OPTIONS: '', OD_DATA_DIR: cwd,
      PEXELS_API_KEY: 'pexels-test-key', PIXABAY_API_KEY: 'pixabay-test-key',
      OPEN_DESIGN_VELA_TELEMETRY: 'off',
    },
  });
  expect(result.stdout.trim().split('\n')).toHaveLength(1);
  const report = JSON.parse(result.stdout);
  expect(report.slots[0]).toMatchObject({ status: 'ok', provider: 'pixabay' });
  expect(report.slots[0].attempts[0]).toMatchObject({ provider: 'pexels', httpStatus: 429, error: 'HTTP 429' });
  const events = result.stderr.trim().split('\n').map((line) => {
    expect(line).toMatch(/^\[stock-search\] /);
    return JSON.parse(line.slice('[stock-search] '.length));
  });
  expect(events[0]).toMatchObject({
    slotId: 'tofu', provider: 'pexels', stage: 'search', httpStatus: 429,
    rateLimited: true, error: 'HTTP 429', retryAfter: '60',
  });
  expect(events[1]).toMatchObject({ slotId: 'tofu', provider: 'pixabay', stage: 'search', status: 'ok' });
  expect(result.stdout + result.stderr).not.toContain('pexels-test-key');
  expect(result.stdout + result.stderr).not.toContain('pixabay-test-key');
});
