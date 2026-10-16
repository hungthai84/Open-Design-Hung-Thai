// @vitest-environment jsdom
//
// Regression: the srcDoc preview base is a SHORT-LIVED capability, but the
// viewer treats it as permanent.
//
// `GET /api/projects/:id/preview-url` mints an in-memory preview scope that
// expires after PROJECT_PREVIEW_SCOPE_TTL_MS (1 hour) and dies outright when
// the daemon restarts. FileViewer injects the minted directory as the srcdoc
// `<base href>`, so EVERY relative asset in the artifact (`./assets/qr.png`,
// component chunks, media) resolves through that scope.
//
// The mint is cached under `srcDocPreviewBaseIdentity`, which is only
// `authorizationScopeKey + projectId + fileName` — no time component — and the
// minting effect early-returns while a cached base exists. So once the scope
// expires the viewer keeps stamping the dead base into every subsequent
// srcdoc rebuild, and the preview comes back with its images and components
// broken while the HTML body itself renders fine.
//
// The user-visible shape: leave a preview open past the TTL (or restart the
// app), let the agent write a new revision, and every relative-path image
// 404s while inline `data:` images still render.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildWorkspacePermissions,
  buildWorkspaceSeatSummary,
  type WorkspaceCollabContext,
} from '@open-design/contracts';
import {
  CollabProvider,
  type CollabContextValue,
} from '../../src/collab/collab-context';
import { FileViewer } from '../../src/components/FileViewer';
import type { ProjectFile } from '../../src/types';

const START_TIME = new Date('2026-08-20T10:00:00Z').getTime();
// Daemon-side PROJECT_PREVIEW_SCOPE_TTL_MS (apps/daemon/src/services/project-preview-scopes.ts).
const PREVIEW_SCOPE_TTL_MS = 60 * 60 * 1000;
const PREVIEW_SCOPE_RENEW_MARGIN_MS = 5 * 60 * 1000;

function teamWorkspaceContext(): WorkspaceCollabContext {
  return {
    workspaceId: 'ws-1',
    workspaceType: 'team',
    teamId: 'team-1',
    workspaceMemberId: 'wm-1',
    role: 'member',
    memberStatus: 'active',
    lifecycleState: 'active',
    billingState: 'active',
    planId: null,
    providerMode: 'platform_credits',
    seatSummary: buildWorkspaceSeatSummary({ seatLimit: 5, usedSeats: 1 }),
    permissions: buildWorkspacePermissions({ role: 'member', lifecycleState: 'active' }),
  };
}

