'use client'

import type { ComponentType } from 'react'
import { Player } from '@remotion/player'

import { creativeAssetUrl } from '@/lib/api/assets'
import type { TextVideoProject } from '@/lib/api/text-videos'
import { canPreviewVideo } from '@/lib/text-video/project-merge'
import { sceneFrameRange } from '@/lib/text-video/scene-range'
import {
  parseTextVideoRenderInput,
  type TextVideoRenderInput,
} from '@/remotion/contract'
import { resolveTextVideoTemplate } from '@/remotion/registry'


export function RemotionPreview({
  project,
  selectedSceneId,
  previewAll,
}: {
  project: TextVideoProject
  selectedSceneId: string
  previewAll: boolean
}) {
  const sceneState = project.scene_plan.status
  if (sceneState === 'missing') {
    return <PreviewState>分镜尚未生成</PreviewState>
  }
  if (sceneState === 'generating') {
    return <PreviewState>AI 正在生成分镜…</PreviewState>
  }
  if (sceneState === 'stale') {
    return <PreviewState>主音频已更新，请重新校准分镜</PreviewState>
  }
  if (sceneState === 'failed') {
    return (
      <PreviewState alert>
        {project.scene_plan.error || '分镜生成失败'}
      </PreviewState>
    )
  }

  const prepared = preparePreview(project, selectedSceneId, previewAll)
  if (!prepared.ready) {
    return (
      <PreviewState alert>
        预览数据无效：{prepared.error}
      </PreviewState>
    )
  }

  return (
    <div data-testid="remotion-preview" className="h-full w-full">
      <Player
        component={prepared.component}
        inputProps={prepared.inputProps}
        durationInFrames={prepared.durationInFrames}
        compositionWidth={prepared.inputProps.composition.width}
        compositionHeight={prepared.inputProps.composition.height}
        fps={prepared.inputProps.composition.fps}
        inFrame={prepared.inFrame}
        outFrame={prepared.outFrame}
        controls
        loop
        acknowledgeRemotionLicense
        className="h-full w-full"
        style={{ width: '100%', height: '100%' }}
      />
    </div>
  )
}

function preparePreview(
  project: TextVideoProject,
  selectedSceneId: string,
  previewAll: boolean,
): {
  ready: true
  component: ComponentType<TextVideoRenderInput>
  inputProps: TextVideoRenderInput
  durationInFrames: number
  inFrame: number
  outFrame: number
} | {
  ready: false
  error: string
} {
  try {
    const persisted = parseTextVideoRenderInput(project.render_input, {
      masterDuration: project.master_audio.duration,
    })
    if (!canPreviewVideo(project)) {
      throw new Error('分镜投影与当前主音频不一致')
    }
    const manifest = resolveTextVideoTemplate(
      persisted.templateId,
      persisted.templateVersion,
    )
    const selected = persisted.segments.find(
      scene => scene.id === selectedSceneId,
    ) ?? persisted.segments[0]
    if (!selected) throw new Error('没有可预览的分镜')

    const lastFrame = (
      Math.ceil(
        project.master_audio.duration * persisted.composition.fps,
      ) - 1
    )
    if (!Number.isSafeInteger(lastFrame) || lastFrame < 0) {
      throw new Error('主音频无法换算为安全帧区间')
    }
    const range = previewAll
      ? { inFrame: 0, outFrame: lastFrame }
      : sceneFrameRange(selected, persisted.composition.fps)
    const inputProps = {
      ...persisted,
      audio: creativeAssetUrl(project.master_audio.audio_url),
    }

    return {
      ready: true,
      component: manifest.component as ComponentType<TextVideoRenderInput>,
      inputProps,
      durationInFrames: lastFrame + 1,
      inFrame: range.inFrame,
      outFrame: range.outFrame,
    }
  } catch (error) {
    return {
      ready: false,
      error: error instanceof Error ? error.message : '未知错误',
    }
  }
}

function PreviewState({
  alert = false,
  children,
}: {
  alert?: boolean
  children: React.ReactNode
}) {
  return (
    <div
      role={alert ? 'alert' : 'status'}
      className="flex h-full min-h-64 w-full items-center justify-center rounded-xl border border-dashed border-white/15 bg-[#030711] px-8 text-center text-sm text-slate-300"
    >
      {children}
    </div>
  )
}
