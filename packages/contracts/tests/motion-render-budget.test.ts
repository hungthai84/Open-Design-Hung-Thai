import { describe, expect, it } from 'vitest';
import { motionFrameCaptureTimeoutMs, MOTION_FRAME_CAPTURE_MAX_TIMEOUT_MS } from '../src/runtime/motion-render-budget.js';

describe('video motion frame capture budget', () => {
  it('allows the reported slow 600-frame film while keeping short exports bounded', () => {
    expect(motionFrameCaptureTimeoutMs(600)).toBeGreaterThan(600 * 1_700);
    expect(motionFrameCaptureTimeoutMs(1)).toBe(300_000);
    expect(motionFrameCaptureTimeoutMs(1_000_000)).toBe(MOTION_FRAME_CAPTURE_MAX_TIMEOUT_MS);
    expect(MOTION_FRAME_CAPTURE_MAX_TIMEOUT_MS).toBe(1_800_000);
  });
  it.each([0, -1, NaN, Infinity, 1.5])('rejects invalid frame count %s', count => {
    expect(() => motionFrameCaptureTimeoutMs(count)).toThrow(RangeError);
  });
});
