export function sceneFrameRange(
  scene: { start: number; end: number },
  fps: number,
) {
  if (
    !Number.isFinite(scene.start)
    || !Number.isFinite(scene.end)
    || scene.start < 0
    || scene.end <= scene.start
  ) {
    throw new Error('scene seconds must form a finite positive range')
  }
  if (!Number.isSafeInteger(fps) || fps <= 0) {
    throw new Error('fps must be a positive safe integer')
  }

  const inFrame = Math.ceil(scene.start * fps)
  const outFrame = Math.ceil(scene.end * fps) - 1
  if (
    !Number.isSafeInteger(inFrame)
    || !Number.isSafeInteger(outFrame)
    || inFrame > outFrame
  ) {
    throw new Error('scene does not contain a safe render frame')
  }
  return { inFrame, outFrame }
}
