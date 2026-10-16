import { createServer } from 'node:http';
import { buildLazySrcdocTransport } from '@open-design/contracts/runtime/preview-guards';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

const rendererState = vi.hoisted(() => ({ loadedUrls: [] as string[], writes: [] as string[] }));

vi.mock('electron', () => {
  const image = {
    getSize: () => ({ height: 1, width: 1 }),
    toBitmap: () => Buffer.alloc(4),
    toJPEG: () => Buffer.from('jpeg'),
    toPNG: () => Buffer.from('png'),
  };

  class BrowserWindow {
    readonly webContents = {
      capturePage: async () => image,
      debugger: {
        attach: () => {
          throw new Error('debugger unavailable in renderer-base test');
        },
        detach: () => undefined,
        sendCommand: async () => undefined,
      },
      executeJavaScript: async (source: string): Promise<unknown> => {
        if (source.includes('document.write(')) rendererState.writes.push(source);
        if (source.includes("document.querySelectorAll('.slide")) return 0;
        if (source.includes('document.documentElement.scrollHeight')) return 1;
        if (source === 'window.devicePixelRatio || 1') return 1;
        return true;
      },
      on: () => undefined,
      // Real Electron webContents is an EventEmitter; the renderer's document
      // load waits on `once('dom-ready')`. The stub's loadURL resolves
      // immediately, so a no-op is faithful here — the load simply never has a
      // dom-ready to race against.
      once: () => undefined,
      printToPDF: async () => Buffer.from('pdf'),
      setWindowOpenHandler: () => undefined,
    };

    async loadURL(url: string): Promise<void> {
      rendererState.loadedUrls.push(url);
    }

    destroy(): void {}
    getContentSize(): [number, number] { return [1440, 900]; }
    isDestroyed(): boolean { return false; }
    setContentSize(): void {}
    setOpacity(): void {}
    showInactive(): void {}
  }

  return {
    BrowserWindow,
    dialog: { showSaveDialog: async () => ({ canceled: true }) },
    nativeImage: { createFromBitmap: () => image },
  };
});

import { exportArtifact } from '../../src/main/artifact-export.js';
import { renderDeckSlides } from '../../src/main/deck-capture.js';

const execFileP = promisify(execFile);
const desktopRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Budget for one Electron probe process (`xvfb-run … electron <probeDir>` on
 * Linux). The probes only need a second or two once Chromium is up, but a
 * cold Electron start on a busy CI runner can take well over ten seconds,
 * and `execFile` kills a timed-out child with a bare "Command failed" and no
 * stderr — which is exactly what an otherwise green run shows when it flakes.
 * Generous on purpose: a probe that really hangs still fails, just later.
 */
const ELECTRON_PROBE_TIMEOUT_MS = 60_000;
/** Per-test budget for a test that runs one probe: the probe plus setup. */
const ELECTRON_PROBE_TEST_TIMEOUT_MS = 90_000;
const legacyBaseHref = 'https://external.invalid/legacy/';
const scopedBaseHref = 'http://127.0.0.1:43123/preview/export-scope/';
const sourceHtml = `<!doctype html>
<html>
  <head>
    <base href="${legacyBaseHref}">
    <link rel="stylesheet" href="styles/x.css">
  </head>
  <body>
    <img src="assets/hero.png" alt="">
  </body>
</html>`;

type BaseResolution = {
  readonly baseURI: string;
  readonly compatMode: string;
  readonly hash?: string;
  readonly heading?: string;
  readonly headingColor?: string;
  readonly imageSrc: string;
  readonly stylesheetHref: string;
};

afterEach(() => {
  rendererState.loadedUrls.length = 0;
  rendererState.writes.length = 0;
});