function renderTeamViewer(ui: ReactElement) {
  const workspaceContext = teamWorkspaceContext();
  const value: CollabContextValue = {
    workspaceContext,
    workspaceContextLoading: false,
    enabled: false,
    member: null,
    present: [],
    publishedVersion: null,
    syncState: null,
    viewerOnly: false,
    writerAuthority: 'allowed',
    isOwner: false,
    isEffectiveOwner: false,
    isSharedNonOwner: false,
    ownerDisplayName: null,
    ownerRole: null,
    downloadPending: false,
    reportChange: () => {},
    requestPublish: () => {},
    refreshPresence: () => {},
    checkStatusNow: () => {},
  };
  return render(<CollabProvider value={value}>{ui}</CollabProvider>);
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(START_TIME);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function deckFile(overrides: Partial<ProjectFile> = {}): ProjectFile {
  return {
    name: 'deck.html',
    path: 'deck.html',
    type: 'file',
    size: 1024,
    mtime: 1710000000,
    kind: 'html',
    mime: 'text/html',
    artifactManifest: {
      version: 1,
      kind: 'deck',
      title: 'Deck',
      entry: 'deck.html',
      renderer: 'deck-html',
      exports: ['html'],
    },
    ...overrides,
  };
}

function htmlFile(overrides: Partial<ProjectFile> = {}): ProjectFile {
  return {
    name: 'deck.html',
    path: 'deck.html',
    type: 'file',
    size: 1024,
    mtime: 1710000000,
    kind: 'html',
    mime: 'text/html',
    artifactManifest: {
      version: 1,
      kind: 'html',
      title: 'Page',
      entry: 'deck.html',
      renderer: 'html',
      exports: ['html'],
    },
    ...overrides,
  };
}

const DECK_RAW_URL = '/api/projects/project-1/raw/deck.html';
const PREVIEW_URL_ROUTE = '/api/projects/project-1/preview-url';

// A deck slide that references a project asset by relative path — the exact
// shape that depends on the minted base resolving.
function deckHtml(label: string): string {
  return `<html><body><section class="slide">`
    + `<h1>${label}</h1><img src="./assets/qr.png" alt="qr">`
    + `</section><section class="slide"><p>two</p></section></body></html>`;
}

/**
 * Fetch stub that mints a fresh scope id per `/preview-url` call, so the test
 * can tell a re-mint (scope-2) apart from a reused stale base (scope-1).
 */
function stubFetch(html: () => string) {
  const state = { mintCount: 0, renewCount: 0, failRenewal: false };
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof Request ? input.url : String(input);
    if (url.startsWith(PREVIEW_URL_ROUTE)) {
      state.mintCount += 1;
      return new Response(
        JSON.stringify({
          url: `/api/projects/project-1/preview/scope-000${state.mintCount}/deck.html`,
          file: 'deck.html',
          documentMode: new URL(url, 'http://localhost').searchParams.get('documentMode') ?? 'resource',
          csp: '',
          iframeSandbox: 'allow-scripts allow-forms',
          opaqueOrigin: true,
          expiresAt: Date.now() + PREVIEW_SCOPE_TTL_MS,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (/\/preview\/scope-\d+\/renew$/u.test(url)) {
      state.renewCount += 1;
      if (state.failRenewal) return new Response('', { status: 404 });
      return new Response(
        JSON.stringify({ expiresAt: Date.now() + PREVIEW_SCOPE_TTL_MS }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.startsWith(DECK_RAW_URL)) return new Response(html(), { status: 200 });
    return new Response('', { status: 404 });
  }));
  return state;
}

function srcDocBaseHref(): string | null {
  const frame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
  return (frame.getAttribute('srcDoc') ?? '').match(/<base href="([^"]*)"/i)?.[1] ?? null;
}

function verifySrcDocTransport(frame: HTMLIFrameElement) {
  const generation = frame.srcdoc.match(
    /data-od-srcdoc-transport-activation>[\s\S]*?var generation = "([^"]+)";/,
  )?.[1];
  expect(generation).toBeTruthy();
  const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage');
  fireEvent.load(frame);
  const probe = postMessage.mock.calls.find(
    ([message]) => (message as { type?: unknown }).type === 'od:srcdoc-transport-ready-probe',
  )?.[0] as { probeId?: string } | undefined;
  expect(probe?.probeId).toBeTruthy();
  act(() => {
    window.dispatchEvent(new MessageEvent('message', {
      source: frame.contentWindow,
      data: {
        type: 'od:srcdoc-transport-activated',
        generation,
        probeId: probe!.probeId,
        bodyComplete: true,
      },
    }));
  });
  postMessage.mockClear();
  return postMessage;
}

/** Mirrors the one-shot shell, followed by the enhanced artifact bridge. */
function mockNativePreviewDocument(frame: HTMLIFrameElement, documentId: string) {
  let generation: string | null = null;
  let bodyComplete = false;
  let shellLoaded = false;
  let documentUrl = frame.src;
  const replies: Array<Record<string, unknown>> = [];
  const activations: Array<{ documentId: string; generation: string; html: string }> = [];
  const send = (data: Record<string, unknown>) => act(() => {
    replies.push(data);
    window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data }));
  });
  const announce = (probeId?: string) => {
    if (!shellLoaded) {
      shellLoaded = true;
      fireEvent.load(frame);
    }
    send({ type: 'od:srcdoc-transport-ready', documentId, probeId });
  };
  const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation((message) => {
    if (message.type === 'od:srcdoc-transport-shell-probe' && generation === null) {
      queueMicrotask(() => announce(message.probeId));
    }
    if (message.type === 'od:srcdoc-transport-activate' && message.documentId === documentId
      && typeof message.generation === 'string' && message.generation && typeof message.html === 'string') {
      if (generation !== null) {
        queueMicrotask(() => send({ type: 'od:srcdoc-transport-reset-required', generation: message.generation, documentId }));
        return;
      }
      activations.push(message);
      generation = message.generation;
      queueMicrotask(() => {
        send({ type: 'od:srcdoc-transport-activated', generation, documentId, bodyComplete: false });
        bodyComplete = true;
        fireEvent.load(frame);
      });
    }
    if (message.type === 'od:srcdoc-transport-ready-probe'
      && message.documentId === documentId && message.generation === generation) {
      queueMicrotask(() => send({ type: 'od:srcdoc-transport-activated', generation, documentId,
        probeId: message.probeId, bodyComplete, documentReadyState: bodyComplete ? 'complete' : 'loading' }));
    }
    if (message.type === 'od:preview-base-scope-probe' && generation !== null) {
      queueMicrotask(() => send({ type: 'od:preview-base-scope', documentId, documentUrl }));
    }
  });
  return {
    postMessage,
    replies,
    announce,
    setLocation(href: string) {
      documentUrl = href;
      send({ type: 'od:preview-base-scope', documentId, documentUrl });
    },
    // Count only writes the strict one-shot shell actually accepts. An onLoad
    // request before identity discovery is ignored, rather than falsely ACKed.
    activations: () => activations,
    activationRequests: () => postMessage.mock.calls.map(([message]) => message as {
      type?: string; documentId?: string; generation?: string; html?: string;
    }).filter(message => message.type === 'od:srcdoc-transport-activate'),
  };
}

