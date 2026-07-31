export type KineticLayout = {
  safeInsetX: number
  safeInsetY: number
  fontSize: number
  lineHeight: number
  maxTextWidth: number
  blockAngle: number
  maxLines: 3
}

export function kineticLayout(
  width: number,
  height: number,
  visibleCharacters: number,
): KineticLayout {
  if (
    !Number.isFinite(width)
    || !Number.isFinite(height)
    || width <= 0
    || height <= 0
  ) {
    throw new Error('composition dimensions must be finite and positive')
  }
  const shorterSide = Math.min(width, height)
  const densityScale = visibleCharacters >= 19
    ? 0.7
    : visibleCharacters >= 9
      ? 0.84
      : 1
  const fontSize = Math.round(shorterSide * 0.12 * densityScale)
  const safeInsetX = Math.max(32, Math.round(width * 0.07))
  const safeInsetY = Math.max(32, Math.round(height * 0.055))

  return {
    safeInsetX,
    safeInsetY,
    fontSize,
    lineHeight: 0.98,
    maxTextWidth: width - safeInsetX * 2,
    blockAngle: width > height ? -2 : -4,
    maxLines: 3,
  }
}
