import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StockSearchConfigError, imageSize, stockSearch, subjectScore } from '../src/media/stock-search.js';

// Minimal JPEG: SOI + SOF0 declaring 1200x800.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x20, 0x04, 0xb0, 0x03, 0x01, 0x22, 0x00]);

type Route = (url: string) => { status?: number; json?: unknown; body?: Buffer; headers?: Record<string, string> } | undefined;

function fakeFetch(route: Route, seen: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    const hit = route(url);
    if (!hit) return new Response('not found', { status: 404 });
    if (hit.body) return new Response(new Uint8Array(hit.body), {
      status: hit.status ?? 200,
      ...(hit.headers ? { headers: hit.headers } : {}),
    });
    return new Response(JSON.stringify(hit.json ?? {}), { status: hit.status ?? 200, headers: { 'content-type': 'application/json', ...hit.headers } });
  }) as typeof fetch;
}

const pexelsPhoto = (id: number, alt: string) => ({
  id, alt, url: `https://www.pexels.com/photo/${id}/`, photographer: 'Ann', photographer_url: 'https://www.pexels.com/@ann',
  src: { original: `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg` },
});

describe('od media stock-search', () => {
  let cwd: string;
  beforeEach(async () => { cwd = await mkdtemp(path.join(os.tmpdir(), 'od-stock-')); });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  it('downloads the candidate whose alt names the subject, not a people-led photo that mentions it', async () => {
    const seen: string[] = [];
    const report = await stockSearch({
      cwd,
      env: { PEXELS_API_KEY: 'k' },
      slots: [{ id: 'Frames', query: 'eyeglasses frame', width: 900 }],
      fetch: fakeFetch((url) => {
        if (url.startsWith('https://api.pexels.com/')) return { json: { photos: [
          pexelsPhoto(1, 'Elderly woman reading a book while wearing eyeglasses'),
          pexelsPhoto(2, 'Black eyeglasses frame on a pink background'),
        ] } };
        if (url.startsWith('https://images.pexels.com/photos/2/')) return { body: JPEG };
        return undefined;
      }, seen),
    });
    expect(report.providers).toEqual(['pexels']);
    expect(report.slots[0]).toMatchObject({
      id: 'Frames', status: 'ok', provider: 'pexels', path: 'assets/stock/frames.jpg',
      width: 1200, height: 800, alt: 'Black eyeglasses frame on a pink background',
    });
    expect(seen).toContain('https://images.pexels.com/photos/2/pexels-photo-2.jpeg?auto=compress&cs=tinysrgb&w=900');
    const credits = JSON.parse(await readFile(path.join(cwd, 'assets/stock/credits.json'), 'utf8'));
    expect(credits[0]).toMatchObject({ path: 'assets/stock/frames.jpg', license: expect.stringContaining('Pexels License') });
  });

  it('falls back to Pixabay when Pexels has no matching photo', async () => {
    const report = await stockSearch({
      cwd,
      env: { PEXELS_API_KEY: 'k', PIXABAY_API_KEY: 'p' },
      slots: [{ id: 'tofu', query: 'mapo tofu' }],
      fetch: fakeFetch((url) => {
        if (url.startsWith('https://api.pexels.com/')) return { json: { photos: [pexelsPhoto(3, 'City skyline at night')] } };
        if (url.startsWith('https://pixabay.com/api/')) return { json: { hits: [{
          pageURL: 'https://pixabay.com/photos/mapo-tofu-1/', tags: 'mapo tofu, tofu, food', user: 'bo', user_id: 7,
          webformatURL: 'https://cdn.pixabay.com/photo/a_640.jpg', largeImageURL: 'https://cdn.pixabay.com/photo/a_1280.jpg',
        }] } };
        if (url === 'https://cdn.pixabay.com/photo/a_1280.jpg') return { body: JPEG };
        return undefined;
      }),
    });
    expect(report.slots[0]).toMatchObject({ status: 'ok', provider: 'pixabay', alt: 'mapo tofu, tofu, food' });
  });

  it('reports a missing key as a configuration error instead of searching', async () => {
    await expect(stockSearch({ cwd, env: {}, slots: [{ id: 'a', query: 'x' }] })).rejects.toBeInstanceOf(StockSearchConfigError);
  });

  it('records Pexels monthly quota headers and keeps each slot request separate', async () => {
    let remaining = 23_148;
    const emitted: unknown[] = [];
    const report = await stockSearch({
      cwd,
      env: { PEXELS_API_KEY: 'pexels-test-key' },
      concurrency: 1,
      slots: [{ id: 'a', query: 'noodles' }, { id: 'b', query: 'noodles' }],
      onAttempt: (event) => emitted.push(event),
      fetch: fakeFetch((url) => url.startsWith('https://api.pexels.com/') ? {
        json: { photos: [pexelsPhoto(4, 'Noodles in a bowl')] },
        headers: {
          'x-ratelimit-limit': '25000',
          'x-ratelimit-remaining': String(--remaining),
          'x-ratelimit-reset': '1792832062',
          'authorization': 'must-not-be-logged',
        },
      } : { body: JPEG }),
    });
    expect(report.slots[0]?.attempts?.[0]).toMatchObject({
      provider: 'pexels', stage: 'search', status: 'ok', httpStatus: 200,
      rateLimit: { period: 'month', limit: 25000, remaining: 23147, resetUnix: 1792832062 },
    });
    expect(report.slots[1]?.attempts?.[0]?.rateLimit?.remaining).toBe(23146);
    expect(emitted).toContainEqual(expect.objectContaining({ slotId: 'a', provider: 'pexels', httpStatus: 200 }));
    expect(JSON.stringify(emitted)).not.toContain('must-not-be-logged');
  });

  it('keeps a Pexels 429 without quota headers after a successful Pixabay fallback', async () => {
    const emitted: unknown[] = [];
    const report = await stockSearch({
      cwd,
      env: { PEXELS_API_KEY: 'pexels-test-key', PIXABAY_API_KEY: 'pixabay-test-key' },
      slots: [{ id: 'tofu', query: 'mapo tofu' }],
      onAttempt: (event) => emitted.push(event),
      fetch: fakeFetch((url) => {
        if (url.startsWith('https://api.pexels.com/')) return { status: 429, headers: { 'retry-after': '60' } };
        if (url.startsWith('https://pixabay.com/api/')) return { json: { hits: [{
          pageURL: 'https://pixabay.com/photos/mapo-tofu-1/', tags: 'mapo tofu',
          webformatURL: 'https://cdn.pixabay.com/photo/tofu.jpg',
        }] } };
        return { body: JPEG };
      }),
    });
    expect(report.slots[0]).toMatchObject({ status: 'ok', provider: 'pixabay' });
    expect(report.slots[0]?.attempts?.[0]).toMatchObject({
      provider: 'pexels', stage: 'search', status: 'error', httpStatus: 429,
      rateLimited: true, error: 'HTTP 429', retryAfter: '60',
      rateLimit: { period: 'month', limit: null, remaining: null, resetUnix: null },
    });
    expect(report.slots[0]?.attempts?.[1]).toMatchObject({ provider: 'pixabay', stage: 'search', status: 'ok' });
    expect(emitted[0]).toMatchObject({ slotId: 'tofu', provider: 'pexels', httpStatus: 429, error: 'HTTP 429' });
  });

  it('retains both provider failures and preserves a zero remaining quota', async () => {
    const report = await stockSearch({
      cwd,
      env: { PEXELS_API_KEY: 'pexels-test-key', PIXABAY_API_KEY: 'pixabay-test-key' },
      slots: [{ id: 'a', query: 'noodles' }],
      fetch: fakeFetch((url) => url.startsWith('https://api.pexels.com/') ? {
        status: 429,
        headers: { 'x-ratelimit-limit': '25000', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': 'invalid' },
      } : { status: 503 }),
    });
    expect(report.slots[0]).toMatchObject({ status: 'error', error: 'pixabay: HTTP 503' });
    expect(report.slots[0]?.attempts).toMatchObject([
      { provider: 'pexels', httpStatus: 429, rateLimit: { limit: 25000, remaining: 0, resetUnix: null } },
      { provider: 'pixabay', httpStatus: 503, error: 'HTTP 503' },
    ]);
  });

  it.each([
    ['Wed, 21 Oct 2026 07:28:00 GMT', 'Wed, 21 Oct 2026 07:28:00 GMT'],
    ['-1', undefined],
  ])('records a valid Retry-After date without treating %s as a loose date', async (header, expected) => {
    const report = await stockSearch({
      cwd, env: { PEXELS_API_KEY: 'pexels-test-key' }, slots: [{ id: 'a', query: 'noodles' }],
      fetch: fakeFetch(() => ({ status: 429, headers: { 'retry-after': header! } })),
    });
    expect(report.slots[0]?.attempts?.[0]?.retryAfter).toBe(expected);
  });

  it('keeps successful acquisition when an optional execution-log sink fails', async () => {
    const report = await stockSearch({
      cwd, env: { PEXELS_API_KEY: 'pexels-test-key' }, slots: [{ id: 'a', query: 'noodles' }],
      onAttempt: () => { throw new Error('log sink unavailable'); },
      fetch: fakeFetch((url) => url.startsWith('https://api.pexels.com/')
        ? { json: { photos: [pexelsPhoto(4, 'Noodles in a bowl')] } } : { body: JPEG }),
    });
    expect(report.slots[0]).toMatchObject({ status: 'ok', provider: 'pexels' });
    expect(report.slots[0]?.attempts).toHaveLength(2);
  });

  it('distinguishes a CDN download 429 from the successful search quota', async () => {
    const report = await stockSearch({
      cwd,
      env: { PEXELS_API_KEY: 'pexels-test-key' },
      slots: [{ id: 'a', query: 'noodles' }],
      fetch: fakeFetch((url) => url.startsWith('https://api.pexels.com/')
        ? { json: { photos: [pexelsPhoto(4, 'Noodles in a bowl')] }, headers: { 'x-ratelimit-remaining': '120' } }
        : { status: 429 }),
    });
    expect(report.slots[0]?.attempts).toMatchObject([
      { stage: 'search', status: 'ok', httpStatus: 200, rateLimit: { remaining: 120 } },
      { stage: 'download', status: 'error', httpStatus: 429, rateLimited: true },
    ]);
    expect(report.slots[0]?.attempts?.[1]?.rateLimit).toBeUndefined();
  });

  it('scrubs both injected keys from network errors and diagnostic output', async () => {
    const emitted: unknown[] = [];
    const pexelsKey = 'pexels-secret-without-vendor-prefix';
    const pixabayKey = 'pixabay-secret-without-vendor-prefix';
    const report = await stockSearch({
      cwd,
      env: { PEXELS_API_KEY: pexelsKey, PIXABAY_API_KEY: pixabayKey },
      slots: [{ id: 'a', query: 'noodles' }],
      onAttempt: (event) => emitted.push(event),
      fetch: (async () => { throw new Error(`network failed ${pexelsKey} https://pixabay.com/api/?key=${pixabayKey}`); }) as typeof fetch,
    });
    expect(report.slots[0]?.attempts).toHaveLength(2);
    expect(report.slots[0]?.attempts?.[0]).toMatchObject({ stage: 'search', status: 'error', httpStatus: null });
    const logged = JSON.stringify({ report, emitted });
    expect(logged).not.toContain(pexelsKey);
    expect(logged).not.toContain(pixabayKey);
    expect(logged).toContain('[REDACTED]');
  });

  it('marks slots that start after the budget as budget_exceeded', async () => {
    let clock = 0;
    const report = await stockSearch({
      cwd,
      env: { PEXELS_API_KEY: 'k' },
      budgetMs: 10,
      concurrency: 1,
      now: () => clock,
      slots: [{ id: 'a', query: 'noodles bowl' }, { id: 'b', query: 'noodles soup' }],
      fetch: fakeFetch((url) => {
        clock += 20;
        if (url.startsWith('https://api.pexels.com/')) return { json: { photos: [pexelsPhoto(4, 'Noodles in a bowl')] } };
        return { body: JPEG };
      }),
    });
    expect(report.slots.map((s) => s.status)).toEqual(['ok', 'budget_exceeded']);
  });

  it('ranks by query words matched, then by how early the subject appears in the alt', () => {
    expect(subjectScore('eyeglasses frame', 'Black eyeglasses frame on a table')).toBeGreaterThan(
      subjectScore('eyeglasses frame', 'Woman wearing eyeglasses reading'),
    );
    expect(subjectScore('eyeglasses', 'Black eyeglasses on a pink background')).toBeGreaterThan(
      subjectScore('eyeglasses', 'Elderly woman reading a book while wearing eyeglasses'),
    );
    expect(subjectScore('eyeglasses frame', 'Sunset over the sea')).toBe(0);
    expect(subjectScore('眼镜框', 'Elderly woman wearing glasses')).toBe(1);
    expect(imageSize(JPEG)).toEqual({ width: 1200, height: 800 });
  });
});