describe('FileViewer srcDoc preview base expiry', () => {
  it('renews the active scope without changing the iframe node or srcdoc bytes', async () => {
    let body = deckHtml('version-one');
    const fetchState = stubFetch(() => body);

    renderTeamViewer(
      <FileViewer projectId="project-1" projectKind="prototype" file={deckFile()} isDeck />,
    );

    await waitFor(() => {
      expect(srcDocBaseHref()).toBe('http://localhost:3000/api/projects/project-1/preview/scope-0001/');
    });
    expect(fetchState.mintCount).toBe(1);
    const frame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
    const initialSrcDoc = frame.getAttribute('srcDoc');
    const postMessage = verifySrcDocTransport(frame);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        PREVIEW_SCOPE_TTL_MS - PREVIEW_SCOPE_RENEW_MARGIN_MS,
      );
    });

    expect(fetchState.renewCount).toBe(1);
    expect(fetchState.mintCount).toBe(1);
    expect(screen.getByTestId('artifact-preview-frame')).toBe(frame);
    expect(frame.getAttribute('srcDoc')).toBe(initialSrcDoc);
    expect(postMessage.mock.calls.some(([message]) => (
      (message as { type?: unknown }).type === 'od:preview-base-update'
    ))).toBe(false);
  });

  it('renews the daemon-injected URL-load scope without navigating the iframe', async () => {
    const fetchState = stubFetch(() => '<html><body><main>URL loaded</main></body></html>');

    renderTeamViewer(
      <FileViewer
        projectId="project-1"
        projectKind="prototype"
        file={htmlFile()}
        liveHtml="<html><body><main>URL loaded</main></body></html>"
      />,
    );

    const frame = await waitFor(() => {
      const current = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
      expect(current.getAttribute('data-od-render-mode')).toBe('url-load');
      return current;
    });
    const initialSrc = frame.getAttribute('src');
    fireEvent.load(frame);
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        source: frame.contentWindow,
        data: {
          type: 'od:preview-base-scope',
          href: '/api/projects/project-1/preview/scope-0999/',
          expiresAt: Date.now() + PREVIEW_SCOPE_TTL_MS,
        },
      }));
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        PREVIEW_SCOPE_TTL_MS - PREVIEW_SCOPE_RENEW_MARGIN_MS,
      );
    });

    expect(fetchState.renewCount).toBe(1);
    expect(fetchState.mintCount).toBe(0);
    expect(screen.getByTestId('artifact-preview-frame')).toBe(frame);
    expect(frame.getAttribute('src')).toBe(initialSrc);
  });

  it('replaces a lost URL-load scope by messaging the live document', async () => {
    const fetchState = stubFetch(() => '<html><body><main>URL loaded</main></body></html>');

    renderTeamViewer(
      <FileViewer
        projectId="project-1"
        projectKind="prototype"
        file={htmlFile()}
        liveHtml="<html><body><main>URL loaded</main></body></html>"
      />,
    );

    const frame = await waitFor(() => {
      const current = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
      expect(current.getAttribute('data-od-render-mode')).toBe('url-load');
      return current;
    });
    const initialSrc = frame.getAttribute('src');
    fireEvent.load(frame);
    const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage');
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        source: frame.contentWindow,
        data: {
          type: 'od:preview-base-scope',
          href: '/api/projects/project-1/preview/scope-0999/',
          expiresAt: Date.now() + PREVIEW_SCOPE_TTL_MS,
        },
      }));
    });
    fetchState.failRenewal = true;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        PREVIEW_SCOPE_TTL_MS - PREVIEW_SCOPE_RENEW_MARGIN_MS,
      );
    });

    expect(fetchState.renewCount).toBe(1);
    expect(fetchState.mintCount).toBe(1);
    expect(screen.getByTestId('artifact-preview-frame')).toBe(frame);
    expect(frame.getAttribute('src')).toBe(initialSrc);
    expect(postMessage.mock.calls.some(([message]) => {
      const data = message as { type?: unknown; href?: unknown };
      return data.type === 'od:preview-base-update'
        && data.href === 'http://localhost:3000/api/projects/project-1/preview/scope-0001/';
    })).toBe(true);
  });

  it('replaces a lost daemon scope in place and uses it on the next natural rebuild', async () => {
    let body = deckHtml('version-one');
    const fetchState = stubFetch(() => body);

    renderTeamViewer(
      <FileViewer projectId="project-1" projectKind="prototype" file={deckFile()} isDeck />,
    );

    await waitFor(() => {
      expect(srcDocBaseHref()).toBe('http://localhost:3000/api/projects/project-1/preview/scope-0001/');
    });
    const frame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
    const initialSrcDoc = frame.getAttribute('srcDoc');
    const postMessage = verifySrcDocTransport(frame);
    fetchState.failRenewal = true;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        PREVIEW_SCOPE_TTL_MS - PREVIEW_SCOPE_RENEW_MARGIN_MS,
      );
    });

    expect(fetchState.renewCount).toBe(1);
    expect(fetchState.mintCount).toBe(2);
    expect(screen.getByTestId('artifact-preview-frame')).toBe(frame);
    expect(frame.getAttribute('srcDoc')).toBe(initialSrcDoc);
    expect(postMessage.mock.calls.some(([message]) => {
      const data = message as { type?: unknown; href?: unknown };
      return data.type === 'od:preview-base-update'
        && data.href === 'http://localhost:3000/api/projects/project-1/preview/scope-0002/';
    })).toBe(true);

    body = deckHtml('version-two');
    fireEvent.click(screen.getByRole('button', { name: /reload preview/i }));
    await waitFor(() => {
      expect(srcDocBaseHref()).toBe('http://localhost:3000/api/projects/project-1/preview/scope-0002/');
      expect(
        (screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement)
          .getAttribute('srcDoc'),
      ).toContain('version-two');
    });
  });
});

