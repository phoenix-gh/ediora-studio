import type {
  GlobalWordTiming,
  KineticMotionChunkDocument,
  KineticSceneMotionPlan,
  ScenePlanSceneDocument,
  TextVideoProject,
} from '@/lib/api/text-videos'

import { applyScenePlanToProject } from './scene-plan'

const MIN_CHUNK_CHARACTERS = 4
const MAX_CHUNK_CHARACTERS = 10
const BREAK_PUNCTUATION = /[。！？；，,.!?;]/u
const STRIP_FOR_MATCHING = /[\s。！？；，,.!?;]/gu
const IMPACT_PATTERN = /\d|没|不|却|但|其实|结果|关键|必须|只要/u

function fail(message: string): never {
  throw new Error(message)
}

function visibleLength(value: string) {
  return Array.from(value.replace(STRIP_FOR_MATCHING, '')).length
}

function normalized(value: string) {
  return value.replace(STRIP_FOR_MATCHING, '')
}

function splitDisplayText(displayText: string): string[] {
  if (!displayText.trim()) fail('scene display text must not be blank')

  const chunks: string[] = []
  let current = ''
  let currentVisible = 0
  for (const character of Array.from(displayText)) {
    current += character
    if (!/[\s。！？；，,.!?;]/u.test(character)) currentVisible += 1

    if (
      (BREAK_PUNCTUATION.test(character)
        && currentVisible >= MIN_CHUNK_CHARACTERS)
      || currentVisible >= MAX_CHUNK_CHARACTERS
    ) {
      chunks.push(current)
      current = ''
      currentVisible = 0
    }
  }
  if (current) chunks.push(current)

  if (
    chunks.length > 1
    && visibleLength(chunks[chunks.length - 1]) < MIN_CHUNK_CHARACTERS
  ) {
    const tail = chunks.pop()
    if (tail !== undefined) chunks[chunks.length - 1] += tail
  }
  return chunks
}

function sourceRange(
  scene: ScenePlanSceneDocument,
  words: GlobalWordTiming[],
) {
  const fromIndex = words.findIndex(word => word.id === scene.fromWordId)
  const throughIndex = words.findIndex(word => word.id === scene.throughWordId)
  if (fromIndex < 0 || throughIndex < fromIndex) {
    fail('scene word range is invalid')
  }
  const ids = new Set(words.map(word => word.id))
  if (ids.size !== words.length) fail('global word IDs must be unique')
  return { fromIndex, throughIndex }
}

function exactChunkBoundaries(
  slices: string[],
  sourceWords: GlobalWordTiming[],
): number[] | null {
  const boundaries: number[] = []
  let wordCursor = 0
  for (let index = 0; index < slices.length - 1; index += 1) {
    const target = normalized(slices[index])
    let collected = ''
    while (wordCursor < sourceWords.length && collected.length < target.length) {
      collected += normalized(sourceWords[wordCursor].text)
      wordCursor += 1
    }
    if (collected !== target || wordCursor === 0) return null
    boundaries.push(wordCursor)
  }
  return boundaries
}

function proportionalChunkBoundaries(
  slices: string[],
  sourceWordCount: number,
) {
  const lengths = slices.map(slice => Math.max(visibleLength(slice), 1))
  const totalLength = lengths.reduce((sum, length) => sum + length, 0)
  const boundaries: number[] = []
  let cumulativeLength = 0
  let previous = 0

  for (let index = 0; index < slices.length - 1; index += 1) {
    cumulativeLength += lengths[index]
    const remainingChunks = slices.length - index - 1
    const proposed = Math.round(
      cumulativeLength / totalLength * sourceWordCount,
    )
    const boundary = Math.min(
      sourceWordCount - remainingChunks,
      Math.max(previous + 1, proposed),
    )
    boundaries.push(boundary)
    previous = boundary
  }
  return boundaries
}

function motionChunk(
  scene: ScenePlanSceneDocument,
  displayText: string,
  sourceWords: GlobalWordTiming[],
  index: number,
): KineticMotionChunkDocument {
  const highlight = scene.highlight.filter(item => (
    item.trim().length > 0 && displayText.includes(item)
  ))
  const impact = highlight.length > 0 || IMPACT_PATTERN.test(displayText)
  const motionPreset = impact
    ? 'impact'
    : index > 0 && index % 3 === 2
      ? 'contrast'
      : 'reveal'

  return {
    id: `${scene.id}-chunk-${index + 1}`,
    fromWordId: sourceWords[0].id,
    throughWordId: sourceWords[sourceWords.length - 1].id,
    displayText,
    highlight,
    motionPreset,
    emphasis: impact ? 'punch' : 'normal',
  }
}

