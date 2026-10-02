/**
 * Screen demo timing: steps spread evenly through the scene. The wide shot of the product holds
 * first (the camera's first move starts after it), and when the camera pulls back at the end there
 * is time to do so before the next scene's transition (`tailFrames`).
 */
export const DEMO_FIRST_STEP_SEC = 1.8;
export const DEMO_STEP_GAP_SEC = 1.0;
export function spaceDemoSteps(count: number, durationFrames: number, fps: number, zoomOut = true, tailFrames = 0): number[] {
  if (count <= 0) return [];
  const first = Math.round(DEMO_FIRST_STEP_SEC * fps);
  const last = Math.max(first, durationFrames - tailFrames - Math.round((zoomOut ? 1.9 : 0.8) * fps));
  if (count === 1) return [Math.min(last, Math.max(first, Math.round(durationFrames * 0.4)))];
  return Array.from({ length: count }, (_, i) => Math.round(first + ((last - first) * i) / (count - 1)));
}

/** How many steps fit a scene at about one a second. */
export function maxDemoSteps(durationFrames: number, fps: number, zoomOut = true, tailFrames = 0): number {
  const span = (durationFrames - tailFrames) / fps - DEMO_FIRST_STEP_SEC - (zoomOut ? 1.9 : 0.8);
  return Math.max(1, Math.min(5, Math.floor(span / DEMO_STEP_GAP_SEC) + 1));
}

/** Frames at the end of a scene covered by the next scene's transition. */
export function demoTail(doc: { scenes: { id: string; transitionIn: { type: string; durationFrames: number } }[] }, sceneId: string): number {
  const i = doc.scenes.findIndex((s) => s.id === sceneId);
  const next = doc.scenes[i + 1];
  return next && next.transitionIn.type !== "cut" ? next.transitionIn.durationFrames : 0;
}
