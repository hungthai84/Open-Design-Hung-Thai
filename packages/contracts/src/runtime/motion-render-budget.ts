/** Maximum Electron capture time for an actual video-motion export. */
export const MOTION_FRAME_CAPTURE_MAX_TIMEOUT_MS = 30 * 60 * 1_000;

/** Allow slow, progressing frame capture without changing the authored FPS. */
export function motionFrameCaptureTimeoutMs(frameCount: number): number {
  if (!Number.isSafeInteger(frameCount) || frameCount < 1) {
    throw new RangeError('frameCount must be a positive safe integer');
  }
  return Math.min(MOTION_FRAME_CAPTURE_MAX_TIMEOUT_MS, Math.max(300_000, 180_000 + frameCount * 2_000));
}
