'use client'

import { Player } from '@remotion/player'

import { sceneFrameRange } from '@/lib/text-video/scene-range'
import type { TextVideoRenderInput, TextVideoSegment } from '@/remotion/contract'
import { TechTextV1Composition } from '@/remotion/templates/tech-text-v1/Composition'

export function RemotionPreview({
  input,
  selectedScene,
  previewAll,
}: {
  input: TextVideoRenderInput
  selectedScene: TextVideoSegment
  previewAll: boolean
}) {
  const lastFrame = Math.ceil(input.segments.at(-1)!.end * input.composition.fps) - 1
  const range = previewAll
    ? { inFrame: 0, outFrame: lastFrame }
    : sceneFrameRange(selectedScene, input.composition.fps)

  return (
    <Player
      component={TechTextV1Composition}
      inputProps={input}
      durationInFrames={lastFrame + 1}
      compositionWidth={input.composition.width}
      compositionHeight={input.composition.height}
      fps={input.composition.fps}
      inFrame={range.inFrame}
      outFrame={range.outFrame}
      controls
      loop
      acknowledgeRemotionLicense
      className="h-full w-full"
      style={{ width: '100%', height: '100%' }}
    />
  )
}
