import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { startWorkspaceTransport } from '../../lib/playwright/workspace-transport.ts';

describe('fixed own-workspace transport', () => {
  it('preserves actual bytes and physically closes only the bound SSE before real reconnect', async () => {
    const actualClosed = new Set<string>();
    const upstream = createServer((req, res) => {
      const path = new URL(req.url!, 'http://localhost');
      if (path.pathname === '/api/workspace/events') {
        const id = path.searchParams.get('workspaceId')!;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`event: ready\ndata: ${JSON.stringify({ actual: id })}\n\n`);
        req.on('close', () => actualClosed.add(id));
      } else { res.writeHead(200); req.pipe(res); }
    });
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const addr = upstream.address(); if (!addr || typeof addr === 'string') throw Error('port');
    const proxy = await startWorkspaceTransport({ target: `http://127.0.0.1:${addr.port}`,
      namespace: 'funding-123-aabbccdd', workspaceId: 'own', memberId: 'member' });
    const open = async (id: string) => {
      const req = request(`${proxy.origin}/api/workspace/events?workspaceId=${id}&workspaceMemberId=member`);
      req.on('error', () => undefined); req.end();
      const [res] = await once(req, 'response'); res.on('error', () => undefined);
      const [bytes] = await once(res, 'data'); return { req, res, bytes: String(bytes) };
    };
    try {
      let escapedRequests = 0;
      const foreign = createServer((_req, res) => { escapedRequests++; res.end('foreign'); });
      foreign.listen(0, '127.0.0.1'); await once(foreign, 'listening');
      const foreignAddress = foreign.address();
      if (!foreignAddress || typeof foreignAddress === 'string') throw Error('foreign port');
      try {
        // Raw HTTP path: fetch/URL would normalize the backslash before sending.
        const raw = request(proxy.origin, { path: `/\\127.0.0.1:${foreignAddress.port}/escape` });
        raw.end(); const [rejected] = await once(raw, 'response');
        expect(rejected.statusCode).toBe(400); rejected.resume();
        await once(rejected, 'end'); expect(escapedRequests).toBe(0);
      } finally { foreign.closeAllConnections(); await new Promise<void>(r => foreign.close(() => r())); }
      const own = await open('own'); const other = await open('other');
      expect(own.bytes).toBe('event: ready\ndata: {"actual":"own"}\n\n');
      expect(other.bytes).toBe('event: ready\ndata: {"actual":"other"}\n\n');
      const browserClosed = new Promise<void>(resolve => own.res.once('close', resolve)); proxy.disconnect(); await browserClosed;
      await expect.poll(() => actualClosed.has('own')).toBe(true);
      expect(actualClosed.has('other')).toBe(false);
      proxy.restore(); const recovered = await open('own'); expect(recovered.bytes).toBe(own.bytes);
      const payload = new Uint8Array([0, 1, 254, 255]);
      const response = await fetch(`${proxy.origin}/bytes`, { method: 'POST', body: payload });
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(payload);
      recovered.req.destroy(); other.req.destroy();
      expect(proxy.events.some(e => e.type === 'upstream-response-close')).toBe(true);
    } finally { await proxy.close(); upstream.closeAllConnections(); await new Promise<void>(r => upstream.close(() => r())); }
  });
  it('rejects external, credentialed or ambiguous targets and foreign namespaces', async () => {
    for (const target of ['https://127.0.0.1:123', 'http://example.com:123', 'http://u:p@127.0.0.1:123', 'http://127.0.0.1:123/path']) {
      await expect(startWorkspaceTransport({ target, namespace: 'funding-123-aabbccdd', workspaceId: 'own', memberId: 'member' })).rejects.toThrow();
    }
    await expect(startWorkspaceTransport({ target: 'http://127.0.0.1:123', namespace: 'foreign', workspaceId: 'own', memberId: 'member' })).rejects.toThrow();
  });
});
