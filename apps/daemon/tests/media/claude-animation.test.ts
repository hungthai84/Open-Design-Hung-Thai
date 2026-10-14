import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateMedia } from '../../src/media/index.js';

describe('Claude Animation local media delivery', () => {
  let root: string;
  let projectsRoot: string;
  const compositionDir = '.claude-animation-cache/test';

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'od-animation-test-'));
    projectsRoot = path.join(root, 'projects');
    await mkdir(path.join(projectsRoot, 'project-1', compositionDir), { recursive: true });
    await writeFile(path.join(projectsRoot, 'project-1', compositionDir, 'index.html'),
      '<!doctype html><canvas id="out"></canvas><script>shots([[0,()=>{}]]);</script>');
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  const request = () => ({
    projectRoot: path.resolve(import.meta.dirname, '../../../..'), projectsRoot, projectId: 'project-1',
    surface: 'video' as const, model: 'claude-animation-p5',
    output: 'animation.mp4', compositionDir, length: 5, aspect: '16:9',
  });

  it('requires the desktop renderer instead of returning a placeholder', async () => {
    vi.stubEnv('OD_MEDIA_ALLOW_STUBS', '1');
    await expect(generateMedia(request())).rejects.toThrow(/desktop frame renderer is unavailable/i);
  });

  it('rejects unsupported length and aspect before rendering', async () => {
    await expect(generateMedia({ ...request(), length: 10 })).rejects.toThrow(/5 seconds/);
    await expect(generateMedia({ ...request(), aspect: '9:16' })).rejects.toThrow(/16:9/);
  });

  it('rejects compositions that escape the project through a symlink', async () => {
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await symlink(outside, path.join(projectsRoot, 'project-1', 'escape'));
    await expect(generateMedia({ ...request(), compositionDir: 'escape' }))
      .rejects.toThrow(/inside the project/);
  });

  it('rejects audio instead of silently dropping it', async () => {
    await writeFile(path.join(projectsRoot, 'project-1', compositionDir, 'index.html'),
      '<canvas id="out"></canvas><audio src="voice.mp3"></audio>');
    await expect(generateMedia(request())).rejects.toThrow(/silent/);
  });

  it('keeps capture failures visible even when development stubs are enabled', async () => {
    vi.stubEnv('OD_MEDIA_ALLOW_STUBS', '1');
    await expect(generateMedia({
      ...request(),
      desktopFrameRenderer: async () => ({ ok: false, error: 'scene failed while drawing frame 12' }),
    })).rejects.toThrow('scene failed while drawing frame 12');
  });

  it('refuses incomplete frames instead of encoding a shorter deliverable', async () => {
    await expect(generateMedia({
      ...request(),
      desktopFrameRenderer: async () => ({
        ok: true, framePattern: 'frame-%08d.png', frameCount: 119,
        fps: 24, width: 1920, height: 1080,
      }),
    })).rejects.toThrow(/120 frames/);
  });
});
