import { Composition } from 'remotion'

import { parseTextVideoRenderInput } from './contract'
import { textVideoTemplates } from './registry'
import type {
  TextVideoRenderInput,
  TextVideoTemplateManifest,
} from './types'

function defaultRenderInput<P>(
  manifest: TextVideoTemplateManifest<P>,
): TextVideoRenderInput<P> {
  return {
    templateId: manifest.id,
    templateVersion: manifest.version,
    composition: { width: 1080, height: 1920, fps: 30 },
    audio: '',
    segments: [{
      id: 'scene-1',
      start: 0,
      end: 2.4,
      text: '在这里输入稿件',
      highlight: [],
      animation: manifest.animations[0],
    }],
    templateProps: manifest.defaults,
  }
}

function RegisteredComposition<P>({
  manifest,
}: {
  manifest: TextVideoTemplateManifest<P>
}) {
  const defaultProps = defaultRenderInput(manifest)
  const duration = defaultProps.segments.at(-1)!.end
  parseTextVideoRenderInput(defaultProps, { masterDuration: duration })

  return (
    <Composition
      id={manifest.compositionId}
      component={manifest.component}
      durationInFrames={Math.ceil(duration * defaultProps.composition.fps)}
      fps={defaultProps.composition.fps}
      width={defaultProps.composition.width}
      height={defaultProps.composition.height}
      defaultProps={defaultProps}
      calculateMetadata={({ props }) => {
        const finalEnd = props.segments.at(-1)?.end
        if (finalEnd === undefined) {
          throw new Error('文字视频渲染契约错误：至少需要一个分镜')
        }
        const parsed = parseTextVideoRenderInput(props, {
          masterDuration: finalEnd,
        })
        return {
          durationInFrames: Math.ceil(
            finalEnd * parsed.composition.fps,
          ),
          fps: parsed.composition.fps,
          width: parsed.composition.width,
          height: parsed.composition.height,
        }
      }}
    />
  )
}

export function RemotionRoot() {
  return (
    <>
      {textVideoTemplates.map(manifest => (
        <RegisteredComposition
          key={`${manifest.id}@${manifest.version}`}
          manifest={manifest}
        />
      ))}
    </>
  )
}
