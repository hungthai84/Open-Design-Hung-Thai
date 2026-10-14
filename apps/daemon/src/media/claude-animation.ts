import { createRequire } from 'node:module';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { load } from 'cheerio';
import type { DesktopRenderFramesInput, DesktopRenderFramesResult } from '@open-design/sidecar-proto';
import { encodeFramesMp4 } from './frame-encoding.js';

const require = createRequire(import.meta.url);
type FrameRenderer = (input: DesktopRenderFramesInput) => Promise<DesktopRenderFramesResult>;

export function assertClaudeAnimationOptions(input: { length?: number | undefined; aspect?: string | undefined }): void {
  if (input.length !== undefined && input.length !== 5) {
    throw new Error('Hand-painted Animation currently supports exactly 5 seconds');
  }
  if (input.aspect && input.aspect !== '16:9') {
    throw new Error('Hand-painted Animation currently supports only 16:9');
  }
}

/** Connect the pinned p5 engine to the existing desktop ready/seek protocol.
 * The daemon supplies the runtime; project HTML contains only scene code.
 */
export async function claudeAnimationDocument(sourceHtml: string, resourceRoot: string): Promise<string> {
  const $ = load(sourceHtml);
  if ($('audio,video').length > 0) throw new Error('Hand-painted Animation currently supports silent video only');
  const canvas = $('canvas#out');
  if (canvas.length !== 1) throw new Error('Animation index.html must contain one canvas with id="out"');
  canvas.attr({ width: '1920', height: '1080' });
  const p5Root = path.dirname(path.dirname(require.resolve('p5')));
  const brushScript = require.resolve('p5.brush');
  const engineRoot = path.join(process.env.OD_RESOURCE_ROOT?.trim() || resourceRoot, 'design-templates', 'claude-animation', 'assets', 'runtime');
  const scripts = await Promise.all([
    readFile(path.join(p5Root, 'lib', 'p5.min.js'), 'utf8'),
    readFile(brushScript, 'utf8'),
    ...['core.js', 'timeline.js'].map((file) => readFile(path.join(engineRoot, file), 'utf8')),
  ]);
  const script = (text: string) => `<script>${text.replace(/<\/script/gi, '<\\/script')}</script>`;
  $('head').prepend(
    script("window.__odAnimationError = null; addEventListener('error', e => { window.__odAnimationError = e.message || 'Animation script failed'; });")
    + scripts.slice(0, 2).map(script).join('')
    + script('const PROJECT = { duration: 5, bpm: 120, offset: 0 };')
    + scripts.slice(2).map(script).join('')
    // Upstream studio has a scrubber. The capture document is canvas-only.
    + script('devUI = () => {}; placeholder = () => { throw new Error("Animation must register a scene with shots()"); };'),
  );
  $('head').append('<style>html,body{margin:0;padding:0;width:1920px;height:1080px;overflow:hidden}body>*:not(#out){display:none!important}#out{display:block;width:1920px!important;height:1080px!important}.p5Canvas{display:none!important}</style>');
  $('body').append(script(`
window.__odFrameRenderer = {
  async ready() {
    const deadline = Date.now() + 45000;
    while (window.ready !== true) {
      if (window.__odAnimationError) throw new Error(window.__odAnimationError);
      if (Date.now() > deadline) throw new Error('Animation runtime was not ready after 45 seconds');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (PROJECT.audio) throw new Error('Hand-painted Animation supports silent video only');
    if (PROJECT.duration !== 5) throw new Error('Animation duration must be 5 seconds');
    if (window.__odAnimationError) throw new Error(window.__odAnimationError);
    return { duration: 5, fps: 24 };
  },
  async seek(timeSeconds) {
    await window.renderAt(timeSeconds);
    if (window.__odAnimationError) throw new Error(window.__odAnimationError);
  }
};`));
  return $.html();
}

export async function renderClaudeAnimation(input: {
  resourceRoot: string;
  projectDir: string;
  compositionDir: string | null;
  desktopFrameRenderer: FrameRenderer | null;
  onProgress?: ((message: string) => void) | undefined;
}): Promise<{ bytes: Buffer; providerNote: string }> {
  if (!input.compositionDir?.trim() || path.isAbsolute(input.compositionDir)) {
    throw new Error('Animation requires --composition-dir <directory inside the project>');
  }
  const projectDir = await realpath(input.projectDir);
  const compositionDir = await realpath(path.resolve(projectDir, input.compositionDir));
  const inside = (file: string) => file.startsWith(projectDir + path.sep);
  if (!inside(compositionDir)) throw new Error('Animation composition must stay inside the project');
  const entry = await realpath(path.join(compositionDir, 'index.html'));
  if (!inside(entry)) throw new Error('Animation index.html must stay inside the project');
  const html = await claudeAnimationDocument(await readFile(entry, 'utf8'), input.resourceRoot);
  if (!input.desktopFrameRenderer) {
    throw new Error('Open Design desktop frame renderer is unavailable. Open the desktop client and try again.');
  }
  const scratch = await mkdtemp(path.join(compositionDir, '.render-'));
  try {
    input.onProgress?.('Rendering 120 animation frames with the bundled Electron Chromium…');
    const frames = await input.desktopFrameRenderer({
      html, baseHref: pathToFileURL(`${compositionDir}${path.sep}`).href,
      width: 1920, height: 1080, fps: 24, outputDir: path.join(scratch, 'frames'),
    });
    if (!frames.ok) throw new Error(frames.error || 'Animation frame capture failed');
    if (!frames.framePattern || frames.frameCount !== 120 || frames.fps !== 24
      || frames.width !== 1920 || frames.height !== 1080) {
      throw new Error('Animation renderer must produce 120 frames at 1920×1080 and 24 fps');
    }
    input.onProgress?.('Encoding the 5-second silent MP4…');
    const output = path.join(scratch, 'animation.mp4');
    await encodeFramesMp4(frames.framePattern, frames.fps, output);
    return { bytes: await readFile(output), providerNote: 'claude-animation/electron-p5 · 5s · 16:9 · silent' };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