it('renders a storage-only deck despite an initial preview scope failure', async () => {
  const html = '<!doctype html><html><body><section class="slide"><h1>Startup available</h1></section><script>localStorage.setItem("ready", "1");</script></body></html>';
  stubFetch(() => html);
  const delegate = globalThis.fetch;
  let mintCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith(PREVIEW_URL_ROUTE) && ++mintCalls === 1) {
      return new Response('', { status: 503 });
    }
    return delegate(input, init);
  }));
  renderTeamViewer(<FileViewer projectId="project-1" projectKind="prototype" file={deckFile()} isDeck />);
  await waitFor(() => expect(mintCalls).toBe(1));
  const initialFrame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
  // Accept content already rendered; otherwise allow the scope retry budget to elapse.
  if (!initialFrame.srcdoc.includes('Startup available')) {
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  }
  const frame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
  expect(frame.srcdoc).toContain('Startup available');
});


it('retries initial native scope acquisition and activates the complete document', async () => {
  const html = '<!doctype html><html><body><h1>Recovered</h1><script>if (!location.hash) location.replace("#/home")</script></body></html>';
  stubFetch(() => html);
  const delegate = globalThis.fetch;
  let attempts = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith(PREVIEW_URL_ROUTE) && ++attempts === 1) return new Response('', { status: 503 });
    return delegate(input, init);
  }));
  renderTeamViewer(<FileViewer projectId="project-1" projectKind="prototype" file={deckFile()} isDeck />);
  await waitFor(() => expect(attempts).toBe(1));
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  await waitFor(() => expect(attempts).toBe(2));
  const frame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
  expect(frame.src).toContain('/preview/scope-0001/deck.html');
  expect(frame.hasAttribute('srcdoc')).toBe(false);
  const transport = mockNativePreviewDocument(frame, 'acquired-document');
  await act(async () => { transport.announce(); });
  const activation = await waitFor(() => {
    expect(transport.activations()).toHaveLength(1);
    expect(transport.activations()[0]?.documentId).toBe('acquired-document');
    return transport.activations()[0];
  });
  expect(activation?.html).toContain('<h1 data-od-id=');
  expect(activation?.html).toContain('Recovered');
  expect(new DOMParser().parseFromString(activation?.html ?? '', 'text/html').querySelector('base')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
});

