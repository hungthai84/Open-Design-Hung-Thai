import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ browserWindow: vi.fn() }));

vi.mock('electron', () => ({ BrowserWindow: mocks.browserWindow, nativeImage: {} }));
vi.mock('../../src/main/pdf-export.js', () => ({
  waitForPrintableContent: vi.fn(async () => {}),
}));

import { renderDeckSlides } from '../../src/main/deck-capture.js';
import { frameFilePath, renderDeterministicFrames } from '../../src/main/frame-capture.js';

const realPlatform = process.platform;
const scratch: string[] = [];

afterEach(async () => {
  Object.defineProperty(process, 'platform', { configurable: true, value: realPlatform });
  vi.clearAllMocks();
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

function createRenderWindow() {
  return {
    destroy: vi.fn(),
    isDestroyed: vi.fn(() => false),
    loadURL: vi.fn(async () => {}),
    setContentSize: vi.fn(),
    setFocusable: vi.fn(),
    setHiddenInMissionControl: vi.fn(),
    setIgnoreMouseEvents: vi.fn(),
    setOpacity: vi.fn(),
    showInactive: vi.fn(),
    webContents: {
      debugger: {
        attach: vi.fn(),
        detach: vi.fn(),
        sendCommand: vi.fn(async (command: string) => command === 'Page.captureScreenshot'
          ? { data: Buffer.from('frame').toString('base64') }
          : {}),
      },
      executeJavaScript: vi.fn(async (source: string) => {
        if (source.includes('bridge.ready')) return { duration: 1, fps: 1, hasAudio: false };
        return 0;
      }),
      on: vi.fn(),
      once: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    },
  };
}

function expectNonInteractiveBeforeShow(window: ReturnType<typeof createRenderWindow>) {
  expect(window.showInactive).toHaveBeenCalledOnce();
  const shownAt = window.showInactive.mock.invocationCallOrder[0]!;
  for (const [method, value] of [
    [window.setOpacity, 0],
    [window.setIgnoreMouseEvents, true],
  ] as const) {
    expect(method).toHaveBeenCalledExactlyOnceWith(value);
    expect(method.mock.invocationCallOrder[0]).toBeLessThan(shownAt);
  }
  if (process.platform === 'darwin' || process.platform === 'win32') {
    expect(window.setFocusable).toHaveBeenCalledExactlyOnceWith(false);
    expect(window.setFocusable.mock.invocationCallOrder[0]).toBeLessThan(shownAt);
  } else {
    expect(window.setFocusable).not.toHaveBeenCalled();
  }
  if (process.platform === 'darwin') {
    expect(window.setHiddenInMissionControl).toHaveBeenCalledExactlyOnceWith(true);
    expect(window.setHiddenInMissionControl.mock.invocationCallOrder[0]).toBeLessThan(shownAt);
  } else {
    expect(window.setHiddenInMissionControl).not.toHaveBeenCalled();
  }
  expect(window.destroy).toHaveBeenCalledOnce();
}

describe.each(['darwin', 'win32', 'linux'] as const)('background exporters on %s', (platform) => {
  test('makes a slide renderer ignore desktop input before showing it, including on early return', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: platform });
    const window = createRenderWindow();
    mocks.browserWindow.mockImplementation(function BrowserWindowMock() { return window; });

    await expect(renderDeckSlides({ deck: true, html: '<main>No slides</main>' }))
      .resolves.toMatchObject({ errorCode: 'NO_SLIDES', ok: false });

    expectNonInteractiveBeforeShow(window);
  });

  test('captures and cleans up video frames while the render window ignores desktop input', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: platform });
    const outputDir = await mkdtemp(join(tmpdir(), 'od-background-render-'));
    scratch.push(outputDir);
    const window = createRenderWindow();
    mocks.browserWindow.mockImplementation(function BrowserWindowMock() { return window; });

    await expect(renderDeterministicFrames({
      height: 180, html: '<main></main>', outputDir, width: 320,
    })).resolves.toMatchObject({ frameCount: 1, ok: true });

    expectNonInteractiveBeforeShow(window);
    await expect(readFile(frameFilePath(outputDir, 0), 'utf8')).resolves.toBe('frame');
    expect(window.webContents.debugger.detach).toHaveBeenCalledOnce();
  });
});