describe('scoped renderer base precedence', () => {
  it.each(['image', 'deck-pdf', 'deck-capture'] as const)(
    'preserves standards mode and authored CSS without explicit html/head tags in %s',
    async (renderer) => {
      const html = '<!doctype html><title>Historical snapshot</title>'
        + '<style>.mixedcase { color: rgb(255, 0, 0); }</style>'
        + '<link rel="stylesheet" href="styles/x.css">'
        + '<body><h1 class="MixedCase">Historical snapshot</h1><img src="assets/hero.png">'
        + '<script>if (!location.hash) location.replace("#/history")</script>';
      await withNativePreviewServer(async (baseHref) => {
        const input = { html, baseHref, documentUrl: baseHref + 'index.html', deck: true };
        const result = renderer === 'deck-capture'
          ? await renderDeckSlides(input)
          : await exportArtifact({ ...input, format: renderer === 'deck-pdf' ? 'pdf' : 'image', title: 'History' });
        try {
          expect(rendererState.writes).toHaveLength(1);
          const state = await probeLoadedDocument(singleLoadedUrl(), rendererState.writes[0]);
          expect(state).toMatchObject({
            baseURI: baseHref,
            compatMode: 'CSS1Compat',
            hash: '#/history',
            heading: 'Historical snapshot',
            // Class selectors are case sensitive in standards mode. A misplaced
            // doctype switches Chromium to quirks mode and turns this text red.
            headingColor: 'rgb(0, 0, 0)',
          });
          expect(state.imageSrc).toBe(baseHref + 'assets/hero.png');
        } finally {
          if ('path' in result && result.path) await rm(dirname(result.path), { force: true, recursive: true });
        }
      });
    },
    ELECTRON_PROBE_TEST_TIMEOUT_MS,
  );

  it.each([
    ['html without head', '<!doctype html><html>', 'CSS1Compat'],
    ['leading comment', '<!-- authored comment --><!doctype html>', 'CSS1Compat'],
    ['XML prolog', '<?xml version="1.0"?><!doctype html>', 'CSS1Compat'],
    ['fragment without doctype', '', 'BackCompat'],
    ['legacy doctype', '<!doctype foo>', 'BackCompat'],
  ] as const)('preserves the authored document mode for %s', async (_name, prefix, compatMode) => {
    const html = prefix + '<title>History</title><link rel="stylesheet" href="styles/x.css">'
      + '<body><h1>Historical snapshot</h1><img src="assets/hero.png">'
      + '<script>if (!location.hash) location.replace("#/history")</script>';
    await withNativePreviewServer(async (baseHref) => {
      const result = await exportArtifact({ html, baseHref, documentUrl: baseHref + 'index.html', deck: false, format: 'image', title: 'History' });
      try {
        const state = await probeLoadedDocument(singleLoadedUrl(), rendererState.writes[0]);
        expect(state).toMatchObject({ compatMode, hash: '#/history', heading: 'Historical snapshot' });
      } finally { if (result.path) await rm(dirname(result.path), { force: true, recursive: true }); }
    });
  }, ELECTRON_PROBE_TEST_TIMEOUT_MS);

  it('keeps a hash-routed export on its selected historical snapshot in Electron', async () => {
    let documentRequests = 0;
    const server = createServer((request, response) => {
      if (request.url === '/api/projects/export/preview/scope/index.html') {
        documentRequests++;
        response.setHeader('Content-Type', 'text/html');
        response.setHeader('Content-Security-Policy', "sandbox allow-scripts allow-downloads; base-uri 'none'; object-src 'none'; form-action 'none'");
        response.end(buildLazySrcdocTransport());
      } else { response.statusCode = 404; response.end('Not a document'); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const baseHref = `http://127.0.0.1:${port}/api/projects/export/preview/scope/`;
    try {
      const result = await exportArtifact({
        html: '<!doctype html><html><head><link rel="stylesheet" href="styles/x.css"></head><body><h1>Historical snapshot</h1><img src="assets/hero.png"><script>if (!location.hash) location.replace("#/history")</script></body></html>',
        baseHref, documentUrl: baseHref + 'index.html', deck: false, format: 'image', title: 'History',
      });
      try {
        expect(result.ok).toBe(true);
        expect(rendererState.writes).toHaveLength(1);
        const state = await probeLoadedDocument(singleLoadedUrl(), rendererState.writes[0]);
        expect(state).toMatchObject({ baseURI: baseHref, hash: '#/history', heading: 'Historical snapshot' });
        expect(state.imageSrc).toBe(baseHref + 'assets/hero.png');
        expect(documentRequests).toBe(1);
      } finally { if (result.path) await rm(dirname(result.path), { force: true, recursive: true }); }
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  }, ELECTRON_PROBE_TEST_TIMEOUT_MS);

  it('uses the scoped base for deck-capture CSS and images when HTML already has an external base', async () => {
    // Given: a deck-capture request whose source document already declares another base.
    const input = {
      baseHref: scopedBaseHref,
      deck: true,
      html: sourceHtml,
    };

    // When: deck-capture builds and loads its renderer document.
    const result = await renderDeckSlides(input);

    // Then: Electron Chromium proves the scoped base controls every relative renderer asset.
    const resolution = await probeLoadedDocument(singleLoadedUrl());
    expect(result).toMatchObject({ errorCode: 'NO_SLIDES', ok: false });
    expect(resolution).toEqual(expectedResolution());
  }, ELECTRON_PROBE_TEST_TIMEOUT_MS);

  it('uses the scoped base for artifact-export CSS and images when HTML already has an external base', async () => {
    // Given: an artifact-export request whose source document already declares another base.
    const input = {
      baseHref: scopedBaseHref,
      deck: false,
      format: 'image',
      html: sourceHtml,
      imageFormat: 'png',
      title: 'Existing base precedence',
    } as const;

    // When: artifact-export builds and loads its renderer document.
    const result = await exportArtifact(input);

    try {
      // Then: Electron Chromium proves the scoped base controls every relative renderer asset.
      const resolution = await probeLoadedDocument(singleLoadedUrl());
      expect(result.ok).toBe(true);
      expect(resolution).toEqual(expectedResolution());
    } finally {
      if (result.path) await rm(dirname(result.path), { force: true, recursive: true });
    }
  }, ELECTRON_PROBE_TEST_TIMEOUT_MS);
});

function singleLoadedUrl(): string {
  expect(rendererState.loadedUrls).toHaveLength(1);
  const url = rendererState.loadedUrls[0];
  if (!url) throw new Error('renderer did not load a document');
  return url;
}

function expectedResolution(): BaseResolution {
  return {
    baseURI: scopedBaseHref,
    compatMode: 'CSS1Compat',
    imageSrc: new URL('assets/hero.png', scopedBaseHref).href,
    stylesheetHref: new URL('styles/x.css', scopedBaseHref).href,
  };
}

async function withNativePreviewServer(run: (baseHref: string) => Promise<void>): Promise<void> {
  const server = createServer((request, response) => {
    if (request.url === '/api/projects/export/preview/scope/index.html') {
      response.setHeader('Content-Type', 'text/html');
      response.setHeader('Content-Security-Policy', "sandbox allow-scripts allow-downloads; base-uri 'none'; object-src 'none'; form-action 'none'");
      response.end(buildLazySrcdocTransport());
    } else { response.statusCode = 404; response.end('Not a document'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try { await run(`http://127.0.0.1:${port}/api/projects/export/preview/scope/`); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

async function probeLoadedDocument(url: string, activation = ''): Promise<BaseResolution> {
  const probeDir = await mkdtemp(join(tmpdir(), 'od-electron-base-probe-'));
  const urlFile = join(probeDir, 'url.txt');
  await writeFile(join(probeDir, 'package.json'), '{"main":"main.cjs"}\n');
  await writeFile(urlFile, url);
  await writeFile(join(probeDir, 'activation.txt'), activation);
  await writeFile(join(probeDir, 'main.cjs'), `
const { app, BrowserWindow } = require('electron');
const { readFile } = require('node:fs/promises');

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  await window.loadURL(await readFile(process.env.OD_BASE_PROBE_URL_FILE, 'utf8'));
  const activation = await readFile(process.env.OD_BASE_PROBE_ACTIVATION_FILE, 'utf8');
  if (activation) await window.webContents.executeJavaScript(activation);
  const result = await window.webContents.executeJavaScript(\`({
    baseURI: document.baseURI,
    compatMode: document.compatMode,
    hash: location.hash, heading: document.querySelector('h1')?.textContent,
    headingColor: document.querySelector('h1') ? getComputedStyle(document.querySelector('h1')).color : undefined,
    imageSrc: document.querySelector('img').src,
    stylesheetHref: document.querySelector('link[rel="stylesheet"]').href,
  })\`, true);
  process.stdout.write('OD_BASE_PROBE:' + JSON.stringify(result) + '\\n');
  window.destroy();
  app.quit();
}).catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error) + '\\n');
  app.exit(1);
});
`);

  try {
    const electronRelativePath = (await readFile(
      join(desktopRoot, 'node_modules', 'electron', 'path.txt'),
      'utf8',
    )).trim();
    const electronPath = join(desktopRoot, 'node_modules', 'electron', 'dist', electronRelativePath);
    const electronArgs = [probeDir, '--no-sandbox', '--disable-gpu'];
    const command = process.platform === 'linux' ? 'xvfb-run' : electronPath;
    const args = process.platform === 'linux' ? ['-a', electronPath, ...electronArgs] : electronArgs;
    const env: NodeJS.ProcessEnv = { ...process.env, OD_BASE_PROBE_URL_FILE: urlFile, OD_BASE_PROBE_ACTIVATION_FILE: join(probeDir, 'activation.txt') };
    delete env.ELECTRON_RUN_AS_NODE;
    const { stdout } = await execFileP(command, args, { env, timeout: ELECTRON_PROBE_TIMEOUT_MS });
    const marker = stdout.split(/\r?\n/).find((line) => line.startsWith('OD_BASE_PROBE:'));
    if (!marker) throw new Error(`Electron renderer probe returned no result: ${stdout}`);
    return parseBaseResolution(JSON.parse(marker.slice('OD_BASE_PROBE:'.length)));
  } finally {
    await rm(probeDir, { force: true, recursive: true });
  }
}

function parseBaseResolution(value: unknown): BaseResolution {
  if (
    typeof value !== 'object'
    || value === null
    || !('baseURI' in value)
    || typeof value.baseURI !== 'string'
    || !('compatMode' in value)
    || typeof value.compatMode !== 'string'
    || !('imageSrc' in value)
    || typeof value.imageSrc !== 'string'
    || !('stylesheetHref' in value)
    || typeof value.stylesheetHref !== 'string'
  ) {
    throw new Error('Electron renderer probe returned an invalid result');
  }
  return {
    baseURI: value.baseURI,
    compatMode: value.compatMode,
    ...('heading' in value && typeof value.heading === 'string' ? { heading: value.heading, hash: 'hash' in value ? String(value.hash) : '' } : {}),
    ...('headingColor' in value && typeof value.headingColor === 'string' ? { headingColor: value.headingColor } : {}),
    imageSrc: value.imageSrc,
    stylesheetHref: value.stylesheetHref,
  };
}
