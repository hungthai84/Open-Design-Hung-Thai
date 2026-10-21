import assert from 'node:assert/strict';
import { createServer, request, type ClientRequest, type ServerResponse } from 'node:http';

/** A fixed own-runtime HTTP transport; never generates billing/SSE payloads. */
export async function startWorkspaceTransport(options: {
  target: string; namespace: string; workspaceId: string; memberId: string;
}) {
  const target = new URL(options.target);
  assert(target.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(target.hostname)
    && target.port && target.pathname === '/' && !target.search && !target.hash
    && !target.username && !target.password, 'Fixed credential-free loopback runtime required');
  assert(/^funding-[0-9]+-[a-f0-9]{8}$/.test(options.namespace));
  assert(options.workspaceId && options.memberId);
  let fault = false;
  const events: Array<{ type: string; at: number; path?: string; scoped?: boolean }> = [];
  const scoped = new Set<{ upstream: ClientRequest; browser: ServerResponse }>();
  const server = createServer((incoming, outgoing) => {
    // This is a reverse proxy to exactly one own web port, never an open proxy.
    if (!incoming.url?.startsWith('/') || incoming.url.startsWith('//')) {
      outgoing.writeHead(400); outgoing.end(); return;
    }
    const url = new URL(incoming.url, target);
    if (url.origin !== target.origin || url.username || url.password) {
      outgoing.writeHead(400); outgoing.end(); return;
    }
    const isScoped = url.pathname === '/api/workspace/events'
      && url.searchParams.get('workspaceId') === options.workspaceId
      && url.searchParams.get('workspaceMemberId') === options.memberId;
    if (fault && isScoped) {
      events.push({ type: 'fault-refused', at: Date.now(), path: url.pathname, scoped: true });
      outgoing.destroy(); return;
    }
    const upstream = request(url, {
      method: incoming.method, headers: { ...incoming.headers, host: target.host },
    }, response => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
      response.on('close', () => {
        if (isScoped) events.push({ type: 'upstream-response-close', at: Date.now(), scoped: true });
      });
    });
    const connection = { upstream, browser: outgoing };
    if (isScoped) {
      scoped.add(connection);
      events.push({ type: 'stream-open', at: Date.now(), path: url.pathname, scoped: true });
    }
    incoming.pipe(upstream);
    upstream.on('error', () => outgoing.destroy());
    outgoing.on('close', () => {
      upstream.destroy(); scoped.delete(connection);
      if (isScoped) events.push({ type: 'browser-response-close', at: Date.now(), scoped: true });
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    events,
    get activeScoped() { return scoped.size; },
    disconnect() {
      assert(!fault && scoped.size > 0, 'An actual same-workspace SSE must already be connected');
      fault = true;
      events.push({ type: 'disconnect', at: Date.now(), scoped: true });
      for (const connection of scoped) {
        connection.upstream.destroy(); connection.browser.destroy();
      }
    },
    restore() {
      assert(fault); fault = false; events.push({ type: 'restore', at: Date.now(), scoped: true });
    },
    async close() {
      for (const connection of scoped) {
        connection.upstream.destroy(); connection.browser.destroy();
      }
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    },
  };
}
