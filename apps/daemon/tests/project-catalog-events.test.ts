import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';

// Projects created through any entry point (web UI, `od` CLI, MCP bridge) go
// through POST /api/projects. The web shell only learns about projects it
// created itself, so the daemon must announce every creation on a catalog-wide
// stream or externally created projects stay invisible until a manual reload.
describe('GET /api/project-catalog/events', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const started = (await startServer({ port: 0, returnServer: true })) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  async function readUntil(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    predicate: (text: string) => boolean,
  ): Promise<string> {
    const decoder = new TextDecoder();
    let buffer = '';
    while (!predicate(buffer)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`stream ended early; buffer so far:\n${buffer}`);
      buffer += decoder.decode(value, { stream: true });
    }
    return buffer;
  }

  async function createProject(id: string) {
    const resp = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name: id }),
    });
    expect(resp.status).toBe(200);
  }

  it('announces a project created by another client without leaking its content', async () => {
    const controller = new AbortController();
    const resp = await fetch(`${baseUrl}/api/project-catalog/events`, {
      signal: controller.signal,
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('text/event-stream');
    const reader = resp.body!.getReader();
    try {
      await readUntil(reader, (text) => text.includes('event: ready'));

      await createProject('catalog-events-created');

      const framed = await readUntil(reader, (text) =>
        text.includes('event: project-catalog-changed'),
      );
      expect(framed).toContain('"type":"project-catalog-changed"');
      expect(framed).not.toContain('catalog-events-created');
    } finally {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    }
  });

  it('does not announce a create that the daemon rejected', async () => {
    const controller = new AbortController();
    const resp = await fetch(`${baseUrl}/api/project-catalog/events`, {
      signal: controller.signal,
    });
    const reader = resp.body!.getReader();
    try {
      await readUntil(reader, (text) => text.includes('event: ready'));

      const rejected = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'catalog-events-rejected' }),
      });
      expect(rejected.ok).toBe(false);

      // The next accepted create is the first frame the stream may carry; the
      // rejected one must not have queued a frame ahead of it.
      await createProject('catalog-events-after-rejection');
      const framed = await readUntil(reader, (text) =>
        text.includes('event: project-catalog-changed'),
      );
      expect(framed.match(/event: project-catalog-changed/g)).toHaveLength(1);
    } finally {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    }
  });
});
