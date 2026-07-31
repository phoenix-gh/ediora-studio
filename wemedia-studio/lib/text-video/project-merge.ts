import type {
  GlobalWordTiming,
  TextVideoParagraph,
  TextVideoProject,
  TextVideoVoiceSettings,
} from '@/lib/api/text-videos'
import { parseTextVideoRenderInput } from '@/remotion/contract'
import { CONTINUITY_EPSILON_SECONDS } from '@/remotion/types'

import { applyScenePlanToProject } from './scene-plan'


const voiceKeys = [
  'voice_id',
  'model',
  'speed',
  'volume',
  'pitch',
] as const

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function editableSlices(project: TextVideoProject) {
  return project.paragraphs.map(({ id, text }) => ({ id, text }))
}

function chooseEditable<T>(
  baseline: T,
  local: T,
  server: T,
): T {
  return equal(local, baseline) ? server : local
}

function mergeVoiceSettings(
  baseline: TextVideoVoiceSettings,
  local: TextVideoVoiceSettings,
  server: TextVideoVoiceSettings,
): TextVideoVoiceSettings {
  return Object.fromEntries(voiceKeys.map(key => [
    key,
    chooseEditable(baseline[key], local[key], server[key]),
  ])) as TextVideoVoiceSettings
}

function generatedState(segment: TextVideoParagraph) {
  const state: Partial<TextVideoParagraph> = { ...segment }
  delete state.id
  delete state.text
  return state
}

function chooseWorkerState<T>(
  baseline: T,
  local: T,
  server: T,
): T {
  if (equal(server, baseline) && !equal(local, baseline)) return local
  return server
}

function mergeGeneratedSegment(
  baseline: TextVideoParagraph | undefined,
  local: TextVideoParagraph,
  server: TextVideoParagraph | undefined,
  narrationSettingsChanged: boolean,
): TextVideoParagraph {
  const locallyInvalidated = Boolean(
    baseline
    && local.status === 'draft'
    && !local.audio_url
    && !local.source_hash
    && (
      local.generation_revision !== baseline.generation_revision
      || ['ready', 'confirmed'].includes(baseline.status)
    ),
  )
  if (
    !server
    || server.text !== local.text
    || narrationSettingsChanged
    || locallyInvalidated
  ) return local
  if (baseline) {
    const baselineState = generatedState(baseline)
    const localState = generatedState(local)
    const serverState = generatedState(server)
    if (
      equal(serverState, baselineState)
      && !equal(localState, baselineState)
    ) {
      return local
    }
    if (
      !equal(serverState, baselineState)
      && equal(localState, baselineState)
    ) {
      return {
        ...server,
        id: local.id,
        text: local.text,
      }
    }
    if (
      local.generation_revision === server.generation_revision
      && local.source_hash === server.source_hash
      && local.status === 'generating'
      && ['ready', 'confirmed', 'failed'].includes(server.status)
    ) {
      return {
        ...server,
        id: local.id,
        text: local.text,
      }
    }
    if (
      local.generation_revision > server.generation_revision
    ) return local
    if (
      local.generation_revision === server.generation_revision
      && local.source_hash === server.source_hash
      && local.job_id === null
      && server.job_id !== null
      && ['ready', 'confirmed', 'failed'].includes(local.status)
    ) return local
  }
  const localTextChanged = !baseline || baseline.text !== local.text
  if (
    localTextChanged
    && local.generation_revision !== server.generation_revision
  ) {
    return local
  }
  return {
    ...server,
    id: local.id,
    text: local.text,
  }
}

