import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Image size and thumbnails via macOS `sips` (built in, no dependency).
// Falls back gracefully when sips is unavailable.

export function imageSize(file: string): [number, number] | null {
  try {
    const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { encoding: 'utf8' });
    const w = /pixelWidth:\s*(\d+)/.exec(out), h = /pixelHeight:\s*(\d+)/.exec(out);
    return w && h ? [Number(w[1]), Number(h[1])] : null;
  } catch { return null; }
}

export const THUMB_W = 640;

// Writes a JPEG thumbnail next to the asset; returns its file name or undefined.
export function makeThumb(file: string, pw: number): string | undefined {
  if (pw <= THUMB_W * 1.4) return undefined;
  const out = file.replace(/\.[^.]+$/, '') + '.thumb.jpg';
  try {
    execFileSync('sips', ['--resampleWidth', String(THUMB_W), '-s', 'format', 'jpeg', '-s', 'formatOptions', '80', file, '--out', out], { stdio: 'ignore' });
    return path.basename(out);
  } catch { return undefined; }
}