it.each(['Code', 'file tab'] as const)('retains visibility switches and refreshes changed native content across %s switches', async (surface) => {
  const source = (label: string) => `<!doctype html><html><body><h1>${label}</h1><script>localStorage.getItem("preview"); if (!location.hash) location.replace("#/home")</script></body></html>`;
  let currentHtml = source('Version 1');
  const fetchState = stubFetch(() => currentHtml);
  const viewer = (active: boolean, version: number) => (
    <FileViewer projectId="project-1" projectKind="prototype"
      file={htmlFile({ mtime: version })} liveHtml={source(`Version ${version}`)} workspaceActive={active} />
  );
  const { rerender } = render(viewer(true, 1));
  const frame = await waitFor(() => {
    const current = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
    expect(current.getAttribute('data-od-render-mode')).toBe('srcdoc');
    expect(current.src).toContain('/preview/scope-0001/deck.html');
    return current;
  });
  const originalUrl = frame.src;
  const initialTransport = mockNativePreviewDocument(frame, 'retained-document-1');
  await act(async () => { initialTransport.announce(); });
  await waitFor(() => expect(initialTransport.activations().at(-1)?.html).toContain('Version 1'));
  expect(initialTransport.activations().every(message => message.documentId === 'retained-document-1')).toBe(true);

  if (surface === 'Code') fireEvent.click(screen.getByRole('tab', { name: 'Code' }));
  else rerender(viewer(false, 1));
  expect(frame.isConnected).toBe(true);
  expect(frame).toHaveAttribute('aria-hidden', 'true');
  currentHtml = source('Version 2');
  rerender(viewer(surface === 'Code', 2));
  await act(async () => { await Promise.resolve(); });
  await waitFor(() => expect(initialTransport.activationRequests().at(-1)?.html).toContain('Version 2'));
  expect(initialTransport.activationRequests().at(-1)?.html).not.toContain('Version 1');

  if (surface === 'Code') fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
  else rerender(viewer(true, 2));
  // The enhanced bridge asks for a fresh JavaScript realm on a new generation.
  // An inactive viewer receives no messages; its bounded probe recovery applies
  // the pending revision when the file tab becomes active again.
  await act(async () => { await vi.advanceTimersByTimeAsync(3_100); });
  const updatedFrame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
  expect(updatedFrame).not.toBe(frame);
  expect(updatedFrame.src).toBe(originalUrl);
  expect(updatedFrame.hasAttribute('srcdoc')).toBe(false);
  const updatedTransport = mockNativePreviewDocument(updatedFrame, 'retained-document-2');
  await act(async () => { updatedTransport.announce(); });
  await waitFor(() => expect(updatedTransport.activations().at(-1)?.html).toContain('Version 2'));
  expect(updatedTransport.activations().every(message => message.documentId === 'retained-document-2')).toBe(true);
  expect(updatedTransport.activationRequests().at(-1)?.documentId).toBe('retained-document-2');
  expect(updatedTransport.replies.filter(message => message.type === 'od:srcdoc-transport-activated')).toContainEqual(expect.objectContaining({
    documentId: 'retained-document-2', generation: updatedTransport.activations().at(-1)?.generation,
    bodyComplete: true,
  }));
  expect(fetchState.mintCount).toBe(1);

  // Pure visibility changes keep this fully parsed generation and DOM node.
  const activationCount = updatedTransport.activations().length;
  if (surface === 'Code') {
    fireEvent.click(screen.getByRole('tab', { name: 'Code' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
  } else {
    rerender(viewer(false, 2));
    rerender(viewer(true, 2));
  }
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  expect(screen.getByTestId('artifact-preview-frame')).toBe(updatedFrame);
  expect(updatedTransport.activations()).toHaveLength(activationCount);
});

it('cancels a pending native scope retry when the viewer unmounts', async () => {
  stubFetch(() => '<!doctype html><html><body><script>location.replace("#/home")</script></body></html>');
  const delegate = globalThis.fetch;
  let attempts = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith(PREVIEW_URL_ROUTE)) { attempts++; return new Response('', { status: 503 }); }
    return delegate(input, init);
  }));
  const { unmount } = renderTeamViewer(<FileViewer projectId="project-1" projectKind="prototype" file={deckFile()} isDeck />);
  await waitFor(() => expect(attempts).toBe(1));
  unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(attempts).toBe(1);
});


it('recovers a native carrier on a replacement scope while preserving its hash', async () => {
  const fetchState = stubFetch(() => '<!doctype html><html><body><h1>Recovery snapshot</h1><script>if (!location.hash) location.replace("#/home")</script></body></html>');
  renderTeamViewer(<FileViewer projectId="project-1" projectKind="prototype" file={deckFile()} isDeck />);
  const frame = await waitFor(() => {
    const current = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
    expect(current.src).toContain('/preview/scope-0001/deck.html');
    return current;
  });
  const initialTransport = mockNativePreviewDocument(frame, 'recovery-document-1');
  await act(async () => { initialTransport.announce(); });
  await waitFor(() => expect(initialTransport.activations()).toHaveLength(1));
  initialTransport.setLocation(frame.src + '#/details');
  fetchState.failRenewal = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(PREVIEW_SCOPE_TTL_MS - PREVIEW_SCOPE_RENEW_MARGIN_MS); });
  const recoveredFrame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
  expect(recoveredFrame.src).toContain('/preview/scope-0002/deck.html#/details');
  const recoveredTransport = mockNativePreviewDocument(recoveredFrame, 'recovery-document-2');
  await act(async () => { recoveredTransport.announce(); });
  await waitFor(() => {
    expect(recoveredTransport.activations()).toHaveLength(1);
    expect(recoveredTransport.activations()[0]).toMatchObject({ documentId: 'recovery-document-2' });
    expect(recoveredTransport.activations()[0]?.html).toContain('Recovery snapshot');
  });
  expect(initialTransport.activations().every(message => message.documentId === 'recovery-document-1')).toBe(true);
  expect(initialTransport.postMessage.mock.calls.some(([message]) => message.type === 'od:preview-base-update')).toBe(false);
});

it('preserves a bound directory entry query and hash while rejecting foreign native locations', async () => {
  const fetchState = stubFetch(() => '<!doctype html><html><body><h1>Directory snapshot</h1><script>location.replace("#/home")</script></body></html>');
  renderTeamViewer(<FileViewer projectId="project-1" projectKind="prototype" file={deckFile()} isDeck />);
  const frame = await waitFor(() => {
    const current = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
    expect(current.src).toContain('/preview/scope-0001/deck.html');
    return current;
  });
  const transport = mockNativePreviewDocument(frame, 'directory-document');
  await act(async () => { transport.announce(); });
  await waitFor(() => expect(transport.activations()).toHaveLength(1));
  const directory = new URL('.', frame.src).href;
  transport.setLocation(directory + '?theme=dark#/details');
  for (const foreign of [
    directory + 'other.html?theme=wrong#/other-file',
    directory.replace('/scope-0001/', '/scope-9999/') + '?theme=wrong#/other-scope',
    directory.replace('/project-1/', '/project-2/') + '?theme=wrong#/other-project',
    directory.replace('http://localhost:3000', 'https://other.example') + '?theme=wrong#/other-origin',
  ]) transport.setLocation(foreign);
  // The final capture probe also reports a foreign location. It must not
  // replace the last accepted query/hash from this scope's own directory.
  fetchState.failRenewal = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(PREVIEW_SCOPE_TTL_MS - PREVIEW_SCOPE_RENEW_MARGIN_MS); });
  expect((screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement).src)
    .toContain('/preview/scope-0002/deck.html?theme=dark#/details');
});

