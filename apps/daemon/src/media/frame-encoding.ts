import { spawn } from 'node:child_process';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';

export function encodeFramesMp4(
  framePattern: string,
  fps: number,
  outputPath: string,
): Promise<void> {
  const ffmpegPath = process.env.HYPERFRAMES_FFMPEG_PATH?.trim() || ffmpegInstaller.path;
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      ffmpegPath,
      [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-framerate',
        String(fps),
        '-start_number',
        '0',
        '-i',
        framePattern,
        '-vf',
        'pad=ceil(iw/2)*2:ceil(ih/2)*2',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        outputPath,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('FFmpeg encoding timed out after 5 minutes'));
    }, 5 * 60 * 1000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      reject(new Error(
        `FFmpeg encoding failed (${signal ? `signal ${signal}` : `exit ${String(code)}`}): ${stderr.trim()}`,
      ));
    });
  });
}