export function mergeWorkerProject(
  local: TextVideoProject,
  server: TextVideoProject,
  options: {
    editableBaseline: TextVideoProject
    localDirty: boolean
  },
): TextVideoProject {
  const baseline = options.editableBaseline
  const baselineSlices = editableSlices(baseline)
  const localSlices = editableSlices(local)
  const slicesChanged = !equal(localSlices, baselineSlices)
  const unacceptedLocalVoiceChange = (
    !equal(local.voice_settings, baseline.voice_settings)
    && !equal(local.voice_settings, server.voice_settings)
  )
  const localScenesChanged = !equal(
    local.scene_plan.scenes,
    baseline.scene_plan.scenes,
  )
  const localCompositionChanged = !equal(
    local.render_input.composition,
    baseline.render_input.composition,
  )
  const localTemplateChanged = !equal(
    {
      templateId: local.render_input.templateId,
      templateVersion: local.render_input.templateVersion,
      templateProps: local.render_input.templateProps,
    },
    {
      templateId: baseline.render_input.templateId,
      templateVersion: baseline.render_input.templateVersion,
      templateProps: baseline.render_input.templateProps,
    },
  )
  const paragraphSource = slicesChanged ? local.paragraphs : server.paragraphs
  const baselineById = new Map(
    baseline.paragraphs.map(segment => [segment.id, segment]),
  )
  const localById = new Map(
    local.paragraphs.map(segment => [segment.id, segment]),
  )
  const serverById = new Map(
    server.paragraphs.map(segment => [segment.id, segment]),
  )
  const paragraphs = paragraphSource.map(segment => {
    const localSegment = localById.get(segment.id) ?? segment
    return mergeGeneratedSegment(
      baselineById.get(segment.id),
      localSegment,
      serverById.get(segment.id),
      unacceptedLocalVoiceChange,
    )
  })
  const localSpeechWorkerWon = paragraphs.some(segment => {
    const serverSegment = serverById.get(segment.id)
    return (
      !serverSegment
      || !equal(generatedState(segment), generatedState(serverSegment))
    )
  })
  // Browser narration edits are persisted through the same response that
  // carries authoritative downstream invalidation. Preserve local downstream
  // state only when a newer speech worker state proves the server snapshot is
  // older (for example, a delayed master response after speech regeneration).
  const downstreamStateFromLocal = localSpeechWorkerWon

  const masterAudio = downstreamStateFromLocal
    ? local.master_audio
    : chooseWorkerState(
        baseline.master_audio,
        local.master_audio,
        server.master_audio,
      )
  const scenePlanBase = downstreamStateFromLocal
    ? local.scene_plan
    : chooseWorkerState(
        baseline.scene_plan,
        local.scene_plan,
        server.scene_plan,
      )
  const scenePlan = !downstreamStateFromLocal && localScenesChanged
    ? {
        ...scenePlanBase,
        scenes: local.scene_plan.scenes,
      }
    : scenePlanBase

  const renderInput = {
    ...server.render_input,
    templateId: localTemplateChanged
      ? local.render_input.templateId
      : server.render_input.templateId,
    templateVersion: localTemplateChanged
      ? local.render_input.templateVersion
      : server.render_input.templateVersion,
    templateProps: localTemplateChanged
      ? local.render_input.templateProps
      : server.render_input.templateProps,
    composition: localCompositionChanged
      ? local.render_input.composition
      : server.render_input.composition,
    segments: downstreamStateFromLocal
      ? local.render_input.segments
      : server.render_input.segments,
    audio: downstreamStateFromLocal
      ? local.render_input.audio
      : server.render_input.audio,
  }

  return {
    ...server,
    revision: Math.max(local.revision, server.revision),
    title: chooseEditable(baseline.title, local.title, server.title),
    stage: chooseEditable(baseline.stage, local.stage, server.stage),
    status: downstreamStateFromLocal ? local.status : server.status,
    script: slicesChanged ? local.script : server.script,
    paragraphs,
    speech_split_mode: paragraphs.length <= 1
      ? 'single'
      : chooseEditable(
          baseline.speech_split_mode,
          local.speech_split_mode,
          server.speech_split_mode,
        ),
    voice_settings: mergeVoiceSettings(
      baseline.voice_settings,
      local.voice_settings,
      server.voice_settings,
    ),
    master_audio: masterAudio,
    scene_plan: scenePlan,
    render_input: renderInput,
    aspect_ratio: localCompositionChanged
      ? local.aspect_ratio
      : server.aspect_ratio,
    duration: downstreamStateFromLocal ? local.duration : server.duration,
  }
}