it('activates each native document once when the same iframe really reloads', async () => {
  stubFetch(() => '<!doctype html><html><body><h1>Reload snapshot</h1><script>if (!location.hash) location.replace("#/home")</script></body></html>');
  renderTeamViewer(<FileViewer projectId="project-1" projectKind="prototype" file={deckFile()} isDeck />);
  const frame = await waitFor(() => {
    const current = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
    expect(current.src).toContain('/preview/scope-0001/deck.html');
    return current;
  });
  let liveDocumentId = 'native-document-1';
  const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation((message) => {
    if (message.type === 'od:srcdoc-transport-shell-probe') queueMicrotask(() => {
      window.dispatchEvent(new MessageEvent('message', {
        source: frame.contentWindow,
        data: { type: 'od:srcdoc-transport-ready', documentId: liveDocumentId, probeId: message.probeId },
      }));
    });
  });
  const ready = (documentId: string) => window.dispatchEvent(new MessageEvent('message', {
    source: frame.contentWindow,
    data: { type: 'od:srcdoc-transport-ready', documentId },
  }));
  const activations = () => postMessage.mock.calls.map(([message]) => message as {
    type?: string; documentId?: string; html?: string;
  }).filter(message => message.type === 'od:srcdoc-transport-activate');
  await act(async () => { fireEvent.load(frame); ready('native-document-1'); });
  await waitFor(() => expect(activations()).toHaveLength(1));
  await act(async () => { ready('native-document-1'); fireEvent.load(frame); });
  expect(activations()).toHaveLength(1);
  await act(async () => { liveDocumentId = 'native-document-2'; ready(liveDocumentId); });
  await waitFor(() => expect(activations()).toHaveLength(2));
  expect(activations().at(-1)).toMatchObject({ documentId: 'native-document-2' });
  expect(activations().at(-1)?.html).toContain('Reload snapshot');
  await act(async () => { ready('native-document-1'); ready('native-document-2'); });
  expect(activations()).toHaveLength(2);
  expect(screen.getByTestId('artifact-preview-frame')).toBe(frame);
});

it('ignores a retired native document location when preserving query and hash on recovery', async () => {
  const fetchState = stubFetch(() => '<!doctype html><html><body><h1>Query snapshot</h1><script>location.replace("#/home")</script></body></html>');
  renderTeamViewer(<FileViewer projectId="project-1" projectKind="prototype" file={deckFile()} isDeck />);
  const frame = await waitFor(() => {
    const current = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
    expect(current.src).toContain('/preview/scope-0001/deck.html');
    return current;
  });
  const ready = (documentId: string) => window.dispatchEvent(new MessageEvent('message', {
    source: frame.contentWindow, data: { type: 'od:srcdoc-transport-ready', documentId },
  }));
  let liveDocumentId = 'native-document-1';
  vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation((message) => {
    if (message.type === 'od:srcdoc-transport-shell-probe') queueMicrotask(() => {
      window.dispatchEvent(new MessageEvent('message', {
        source: frame.contentWindow,
        data: { type: 'od:srcdoc-transport-ready', documentId: liveDocumentId, probeId: message.probeId },
      }));
    });
    if (message.type === 'od:preview-base-scope-probe') queueMicrotask(() => {
      window.dispatchEvent(new MessageEvent('message', {
        source: frame.contentWindow,
        data: { type: 'od:preview-base-scope', documentId: liveDocumentId, documentUrl: frame.src + '?theme=dark#/details' },
      }));
    });
  });
  await act(async () => { ready('native-document-1'); });
  await act(async () => { liveDocumentId = 'native-document-2'; ready(liveDocumentId); });
  act(() => {
    for (const [documentId, theme] of [['native-document-2', 'dark'], ['native-document-1', 'light']]) {
      window.dispatchEvent(new MessageEvent('message', {
        source: frame.contentWindow,
        data: { type: 'od:preview-base-scope', documentId, documentUrl: frame.src + `?theme=${theme}#/details` },
      }));
    }
  });
  fetchState.failRenewal = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(PREVIEW_SCOPE_TTL_MS - PREVIEW_SCOPE_RENEW_MARGIN_MS); });
  expect((screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement).src)
    .toContain('/preview/scope-0002/deck.html?theme=dark#/details');
});

