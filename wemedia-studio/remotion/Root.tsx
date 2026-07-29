import { Composition } from 'remotion'

import { TEXT_VIDEO_FIXTURE } from '../lib/text-video/fixture'
import type { TextVideoRenderInput } from './contract'
import { TechTextV1Composition } from './templates/tech-text-v1/Composition'
import { TECH_TEXT_V1_ID } from './templates/tech-text-v1/manifest'

const defaultProps = TEXT_VIDEO_FIXTURE.renderInput

export function RemotionRoot() {
  return (
    <Composition
      id={TECH_TEXT_V1_ID}
      component={TechTextV1Composition}
      durationInFrames={Math.ceil(defaultProps.segments.at(-1)!.end * defaultProps.composition.fps)}
      fps={defaultProps.composition.fps}
      width={defaultProps.composition.width}
      height={defaultProps.composition.height}
      defaultProps={defaultProps}
      calculateMetadata={({ props }: { props: TextVideoRenderInput }) => ({
        durationInFrames: Math.ceil(props.segments.at(-1)!.end * props.composition.fps),
        fps: props.composition.fps,
        width: props.composition.width,
        height: props.composition.height,
      })}
    />
  )
}