export function buildRuleMotionPlan(
  scene: ScenePlanSceneDocument,
  words: GlobalWordTiming[],
): KineticSceneMotionPlan {
  const { fromIndex, throughIndex } = sourceRange(scene, words)
  const sourceWords = words.slice(fromIndex, throughIndex + 1)
  const slices = splitDisplayText(scene.displayText)
  if (slices.length > sourceWords.length) {
    fail('motion chunks cannot outnumber source words')
  }

  const boundaries = exactChunkBoundaries(slices, sourceWords)
    ?? proportionalChunkBoundaries(slices, sourceWords.length)
  const chunks: KineticMotionChunkDocument[] = []
  let cursor = 0
  slices.forEach((slice, index) => {
    const boundary = index < boundaries.length
      ? boundaries[index]
      : sourceWords.length
    if (boundary <= cursor) fail('motion chunk must own at least one word')
    chunks.push(motionChunk(
      scene,
      slice,
      sourceWords.slice(cursor, boundary),
      index,
    ))
    cursor = boundary
  })

  return {
    transition: 'block-wipe',
    intensity: chunks.some(chunk => chunk.motionPreset === 'impact')
      ? 0.8
      : 0.65,
    chunks,
  }
}

function advancedRevision(project: TextVideoProject) {
  const revision = project.scene_plan.generation_revision
  if (
    !Number.isSafeInteger(revision)
    || revision < 0
    || revision === Number.MAX_SAFE_INTEGER
  ) {
    fail('scene generation revision cannot be advanced')
  }
  return revision + 1
}

function cloneMotion(motion: KineticSceneMotionPlan): KineticSceneMotionPlan {
  return {
    ...motion,
    chunks: motion.chunks.map(chunk => ({
      ...chunk,
      highlight: [...chunk.highlight],
    })),
  }
}

export function applyRuleMotionPlan(
  project: TextVideoProject,
  sceneIds?: readonly string[],
): TextVideoProject {
  if (project.scene_plan.status !== 'ready') {
    fail('only a ready scene plan can be edited')
  }
  const selected = sceneIds ? new Set(sceneIds) : null
  if (selected && selected.size !== sceneIds?.length) {
    fail('selected scene IDs must be unique')
  }

  const found = new Set<string>()
  const isKineticV2 = (
    project.render_input.templateId === 'kinetic-punch-v2'
    && project.render_input.templateVersion === 1
  )
  const scenes = project.scene_plan.scenes.map(scene => {
    if (selected && !selected.has(scene.id)) return scene
    found.add(scene.id)
    const motion = buildRuleMotionPlan(
      scene,
      project.master_audio.word_timings,
    )
    return {
      ...scene,
      animation: isKineticV2
        ? motion.chunks[0].motionPreset
        : scene.animation,
      motion,
    }
  })
  if (selected && found.size !== selected.size) {
    fail('selected scene does not exist')
  }

  const scenePlan = {
    ...project.scene_plan,
    applied_job_id: null,
    generation_revision: advancedRevision(project),
    scenes,
    job_id: null,
    error: '',
  }
  return applyScenePlanToProject(project, scenePlan)
}

export function editSceneMotion(
  project: TextVideoProject,
  sceneId: string,
  motion: KineticSceneMotionPlan,
): TextVideoProject {
  if (project.scene_plan.status !== 'ready') {
    fail('only a ready scene plan can be edited')
  }
  const matches = project.scene_plan.scenes
    .map((scene, index) => ({ scene, index }))
    .filter(({ scene }) => scene.id === sceneId)
  if (matches.length !== 1) fail('scene does not exist exactly once')

  const scenes = [...project.scene_plan.scenes]
  scenes[matches[0].index] = {
    ...matches[0].scene,
    motion: cloneMotion(motion),
  }
  const scenePlan = {
    ...project.scene_plan,
    applied_job_id: null,
    generation_revision: advancedRevision(project),
    scenes,
    job_id: null,
    error: '',
  }
  return applyScenePlanToProject(project, scenePlan)
}
