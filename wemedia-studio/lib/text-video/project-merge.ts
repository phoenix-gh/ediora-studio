import type {
  TextVideoParagraph,
  TextVideoProject,
  TextVideoVoiceSettings,
} from '@/lib/api/text-videos'


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
  const { id: _id, text: _text, ...state } = segment
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
  const scriptChanged = local.script !== baseline.script
  const voiceChanged = !equal(local.voice_settings, baseline.voice_settings)
  const localGenerationInvalidated = local.paragraphs.some(segment => {
    const prior = baseline.paragraphs.find(item => item.id === segment.id)
    if (!prior) return true
    return (
      segment.status === 'draft'
      && !segment.audio_url
      && !segment.source_hash
      && (
        segment.generation_revision !== prior.generation_revision
        || ['ready', 'confirmed'].includes(prior.status)
      )
    )
  })
  const narrationChanged = (
    slicesChanged
    || scriptChanged
    || voiceChanged
    || localGenerationInvalidated
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
  const localRenderScenesChanged = !equal(
    local.render_input.segments,
    baseline.render_input.segments,
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
      voiceChanged,
    )
  })
  const localSpeechWorkerWon = paragraphs.some(segment => {
    const serverSegment = serverById.get(segment.id)
    return (
      !serverSegment
      || !equal(generatedState(segment), generatedState(serverSegment))
    )
  })
  const downstreamStateFromLocal = (
    narrationChanged
    || localSpeechWorkerWon
  )

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
    segments: downstreamStateFromLocal || localRenderScenesChanged
      ? local.render_input.segments
      : chooseWorkerState(
          baseline.render_input.segments,
          local.render_input.segments,
          server.render_input.segments,
        ),
    audio: downstreamStateFromLocal
      ? local.render_input.audio
      : chooseWorkerState(
          baseline.render_input.audio,
          local.render_input.audio,
          server.render_input.audio,
        ),
  }

  return {
    ...server,
    revision: Math.max(local.revision, server.revision),
    title: chooseEditable(baseline.title, local.title, server.title),
    stage: chooseEditable(baseline.stage, local.stage, server.stage),
    status: downstreamStateFromLocal ? local.status : server.status,
    script: slicesChanged || scriptChanged ? local.script : server.script,
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
  const speakable = project.paragraphs.filter(segment => segment.text.trim())
  return Boolean(
    speakable.length > 0
    && speakable.every(segment => segment.status === 'confirmed')
    && project.master_audio.status === 'ready'
    && project.master_audio.timeline_status === 'ready'
    && project.master_audio.audio_url.trim()
    && project.render_input.audio.trim(),
  )
}