it('keeps one pending shell challenge when ready announcements arrive together', async () => {
  stubFetch(() => '<!doctype html><html><body><script>location.replace("#/home")</script></body></html>');
  renderTeamViewer(<FileViewer projectId="project-1" projectKind="prototype" file={deckFile()} isDeck />);
  const frame = await waitFor(() => {
    const current = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
    expect(current.src).toContain('/preview/scope-0001/deck.html');
    return current;
  });
  const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage');
  act(() => {
    for (let i = 0; i < 2; i++) window.dispatchEvent(new MessageEvent('message', {
      source: frame.contentWindow, data: { type: 'od:srcdoc-transport-ready', documentId: 'current-document' },
    }));
  });
  const challenges = postMessage.mock.calls.map(([message]) => message as { type?: string; probeId?: string })
    .filter(message => message.type === 'od:srcdoc-transport-shell-probe' && message.probeId);
  expect(challenges).toHaveLength(1);
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', {
      source: frame.contentWindow,
      data: { type: 'od:srcdoc-transport-ready', documentId: 'current-document', probeId: challenges[0]!.probeId },
    }));
  });
  expect(postMessage.mock.calls.filter(([message]) => message.type === 'od:srcdoc-transport-activate')).toHaveLength(1);
});

it('replaces Electron\'s prewarmed Blob frame when the native carrier becomes available', async () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Chrome/140 Electron/38');
  const BrowserURL = URL;
  vi.stubGlobal('URL', class extends BrowserURL {
    static createObjectURL() { return 'blob:http://localhost:3000/warm-bootstrap'; }
  });
  stubFetch(() => '<!doctype html><html><body><h1>Native ready</h1><script>if (!location.hash) location.replace("#/home")</script></body></html>');
  const delegate = globalThis.fetch;
  let release!: () => void;
  const pendingScope = new Promise<void>(resolve => { release = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith(PREVIEW_URL_ROUTE)) await pendingScope;
    return delegate(input, init);
  }));
  renderTeamViewer(<FileViewer projectId="project-1" projectKind="prototype" file={deckFile()} isDeck />);
  const warmFrame = await waitFor(() => screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement);
  expect(warmFrame.src).toContain('blob:');
  const warmTransport = mockNativePreviewDocument(warmFrame, 'warm-blob-document');
  await act(async () => { warmTransport.announce(); });
  await act(async () => { release(); });
  const nativeFrame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
  expect(nativeFrame.src).toContain('/preview/scope-0001/deck.html');
  expect(nativeFrame).not.toBe(warmFrame);
  const nativeTransport = mockNativePreviewDocument(nativeFrame, 'native-document');
  await act(async () => { nativeTransport.announce(); });
  await waitFor(() => {
    expect(nativeTransport.activations()).toHaveLength(1);
    expect(nativeTransport.activations()[0]).toMatchObject({ documentId: 'native-document' });
    expect(nativeTransport.activations()[0]?.html).toContain('Native ready');
  });
  expect(warmTransport.activations().every(message => message.documentId === 'warm-blob-document')).toBe(true);
});

it.each([
  { label: 'another project', projectId: 'project-2', fileName: 'deck.html' },
  { label: 'another file in the same project', projectId: 'project-1', fileName: 'other.html' },
])('isolates the open presenter from replacement scopes after switching to $label', async ({ projectId, fileName }) => {
  const source = '<!doctype html><html><body><section class="slide"><h1>Presenter snapshot</h1></section><script>if (!location.hash) location.replace("#/home")</script></body></html>';
  const fetchState = stubFetch(() => source);
  const delegate = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost:3000');
    if (url.pathname === `/api/projects/${projectId}/preview-url`
      && (projectId !== 'project-1' || url.searchParams.get('file') === fileName)) {
      fetchState.mintCount++;
      return new Response(JSON.stringify({
        url: `/api/projects/${projectId}/preview/scope-000${fetchState.mintCount}/${fileName}`,
        file: fileName,
        documentMode: url.searchParams.get('documentMode') ?? 'resource',
        expiresAt: Date.now() + PREVIEW_SCOPE_TTL_MS,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return delegate(input, init);
  }));

  const popupPost = vi.fn();
  const popupFramePost = vi.fn();
  const popupClose = vi.fn();
  const popup = {
    closed: false, close: popupClose, focus: vi.fn(), postMessage: popupPost,
    document: {
      open: vi.fn(), write: vi.fn(), close: vi.fn(),
      querySelectorAll: () => [{ contentWindow: { postMessage: popupFramePost } }],
    },
  } as unknown as Window;
  const openPopup = vi.spyOn(window, 'open').mockReturnValue(popup);
  const viewer = (id: string, name: string) => (
    <FileViewer projectId={id} projectKind="prototype"
      file={deckFile({ name, path: name })} liveHtml={source} isDeck />
  );
  const { rerender } = render(viewer('project-1', 'deck.html'));
  await waitFor(() => expect((screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement).src)
    .toContain('/preview/scope-0001/deck.html'));
  fireEvent.click(screen.getByRole('button', { name: /^present$/i }));
  fireEvent.click(screen.getByRole('menuitem', { name: /in this tab/i }));
  expect(openPopup).toHaveBeenCalledTimes(1);

  // Positive control: this popup receives recovery while its own source and
  // the renewing viewer still have the same project/file identity.
  fetchState.failRenewal = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(PREVIEW_SCOPE_TTL_MS - PREVIEW_SCOPE_RENEW_MARGIN_MS); });
  expect(popupPost.mock.calls.some(([message]) => message.type === 'od:presenter-preview-update'
    && message.projectId === 'project-1' && message.fileName === 'deck.html')).toBe(true);

  rerender(viewer(projectId, fileName));
  await waitFor(() => expect((screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement).src)
    .toContain(`/api/projects/${projectId}/preview/scope-0003/${fileName}`));
  expect(openPopup).toHaveBeenCalledTimes(1);
  expect(popupClose).not.toHaveBeenCalled();
  popupPost.mockClear();
  popupFramePost.mockClear();
  const renewalsBeforeSwitch = fetchState.renewCount;
  await act(async () => { await vi.advanceTimersByTimeAsync(PREVIEW_SCOPE_TTL_MS - PREVIEW_SCOPE_RENEW_MARGIN_MS); });

  expect(fetchState.renewCount).toBeGreaterThan(renewalsBeforeSwitch);
  expect((screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement).src)
    .toContain(`/api/projects/${projectId}/preview/scope-0004/${fileName}`);
  expect(popupPost.mock.calls.some(([message]) => message.type === 'od:presenter-preview-update')).toBe(false);
  expect(popupFramePost.mock.calls.some(([message]) => message.type === 'od:preview-base-update')).toBe(false);
});

