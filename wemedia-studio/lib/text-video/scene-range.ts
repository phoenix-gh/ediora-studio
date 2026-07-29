export function sceneFrameRange(
  scene: { start: number; end: number },
  fps: number,
) {
  return {
    inFrame: Math.ceil(scene.start * fps),
    outFrame: Math.ceil(scene.end * fps) - 1,
  }
}
