/** SMPTE-style timecode (HH:MM:SS:FF) for a time in seconds at a frame rate. */
export function timecode(sec: number, fps: number): string {
  const total = Math.max(0, Math.round(sec * fps));
  const f = total % fps;
  const s = Math.floor(total / fps);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(f)}`;
}