export function updateProjectVoiceSettings(
  project: TextVideoProject,
  update: Partial<TextVideoVoiceSettings>,
): TextVideoProject {
  const voiceSettings = {
    ...project.voice_settings,
    ...update,
  }
  if (equal(voiceSettings, project.voice_settings)) return project

  const paragraphs = project.paragraphs.map(segment => ({
    ...segment,
    status: 'draft' as const,
    audio_url: '',
    duration: 0,
    word_timings: [],
    source_hash: '',
    generation_revision: segment.generation_revision + 1,
    error: '',
    job_id: null,
  }))
  const masterAudio = {
    ...project.master_audio,
    status: project.master_audio.status === 'missing'
      ? 'missing' as const
      : 'stale' as const,
    timeline_status: project.master_audio.timeline_status === 'missing'
      ? 'missing' as const
      : 'stale' as const,
    error: '',
    timeline_error: '',
    job_id: null,
  }
  const scenePlan = {
    ...project.scene_plan,
    status: project.scene_plan.status === 'missing'
      ? 'missing' as const
      : 'stale' as const,
    error: '',
    job_id: null,
  }

  return {
    ...project,
    status: 'draft',
    voice_settings: voiceSettings,
    paragraphs,
    master_audio: masterAudio,
    scene_plan: scenePlan,
    render_input: {
      ...project.render_input,
      audio: '',
    },
  }
}

export function canEnterVideoStage(project: TextVideoProject): boolean {
  const master = project.master_audio
  const speakable = project.paragraphs.filter(segment => segment.text.trim())
  if (
    !project.script.trim()
    || project.paragraphs.map(segment => segment.text).join('')
      !== project.script
    || speakable.length === 0
    || !speakable.every(segment => segment.status === 'confirmed')
    || master.status !== 'ready'
    || master.timeline_status !== 'ready'
    || !master.audio_url.trim()
    || !master.source_hash.trim()
    || !Number.isFinite(master.duration)
    || master.duration <= 0
    || !validMasterWords(master.word_timings, master.duration)
  ) {
    return false
  }
  return true
}

export function canPreviewVideo(project: TextVideoProject): boolean {
  try {
    if (!canEnterVideoStage(project)) return false
    const master = project.master_audio
    const scenePlan = project.scene_plan
    if (
      scenePlan.status !== 'ready'
      || scenePlan.master_source_hash !== master.source_hash
      || project.render_input.audio !== master.audio_url
    ) {
      return false
    }

    const expectedSegments = applyScenePlanToProject(
      project,
      scenePlan,
    ).render_input.segments
    const parsed = parseTextVideoRenderInput(project.render_input, {
      masterDuration: master.duration,
    })
    return equal(parsed.segments, expectedSegments)
  } catch {
    return false
  }
}

function validMasterWords(
  words: GlobalWordTiming[],
  duration: number,
): boolean {
  if (!Array.isArray(words) || words.length === 0) return false
  const ids = new Set<string>()
  let previousStart = -1
  let previousEnd = -1
  for (const word of words) {
    if (
      typeof word.id !== 'string'
      || !word.id.trim()
      || ids.has(word.id)
      || !Number.isFinite(word.start)
      || !Number.isFinite(word.end)
      || word.start < 0
      || word.end < word.start
      || word.start < previousStart
      || word.end < previousEnd
      || word.end > duration + CONTINUITY_EPSILON_SECONDS
    ) {
      return false
    }
    ids.add(word.id)
    previousStart = word.start
    previousEnd = word.end
  }
  return true
}
