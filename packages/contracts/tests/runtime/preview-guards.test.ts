import { describe, expect, it } from 'vitest';
import {
  buildPreviewFocusGuard,
  buildPreviewRedirectGuard,
  buildPreviewSandboxShim,
  buildLazySrcdocTransport,
  PREVIEW_URL_GUARD_MAX_HTML_BYTES,
  previewHtmlHasLoadTimeLocationNavigation,
  previewHtmlNeedsNativeNavigation,
  previewHtmlUsesQuirksMode,
} from '../../src/runtime/preview-guards';

describe('preview document guards', () => {
  it('builds inert scripts with stable markers for transport-level deduplication', () => {
    expect(buildPreviewSandboxShim()).toContain('<script data-od-sandbox-shim>');
    expect(buildPreviewFocusGuard()).toContain('<script data-od-preview-focus-guard>');
    expect(buildPreviewRedirectGuard()).toContain('<script data-od-preview-redirect-guard>');
  });

  it('embeds the load-time redirect decision in the redirect guard', () => {
    expect(buildPreviewRedirectGuard()).toContain('BLOCK_LOAD_TIME_SCRIPT_REDIRECT = false');
    expect(buildPreviewRedirectGuard({ blockLoadTimeScriptRedirect: true }))
      .toContain('BLOCK_LOAD_TIME_SCRIPT_REDIRECT = true');
  });

  it('detects authored load-time location navigation without matching comparisons', () => {
    expect(previewHtmlHasLoadTimeLocationNavigation('<script>location.reload()</script>')).toBe(true);
    expect(previewHtmlHasLoadTimeLocationNavigation('<script>window.location = "/next"</script>')).toBe(true);
    expect(previewHtmlHasLoadTimeLocationNavigation('<script>if (location.href === expected) ready()</script>')).toBe(false);
  });

  it('keeps the URL injection limit aligned with the streaming boundary', () => {
    expect(PREVIEW_URL_GUARD_MAX_HTML_BYTES).toBe(2 * 1024 * 1024);
  });
});

it('requires a native carrier for navigation or hidden external scripts, not storage alone', () => {
  expect(previewHtmlNeedsNativeNavigation('<script>localStorage.setItem("ready", "1")</script>')).toBe(false);
  expect(previewHtmlNeedsNativeNavigation('<script>if (!location.hash) location.replace("#/home")</script>')).toBe(true);
  expect(previewHtmlNeedsNativeNavigation('<script src="app.js"></script>')).toBe(true);
  expect(previewHtmlUsesQuirksMode('<p>Fragment</p>')).toBe(true);
  expect(previewHtmlUsesQuirksMode('<html><body>Legacy</body></html>')).toBe(true);
  expect(previewHtmlUsesQuirksMode('<!-- comment -->\n<!DOCTYPE html><html></html>')).toBe(false);
});

it.each([
  '<script>const go = location.replace.bind(location); if (!location.hash) go("#/home")</script>',
  '<script>window["location"]["replace"]("#/home")</script>',
  '<script type="module">import "./router.js"</script>',
  '<script>import("./router.js")</script>',
])('keeps indirect or imported navigation on a file-bound carrier: %s', (source) => {
  expect(previewHtmlNeedsNativeNavigation(source)).toBe(true);
});

it('does not turn storage-only or inert script data into native navigation', () => {
  expect(previewHtmlNeedsNativeNavigation('<script>localStorage.getItem("preview")</script>')).toBe(false);
  expect(previewHtmlNeedsNativeNavigation('<script type="application/json">{"location":"home"}</script>')).toBe(false);
});

it.each([
  '<body onload="const go=location.replace.bind(location); if(!location.hash)go(\'#/home\')">Alias</body>',
  '<body onload="window[\'location\'][\'replace\'](\'#/home\')">Computed</body>',
  '<button onclick="location[\'replace\'](\'#/home\')">Home</button>',
  '<body data-label=">" onload="location[\'assign\'](\'#/home\')">Quoted attribute</body>',
  '<button onclick="import(\'./router.js\')">Load router</button>',
  '<a href="javascript:location.replace(\'#/home\')">Home</a>',
])('keeps executable event-handler navigation on a file-bound carrier: %s', (source) => {
  expect(previewHtmlNeedsNativeNavigation(source)).toBe(true);
});

it.each([
  '<body onload="localStorage.getItem(\'preview\')">Storage</body>',
  '<p>location.replace("#/home")</p>',
  '<div title="location.replace(\'#/home\')">An example</div>',
  '<div data-example="javascript:location.replace(\'#/home\')">An example</div>',
  '<!-- <body onload="location.replace(\'#/home\')"> -->',
  '<textarea><button onclick="location.replace(\'#/home\')">Example</button></textarea>',
  '<script type="application/json">{"example":"<body onload=location.replace()>"}</script>',
])('ignores storage-only handlers and inert navigation examples: %s', (source) => {
  expect(previewHtmlNeedsNativeNavigation(source)).toBe(false);
});

it('does not repeatedly scan the remaining document for unterminated tags', () => {
  const source = '<div '.repeat(30_000);
  const started = performance.now();
  expect(previewHtmlNeedsNativeNavigation(source)).toBe(false);
  // The preview also accepts incomplete HTML while it is being generated.
  // Leave a wide margin for CI; rescanning each tag prefix takes seconds here.
  expect(performance.now() - started).toBeLessThan(500);
});