it.each(['scope replacement', 'same-URL reload'] as const)('keeps saved Manual Edit content after a native %s', async (replacement) => {
  let persisted = '<!doctype html><html><body><main data-od-id="hero">Before save</main><script>localStorage.getItem("preview"); if (!location.hash) location.replace("#/home")</script></body></html>';
  const writtenSources: string[] = [];
  const fetchState = stubFetch(() => persisted);
  const delegate = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/files/deck.html/versions')) {
      return new Response(JSON.stringify({ versions: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.endsWith('/api/projects/project-1/files') && init?.method === 'POST') {
      persisted = (JSON.parse(String(init.body)) as { content: string }).content;
      writtenSources.push(persisted);
      return new Response(JSON.stringify({ file: htmlFile() }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return delegate(input, init);
  }));
  render(<FileViewer projectId="project-1" projectKind="prototype" file={htmlFile()} liveHtml={persisted} />);
  const frame = await waitFor(() => {
    const current = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
    expect(current.src).toContain('/preview/scope-0001/deck.html');
    return current;
  });
  const initialTransport = mockNativePreviewDocument(frame, 'saved-edit-document-1');
  await act(async () => { initialTransport.announce(); });
  await waitFor(() => expect(initialTransport.activations()).toHaveLength(1));
  fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
  await waitFor(() => expect(screen.getByTestId('manual-edit-mode-toggle')).toHaveAttribute('aria-pressed', 'true'));
  act(() => window.dispatchEvent(new MessageEvent('message', {
    source: frame.contentWindow,
    data: { type: 'od-edit-text-commit', id: 'hero', value: 'Saved content' },
  })));
  await waitFor(() => expect(persisted).toContain('Saved content'));
  expect(writtenSources).toHaveLength(1);
  expect(new DOMParser().parseFromString(writtenSources[0]!, 'text/html')
    .querySelector('[data-od-id="hero"]')?.textContent).toBe('Saved content');
  await waitFor(() => expect(initialTransport.postMessage.mock.calls.some(([message]) =>
    message.type === 'od-edit-preview-text' && message.value === 'Saved content')).toBe(true));
  if (replacement === 'scope replacement') {
    fetchState.failRenewal = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(PREVIEW_SCOPE_TTL_MS - PREVIEW_SCOPE_RENEW_MARGIN_MS); });
  }
  const recoveredFrame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
  const expectedScope = replacement === 'scope replacement' ? 'scope-0002' : 'scope-0001';
  expect(recoveredFrame.src).toContain(`/preview/${expectedScope}/deck.html`);
  if (replacement === 'scope replacement') expect(recoveredFrame).not.toBe(frame);
  else expect(recoveredFrame).toBe(frame);
  const recoveredTransport = mockNativePreviewDocument(recoveredFrame, 'saved-edit-document-2');
  await act(async () => { recoveredTransport.announce(); });
  await waitFor(() => expect(recoveredTransport.activations()).toHaveLength(1));
  expect(recoveredTransport.activations()[0]?.documentId).toBe('saved-edit-document-2');
  const activated = new DOMParser().parseFromString(recoveredTransport.activations()[0]?.html ?? '', 'text/html');
  expect(activated.querySelector('[data-od-id="hero"]')?.textContent).toBe('Saved content');
  expect(recoveredTransport.activations()[0]?.html).toContain(`/preview/${expectedScope}/`);
});
