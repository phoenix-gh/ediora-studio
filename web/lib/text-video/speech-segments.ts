import type {
  SpeechSplitMode,
  TextVideoParagraph,
  TextVideoProject,
} from '@/lib/api/text-videos'


function invalidateSpeech(
  segment: TextVideoParagraph,
  text: string,
): TextVideoParagraph {
  return {
    ...segment,
    text,
    status: 'draft',
    audio_url: '',
    duration: 0,
    word_timings: [],
    source_hash: '',
    generation_revision: segment.generation_revision + 1,
    error: '',
    job_id: null,
  }
}

function newSpeechSegment(id: string, text: string): TextVideoParagraph {
  return {
    id,
    text,
    status: 'draft',
    audio_url: '',
    duration: 0,
    word_timings: [],
    source_hash: '',
    generation_revision: 0,
    error: '',
    job_id: null,
  }
}

function staleUnlessMissing<T extends string>(status: T): T | 'stale' {
  return status === 'missing' ? status : 'stale'
}

function withDownstreamInvalidated(
  project: TextVideoProject,
  paragraphs: TextVideoParagraph[],
  speechSplitMode: SpeechSplitMode,
): TextVideoProject {
  return {
    ...project,
    status: 'draft',
    script: paragraphs.map(segment => segment.text).join(''),
    paragraphs,
    speech_split_mode: speechSplitMode,
    master_audio: {
      ...project.master_audio,
      status: staleUnlessMissing(project.master_audio.status),
      timeline_status: staleUnlessMissing(project.master_audio.timeline_status),
      error: '',
      timeline_error: '',
      job_id: null,
    },
    scene_plan: {
      ...project.scene_plan,
      status: staleUnlessMissing(project.scene_plan.status),
      error: '',
      job_id: null,
    },
    render_input: {
      ...project.render_input,
      audio: '',
    },
  }
}

function segmentIndex(project: TextVideoProject, segmentId: string): number {
  const index = project.paragraphs.findIndex(segment => segment.id === segmentId)
  if (index < 0) throw new Error('口播段落不存在')
  return index
}

function assertSpeakableSlice(text: string): void {
  if (!text.trim()) throw new Error('分段后不能只包含空白')
}

export function editSpeechSegment(
  project: TextVideoProject,
  segmentId: string,
  text: string,
): TextVideoProject {
  const index = segmentIndex(project, segmentId)
  if (project.paragraphs[index].text === text) return project

  const paragraphs = project.paragraphs.map((segment, currentIndex) => (
    currentIndex === index ? invalidateSpeech(segment, text) : segment
  ))
  return withDownstreamInvalidated(
    project,
    paragraphs,
    paragraphs.length === 1 ? 'single' : project.speech_split_mode,
  )
}

export function splitSpeechSegment(
  project: TextVideoProject,
  segmentId: string,
  cursor: number,
): TextVideoProject {
  const index = segmentIndex(project, segmentId)
  const segment = project.paragraphs[index]
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > segment.text.length) {
    throw new Error('分段位置无效')
  }

  const leftText = segment.text.slice(0, cursor)
  const rightText = segment.text.slice(cursor)
  assertSpeakableSlice(leftText)
  assertSpeakableSlice(rightText)

  const paragraphs = project.paragraphs.slice()
  paragraphs.splice(
    index,
    1,
    invalidateSpeech(segment, leftText),
    newSpeechSegment(crypto.randomUUID(), rightText),
  )
  return withDownstreamInvalidated(project, paragraphs, 'manual')
}

export function mergeSpeechSegment(
  project: TextVideoProject,
  segmentId: string,
  direction: 'previous' | 'next',
): TextVideoProject {
  const index = segmentIndex(project, segmentId)
  const adjacentIndex = direction === 'previous' ? index - 1 : index + 1
  if (adjacentIndex < 0 || adjacentIndex >= project.paragraphs.length) {
    throw new Error('没有可合并的相邻段落')
  }

  const leftIndex = Math.min(index, adjacentIndex)
  const rightIndex = Math.max(index, adjacentIndex)
  const left = project.paragraphs[leftIndex]
  const right = project.paragraphs[rightIndex]
  const merged = invalidateSpeech(left, left.text + right.text)
  const paragraphs = project.paragraphs.slice()
  paragraphs.splice(leftIndex, 2, merged)

  return withDownstreamInvalidated(
    project,
    paragraphs,
    paragraphs.length === 1 ? 'single' : 'manual',
  )
}

export function collapseToSingleSegment(
  project: TextVideoProject,
): TextVideoProject {
  if (project.paragraphs.length === 1) {
    return {
      ...project,
      speech_split_mode: 'single',
    }
  }
  if (project.paragraphs.length === 0) {
    throw new Error('口播段落不能为空')
  }

  const text = project.paragraphs.map(segment => segment.text).join('')
  const paragraph = invalidateSpeech(project.paragraphs[0], text)
  return withDownstreamInvalidated(project, [paragraph], 'single')
}

export function reorderSpeechSegment(
  project: TextVideoProject,
  segmentId: string,
  targetIndex: number,
): TextVideoProject {
  const index = segmentIndex(project, segmentId)
  if (
    !Number.isInteger(targetIndex)
    || targetIndex < 0
    || targetIndex >= project.paragraphs.length
  ) {
    throw new Error('目标段落位置无效')
  }
  if (index === targetIndex) return project

  const paragraphs = project.paragraphs.slice()
  const [segment] = paragraphs.splice(index, 1)
  paragraphs.splice(targetIndex, 0, segment)
  return withDownstreamInvalidated(project, paragraphs, 'manual')
}

export function applySpeechSplitProposal(
  project: TextVideoProject,
  proposal: {
    segments: Array<{ id: string; text: string }>
    speech_split_mode: 'auto'
  },
): TextVideoProject {
  const ids = new Set(proposal.segments.map(segment => segment.id))
  const reconstructed = proposal.segments.map(segment => segment.text).join('')
  if (
    proposal.segments.length === 0
    || ids.size !== proposal.segments.length
    || reconstructed !== project.script
  ) {
    throw new Error('AI 分段必须无损还原当前稿件')
  }
  proposal.segments.forEach(segment => assertSpeakableSlice(segment.text))
  const slicesUnchanged = (
    proposal.segments.length === project.paragraphs.length
    && proposal.segments.every((segment, index) => (
      segment.id === project.paragraphs[index].id
      && segment.text === project.paragraphs[index].text
    ))
  )
  if (slicesUnchanged) {
    return {
      ...project,
      speech_split_mode: 'auto',
    }
  }

  const currentById = new Map(
    project.paragraphs.map(segment => [segment.id, segment]),
  )
  const paragraphs = proposal.segments.map(segment => {
    const current = currentById.get(segment.id)
    if (current?.text === segment.text) return current
    return current
      ? invalidateSpeech(current, segment.text)
      : newSpeechSegment(segment.id, segment.text)
  })
  return withDownstreamInvalidated(project, paragraphs, 'auto')
}

export function estimateSpeechDuration(text: string): number {
  const speakableCharacters = Array.from(text).filter(character => (
    !/\s/u.test(character)
  )).length
  return Math.round(Math.max(0.5, speakableCharacters / 4.2) * 10) / 10
}