it('binds bootstrap activation to each real document and echoes a shell challenge', () => {
  const messages: Array<Record<string, unknown>> = [];
  const writes: string[] = [];
  const handlers = new Map<string, (event: { source: unknown; data: Record<string, unknown> }) => void>();
  const parent = { postMessage: (message: Record<string, unknown>) => messages.push(message) };
  const frame: Record<string, unknown> = {
    parent,
    addEventListener: (name: string, handler: (event: { source: unknown; data: Record<string, unknown> }) => void) => handlers.set(name, handler),
    removeEventListener: (name: string) => handlers.delete(name),
  };
  const doc = {
    // document.open removes a document's previous listeners. Reinstall the
    // identity after it so the enhanced document reads the current shell ID.
    open: () => { frame.__odSrcdocTransportDocumentId = undefined; },
    write: (html: string) => writes.push(html),
    close: () => undefined,
  };
  const script = buildLazySrcdocTransport().match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1];
  expect(script).toBeTruthy();
  new Function('window', 'document', script!)(frame, doc);
  const documentId = messages[0]?.documentId;
  expect(documentId).toEqual(expect.any(String));
  handlers.get('message')?.({ source: parent, data: { type: 'od:srcdoc-transport-shell-probe', probeId: 'shell-probe-1' } });
  expect(messages.at(-1)).toMatchObject({ documentId, probeId: 'shell-probe-1' });
  handlers.get('message')?.({ source: parent, data: { type: 'od:srcdoc-transport-activate', documentId: 'previous-document', generation: 'generation-1', html: '<main>Stale</main>' } });
  expect(writes).toEqual([]);
  handlers.get('message')?.({ source: parent, data: { type: 'od:srcdoc-transport-activate', documentId, generation: 'generation-1', html: '<main>Current</main>' } });
  expect(writes).toEqual(['<main>Current</main>']);
  expect(frame.__odSrcdocTransportDocumentId).toBe(documentId);

  new Function('window', 'document', script!)(frame, doc);
  const nextDocumentId = messages.at(-1)?.documentId;
  expect(nextDocumentId).toEqual(expect.any(String));
  expect(nextDocumentId).not.toBe(documentId);
  handlers.get('message')?.({ source: parent, data: { type: 'od:srcdoc-transport-activate', documentId, generation: 'generation-1', html: '<main>Late previous activation</main>' } });
  expect(writes).toEqual(['<main>Current</main>']);
  handlers.get('message')?.({ source: parent, data: { type: 'od:srcdoc-transport-activate', documentId: nextDocumentId, generation: 'generation-1', html: '<main>Reloaded</main>' } });
  expect(writes).toEqual(['<main>Current</main>', '<main>Reloaded</main>']);
});


it.each([
  '<!-- comment --!><script>location.replace("#/home")</script>',
  '<!--><script>location.replace("#/home")</script>',
  '<!---><script>location.replace("#/home")</script>',
  '<style>body{color:red}</style/><script>location.replace("#/home")</script>',
  '<style>body{color:red}</style foo><script>location.replace("#/home")</script>',
  '<textarea>Example</textarea foo><script>location.replace("#/home")</script>',
  '<body onload="&#108;ocation.replace(\'#/home\')">Ready</body>',
  '<table><select></table><script>location.replace("#/home")</script>',
  '<table><select></table><script type=module>import "./router.js"</script>',
  '<svg></br><script>location.replace("#/home")</script>',
  '<svg><script>location.replace("#/home")</script></svg>',
  '<svg><script href="router.js"></script></svg>',
  '<svg><foreignObject><script>location.replace("#/home")</script></foreignObject></svg>',
])('preserves browser-accepted navigation and conservative unknown HTML: %s', source => {
  expect(previewHtmlNeedsNativeNavigation(source)).toBe(true);
});

it.each([
  'application/ecmascript', 'application/javascript', 'application/x-ecmascript', 'application/x-javascript',
  'text/ecmascript', 'text/javascript', 'text/javascript1.0', 'text/javascript1.1',
  'text/javascript1.2', 'text/javascript1.3', 'text/javascript1.4', 'text/javascript1.5',
  'text/jscript', 'text/livescript', 'text/x-ecmascript', 'text/x-javascript',
])('recognizes supported JavaScript MIME type %s', type => {
  expect(previewHtmlNeedsNativeNavigation(`<script type="${type}">location.replace("#/home")</script>`)).toBe(true);
});

it.each([
  '<template><script>location.replace("#/home")</script></template>',
  '<svg><![CDATA[<script>location.replace("#/home")</script>]]></svg>',
  '<svg><foreignObject><template><script>location.replace("#/home")</script></template></foreignObject></svg>',
  '<!-- <script>location.replace("#/home")</script>',
  '<textarea><script>location.replace("#/home")</script>',
  '<script type="text/javascript; charset=utf-8">location.replace("#/home")</script>',
  '<script language="vbscript">location.replace("#/home")</script>',
  '<script type="application/json" src="data.json">{"location":"home"}</script>',
])('keeps browser-inert navigation examples on the inline transport: %s', source => {
  expect(previewHtmlNeedsNativeNavigation(source)).toBe(false);
});
