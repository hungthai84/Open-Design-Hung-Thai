import { describe, expect, it } from 'vitest';
import { injectMotionSourcePlayer, markMotionFrameRender } from '../src/runtime/motion-source-player';

describe('motion source player boundaries', () => {
  it('leaves ordinary documents and code samples unchanged', () => {
    for (const html of ['<html><body>Prototype</body></html>', '<html><body><script>const sample = \'<div data-composition-id="main">\';</script></body></html>']) {
      expect(injectMotionSourcePlayer(html)).toBe(html);
    }
  });
  it('installs once after author code, with render mode set before all scripts', () => {
    const source = '<!doctype html><html><head><meta name="od-motion-output" content="video"></head><body><div data-composition-id="main"></div><script>window.__timelines={};</script></body></html>';
    const result = injectMotionSourcePlayer(source);
    expect(result).toContain('data-od-motion-source-player');
    expect(injectMotionSourcePlayer(result)).toBe(result);
    const render = markMotionFrameRender(result);
    expect(render.indexOf('window.__odMotionRender=true')).toBeLessThan(render.indexOf('window.__timelines={}'));
  });
});

describe('autoplay mode boundary', () => {
  it('leaves unmarked HyperFrames and interactive compositions untouched', () => {
    const root = '<div data-composition-id="main"></div>';
    const legacy = injectMotionSourcePlayer(root);
    expect(legacy).toBe(root);
    const interactive = '<meta name="od-motion-output" content="interactive">' + root;
    expect(injectMotionSourcePlayer(interactive)).toBe(interactive);
    const video = injectMotionSourcePlayer('<meta content="video" name="od-motion-output">' + root);
    expect(video).toContain('window.__odMotionPlayer =');
    expect(video).not.toContain('id="play"');
  });
  it('does not replace an existing player in an unmarked legacy composition', () => {
    const source = '<main data-composition-id="main"></main><script data-od-motion-source-player>authorPlayer();</script>';
    expect(injectMotionSourcePlayer(source)).toBe(source);
  });
});

describe('motion audio contract isolation', () => {
  it('upgrades an existing host player without duplicating it', () => {
    const source = '<meta name="od-motion-output" content="video"><div data-composition-id="main"></div><script data-od-motion-source-player>oldPlayer();</script>';
    const result = injectMotionSourcePlayer(source);
    expect(result).not.toContain('oldPlayer');
    expect(result).toContain('data-od-motion-source-player="7"');
    expect(injectMotionSourcePlayer(result)).toBe(result);
  });
});

describe('motion player notices', () => {
  const video = '<meta name="od-motion-output" content="video"><div data-composition-id="main"></div>';
  it('ships English notices with Chinese only as a locale variant', () => {
    const result = injectMotionSourcePlayer(video);
    expect(result).toContain('Motion is not ready. Check the timeline or its dependency files.');
    expect(result).toContain('Click the video to turn on sound');
    expect(result).toContain("say('notReady')");
    expect(result).not.toContain("notice('动效未就绪");
  });
  it('upgrades a v6 player that still hardcodes Chinese notices', () => {
    const v6 = video + '<script data-od-motion-source-player="6">notice(\'动效未就绪\');</script>';
    expect(injectMotionSourcePlayer(v6)).toContain('data-od-motion-source-player="7"');
  });
});
