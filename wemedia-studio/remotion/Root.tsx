import type { ComponentType } from 'react'
import { Composition } from 'remotion'

import { parseTextVideoRenderInputWithManifest } from './contract'
import { textVideoTemplates } from './registry'
import type {
  TextVideoRenderInput,
  TextVideoTemplateManifest,
} from './types'

type TemplateProps = Record<string, unknown>

export function createTextVideoDefaultRenderInput<
  P extends TemplateProps,
>(
  manifest: TextVideoTemplateManifest<P>,
): TextVideoRenderInput<P> {
  return {
    templateId: manifest.id,
    templateVersion: manifest.version,
    composition: { ...manifest.defaultComposition },
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

function createValidatedComposition<P extends TemplateProps>(
  manifest: TextVideoTemplateManifest<P>,
): ComponentType<TextVideoRenderInput> {
  const TemplateComponent = manifest.component

  return function ValidatedTextVideoComposition(
    props: TextVideoRenderInput,
  ) {
    const finalEnd = props.segments.at(-1)?.end
    if (finalEnd === undefined) {
      throw new Error('文字视频渲染契约错误：至少需要一个分镜')
    }
    const parsed = parseTextVideoRenderInputWithManifest(props, {
      masterDuration: finalEnd,
      manifest,
    })
    return <TemplateComponent {...parsed} />
  }
}

function createTextVideoCompositionRegistration<
  P extends TemplateProps,
>(
  manifest: TextVideoTemplateManifest<P>,
) {
  const typedDefaultProps = createTextVideoDefaultRenderInput(manifest)
  const defaultProps: TextVideoRenderInput = typedDefaultProps
  const duration = defaultProps.segments.at(-1)!.end
  parseTextVideoRenderInputWithManifest(defaultProps, {
    masterDuration: duration,
    manifest,
  })

  return {
    id: manifest.compositionId,
    component: createValidatedComposition(manifest),
    durationInFrames: Math.ceil(
      duration * defaultProps.composition.fps,
    ),
    fps: defaultProps.composition.fps,
    width: defaultProps.composition.width,
    height: defaultProps.composition.height,
    defaultProps,
    calculateMetadata: ({
      props,
    }: {
      props: TextVideoRenderInput
    }) => {
      const finalEnd = props.segments.at(-1)?.end
      if (finalEnd === undefined) {
        throw new Error('文字视频渲染契约错误：至少需要一个分镜')
      }
      const parsed = parseTextVideoRenderInputWithManifest(props, {
        masterDuration: finalEnd,
        manifest,
      })
      return {
        durationInFrames: Math.ceil(
          finalEnd * parsed.composition.fps,
        ),
        fps: parsed.composition.fps,
        width: parsed.composition.width,
        height: parsed.composition.height,
        props: parsed,
      }
    },
  }
}

type CheckedManifest<T> = T extends TextVideoTemplateManifest<
  infer P
>
  ? P extends TemplateProps
    ? T
    : never
  : never

type CheckedManifestTuple<T extends readonly unknown[]> = {
  readonly [K in keyof T]: CheckedManifest<T[K]>
}

function createErasedCompositionRegistration(manifest: unknown) {
  // The public tuple constraint proves every item is a typed manifest. This
  // one erasure point is guarded again by the manifest Zod schema before a
  // template component receives props.
  return createTextVideoCompositionRegistration(
    manifest as TextVideoTemplateManifest<TemplateProps>,
  )
}

export function createTextVideoCompositionRegistrations<
  const T extends readonly unknown[],
>(
  manifests: T & CheckedManifestTuple<T>,
) {
  return manifests.map(createErasedCompositionRegistration)
}

const registrations = createTextVideoCompositionRegistrations(
  textVideoTemplates,
)

export function RemotionRoot() {
  return (
    <>
      {registrations.map(registration => (
        <Composition
          key={registration.id}
          {...registration}
        />
      ))}
    </>
  )
}
