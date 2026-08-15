import type {
  GlobalWordTiming,
  ScenePlanDocument,
  ScenePlanSceneDocument,
  TextVideoProject,
} from '@/lib/api/text-videos'
import { resolveTextVideoTemplate } from '@/remotion/registry'
import { CONTINUITY_EPSILON_SECONDS } from '@/remotion/types'

import { sceneFrameRange } from './scene-range'

type SceneRange = {
  scene: ScenePlanSceneDocument
  sceneIndex: number
  fromIndex: number
  throughIndex: number
}

type SceneIdFactory = () => string

export type SceneEditTiming = {
  masterDuration: number
  fps: number
}

function fail(message: string): never {
  throw new Error(message)
}

function wordIndexById(words: GlobalWordTiming[]) {
  if (words.length === 0) fail('word timeline must not be empty')

  const indexes = new Map<string, number>()
  let previousStart = -1
  let previousEnd = -1
  words.forEach((word, index) => {
    if (
      typeof word.id !== 'string'
      || !word.id.trim()
      || indexes.has(word.id)
      || typeof word.text !== 'string'
      || !Number.isFinite(word.start)
      || !Number.isFinite(word.end)
      || word.start < 0
      || word.end < word.start
      || word.start < previousStart
      || word.end < previousEnd
    ) {
      fail('invalid global word timeline')
    }
    indexes.set(word.id, index)
    previousStart = word.start
    previousEnd = word.end
  })
  return indexes
}

function sceneRanges(
  plan: ScenePlanDocument,
  words: GlobalWordTiming[],
): SceneRange[] {
  const wordIndexes = wordIndexById(words)
  if (plan.scenes.length === 0) fail('scene plan must not be empty')

  const sceneIds = new Set<string>()
  let cursor = 0
  const ranges = plan.scenes.map((item, sceneIndex) => {
    const fromIndex = wordIndexes.get(item.fromWordId)
    const throughIndex = wordIndexes.get(item.throughWordId)
    if (
      typeof item.id !== 'string'
      || !item.id.trim()
      || sceneIds.has(item.id)
      || fromIndex === undefined
      || throughIndex === undefined
      || fromIndex !== cursor
      || throughIndex < fromIndex
    ) {
      fail('scene word ranges must be complete, unique, and ordered')
    }
    sceneIds.add(item.id)
    cursor = throughIndex + 1
    return {
      scene: item,
      sceneIndex,
      fromIndex,
      throughIndex,
    }
  })

  if (cursor !== words.length) {
    fail('scene word ranges must cover every word exactly once')
  }
  return ranges
}

function assertProjectableSceneRanges(
  plan: ScenePlanDocument,
  words: GlobalWordTiming[],
  timing: SceneEditTiming,
) {
  if (
    !Number.isFinite(timing.masterDuration)
    || timing.masterDuration <= 0
  ) {
    fail('master duration must be finite and positive')
  }
  const ranges = sceneRanges(plan, words)
  for (const word of words) {
    if (
      word.end
      > timing.masterDuration + CONTINUITY_EPSILON_SECONDS
    ) {
      fail('global word timeline must stay inside the master audio')
    }
  }

  const boundaries = [
    0,
    ...ranges.slice(1).map(range => words[range.fromIndex].start),
    timing.masterDuration,
  ]
  for (let index = 0; index < ranges.length; index += 1) {
    sceneFrameRange({
      start: boundaries[index],
      end: boundaries[index + 1],
    }, timing.fps)
  }
}

function ensureEditablePlan(plan: ScenePlanDocument) {
  if (plan.status !== 'ready') {
    fail('only a ready scene plan can be edited')
  }
}

function advancedRevision(plan: ScenePlanDocument) {
  if (
    !Number.isSafeInteger(plan.generation_revision)
    || plan.generation_revision < 0
    || plan.generation_revision === Number.MAX_SAFE_INTEGER
  ) {
    fail('scene generation revision cannot be advanced')
  }
  return plan.generation_revision + 1
}

function exactDisplayText(
  words: GlobalWordTiming[],
  fromIndex: number,
  throughIndex: number,
) {
  const displayText = words
    .slice(fromIndex, throughIndex + 1)
    .map(word => word.text)
    .join('')
  if (!displayText.trim()) fail('scene display text must not be blank')
  return displayText
}

function retainedHighlights(highlight: string[], displayText: string) {
  if (!Array.isArray(highlight)) return []
  return highlight.filter(item => (
    typeof item === 'string'
    && item.trim().length > 0
    && displayText.includes(item)
  ))
}

function normalizedCueText(value: string) {
  return value.replace(/\s/gu, '')
}

function highlightedCueIndexes(
  words: GlobalWordTiming[],
  highlights: string[],
) {
  const source = words.map(word => normalizedCueText(word.text))
  const offsets: Array<{ start: number; end: number }> = []
  let cursor = 0
  for (const text of source) {
    offsets.push({ start: cursor, end: cursor + text.length })
    cursor += text.length
  }
  const joined = source.join('')
  const indexes = new Set<number>()
  for (const rawHighlight of highlights) {
    const highlight = normalizedCueText(rawHighlight)
    if (!highlight) continue
    let match = joined.indexOf(highlight)
    while (match >= 0) {
      const matchEnd = match + highlight.length
      offsets.forEach((offset, index) => {
        if (offset.start < matchEnd && offset.end > match) indexes.add(index)
      })
      match = joined.indexOf(highlight, match + 1)
    }
  }
  return indexes
}

function sceneWithRange(
  item: ScenePlanSceneDocument,
  words: GlobalWordTiming[],
  fromIndex: number,
  throughIndex: number,
): ScenePlanSceneDocument {
  const displayText = exactDisplayText(words, fromIndex, throughIndex)
  const sceneWithoutMotion = { ...item }
  delete sceneWithoutMotion.motion
  return {
    ...sceneWithoutMotion,
    fromWordId: words[fromIndex].id,
    throughWordId: words[throughIndex].id,
    displayText,
    highlight: retainedHighlights(item.highlight, displayText),
  }
}

function defaultSceneId(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    fail('crypto.randomUUID is unavailable')
  }
  return globalThis.crypto.randomUUID()
}

function changedPlan(
  plan: ScenePlanDocument,
  scenes: ScenePlanSceneDocument[],
  words: GlobalWordTiming[],
  timing: SceneEditTiming,
) {
  const next = {
    ...plan,
    applied_job_id: null,
    generation_revision: advancedRevision(plan),
    scenes,
    job_id: null,
    error: '',
  }
  assertProjectableSceneRanges(next, words, timing)
  return next
}

export function sceneWordIds(
  plan: ScenePlanDocument,
  words: GlobalWordTiming[],
): string[] {
  return sceneRanges(plan, words).flatMap(({ fromIndex, throughIndex }) => (
    words.slice(fromIndex, throughIndex + 1).map(word => word.id)
  ))
}

export function splitSceneAtWord(
  plan: ScenePlanDocument,
  words: GlobalWordTiming[],
  timing: SceneEditTiming,
  sceneId: string,
  firstWordIdOfRightScene: string,
  createSceneId: SceneIdFactory = defaultSceneId,
): ScenePlanDocument {
  ensureEditablePlan(plan)
  const ranges = sceneRanges(plan, words)
  const target = ranges.find(range => range.scene.id === sceneId)
  if (!target) fail('scene does not exist')

  const boundaryIndex = words.findIndex(
    word => word.id === firstWordIdOfRightScene,
  )
  if (
    boundaryIndex <= target.fromIndex
    || boundaryIndex > target.throughIndex
  ) {
    fail('split word must leave both scenes non-empty')
  }

  const rightId = createSceneId()
  if (
    typeof rightId !== 'string'
    || !rightId.trim()
    || plan.scenes.some(item => item.id === rightId)
  ) {
    fail('new scene ID must be non-blank and unique')
  }

  const left = sceneWithRange(
    target.scene,
    words,
    target.fromIndex,
    boundaryIndex - 1,
  )
  const right = sceneWithRange(
    { ...target.scene, id: rightId },
    words,
    boundaryIndex,
    target.throughIndex,
  )
  const scenes = [
    ...plan.scenes.slice(0, target.sceneIndex),
    left,
    right,
    ...plan.scenes.slice(target.sceneIndex + 1),
  ]
  return changedPlan(plan, scenes, words, timing)
}

export function mergeScene(
  plan: ScenePlanDocument,
  words: GlobalWordTiming[],
  timing: SceneEditTiming,
  sceneId: string,
  direction: 'previous' | 'next',
): ScenePlanDocument {
  ensureEditablePlan(plan)
  if (direction !== 'previous' && direction !== 'next') {
    fail('merge direction must be previous or next')
  }

  const ranges = sceneRanges(plan, words)
  const targetIndex = ranges.findIndex(range => range.scene.id === sceneId)
  if (targetIndex < 0) fail('scene does not exist')

  const leftIndex = direction === 'previous' ? targetIndex - 1 : targetIndex
  const rightIndex = leftIndex + 1
  if (leftIndex < 0 || rightIndex >= ranges.length) {
    fail('scene has no neighbor in the requested direction')
  }

  const left = ranges[leftIndex]
  const right = ranges[rightIndex]
  const merged = sceneWithRange(
    left.scene,
    words,
    left.fromIndex,
    right.throughIndex,
  )
  const scenes = [
    ...plan.scenes.slice(0, leftIndex),
    merged,
    ...plan.scenes.slice(rightIndex + 1),
  ]
  return changedPlan(plan, scenes, words, timing)
}

export function moveSceneBoundary(
  plan: ScenePlanDocument,
  words: GlobalWordTiming[],
  timing: SceneEditTiming,
  leftSceneId: string,
  direction: 'backward' | 'forward',
  wordCount: number,
): ScenePlanDocument {
  ensureEditablePlan(plan)
  if (direction !== 'backward' && direction !== 'forward') {
    fail('boundary direction must be backward or forward')
  }
  if (!Number.isSafeInteger(wordCount) || wordCount <= 0) {
    fail('word count must be a positive safe integer')
  }

  const ranges = sceneRanges(plan, words)
  const leftIndex = ranges.findIndex(range => range.scene.id === leftSceneId)
  if (leftIndex < 0) fail('scene does not exist')
  if (leftIndex === ranges.length - 1) {
    fail('the final scene has no following boundary')
  }

  const left = ranges[leftIndex]
  const right = ranges[leftIndex + 1]
  const nextThroughIndex = direction === 'forward'
    ? left.throughIndex + wordCount
    : left.throughIndex - wordCount
  if (
    nextThroughIndex < left.fromIndex
    || nextThroughIndex >= right.throughIndex
  ) {
    fail('boundary move would leave an empty scene')
  }

  const nextLeft = sceneWithRange(
    left.scene,
    words,
    left.fromIndex,
    nextThroughIndex,
  )
  const nextRight = sceneWithRange(
    right.scene,
    words,
    nextThroughIndex + 1,
    right.throughIndex,
  )
  const scenes = [...plan.scenes]
  scenes[leftIndex] = nextLeft
  scenes[leftIndex + 1] = nextRight
  return changedPlan(plan, scenes, words, timing)
}

function validateVisualUpdate(
  update: Pick<
    ScenePlanSceneDocument,
    'displayText' | 'highlight' | 'animation'
  >,
) {
  if (
    typeof update.displayText !== 'string'
    || !update.displayText.trim()
    || typeof update.animation !== 'string'
    || !update.animation.trim()
    || !Array.isArray(update.highlight)
  ) {
    fail('scene visual update is invalid')
  }

  const seen = new Set<string>()
  for (const item of update.highlight) {
    if (
      typeof item !== 'string'
      || !item.trim()
      || seen.has(item)
      || !update.displayText.includes(item)
    ) {
      fail('every highlight must occur exactly once in display text')
    }
    seen.add(item)
  }
}

function sameStrings(left: string[], right: string[]) {
  return left.length === right.length
    && left.every((item, index) => item === right[index])
}

export function editSceneVisuals(
  project: TextVideoProject,
  sceneId: string,
  update: Pick<
    ScenePlanSceneDocument,
    'displayText' | 'highlight' | 'animation'
  >,
): TextVideoProject {
  ensureEditablePlan(project.scene_plan)
  assertProjectableSceneRanges(
    project.scene_plan,
    project.master_audio.word_timings,
    {
      masterDuration: project.master_audio.duration,
      fps: project.render_input.composition.fps,
    },
  )
  validateVisualUpdate(update)
  const manifest = resolveTextVideoTemplate(
    project.render_input.templateId,
    project.render_input.templateVersion,
  )
  if (!(manifest.animations as readonly string[]).includes(update.animation)) {
    fail(`scene animation is not supported: ${update.animation}`)
  }

  const sceneMatches = project.scene_plan.scenes
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.id === sceneId)
  const renderMatches = project.render_input.segments
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.id === sceneId)
  if (sceneMatches.length !== 1) fail('scene does not exist exactly once')
  if (renderMatches.length !== 1) {
    fail('render segment must match the scene exactly once')
  }

  const sceneMatch = sceneMatches[0]
  const renderMatch = renderMatches[0]
  const sceneUnchanged = (
    sceneMatch.item.displayText === update.displayText
    && sceneMatch.item.animation === update.animation
    && sameStrings(sceneMatch.item.highlight, update.highlight)
  )
  const renderUnchanged = (
    renderMatch.item.text === update.displayText
    && renderMatch.item.animation === update.animation
    && sameStrings(renderMatch.item.highlight, update.highlight)
  )
  if (sceneUnchanged && renderUnchanged) return project

  const highlights = [...update.highlight]
  const contentChanged = (
    sceneMatch.item.displayText !== update.displayText
    || !sameStrings(sceneMatch.item.highlight, update.highlight)
  )
  const { motion: _motion, ...sceneWithoutMotion } = sceneMatch.item
  const scenes = [...project.scene_plan.scenes]
  scenes[sceneMatch.index] = {
    ...(contentChanged ? sceneWithoutMotion : sceneMatch.item),
    displayText: update.displayText,
    highlight: highlights,
    animation: update.animation,
  }
  const renderWithoutMotion = {
    ...renderMatch.item,
  } as Record<string, unknown>
  delete renderWithoutMotion.transition
  delete renderWithoutMotion.intensity
  delete renderWithoutMotion.chunks
  const segments = [...project.render_input.segments]
  segments[renderMatch.index] = {
    ...(contentChanged ? renderWithoutMotion : renderMatch.item),
    text: update.displayText,
    highlight: [...highlights],
    animation: update.animation,
  }
  const nextScenePlan = {
    ...project.scene_plan,
    applied_job_id: null,
    generation_revision: advancedRevision(project.scene_plan),
    scenes,
    job_id: null,
    error: '',
  }

  return {
    ...project,
    scene_plan: nextScenePlan,
    render_input: {
      ...project.render_input,
      segments,
    },
  }
}

export function applyScenePlanToProject(
  project: TextVideoProject,
  plan: ScenePlanDocument,
): TextVideoProject {
  ensureEditablePlan(plan)
  const master = project.master_audio
  if (
    master.status !== 'ready'
    || master.timeline_status !== 'ready'
    || !master.audio_url.trim()
    || !master.source_hash.trim()
    || plan.master_source_hash !== master.source_hash
  ) {
    fail('scene plan must match the ready master audio timeline')
  }

  const timing = {
    masterDuration: master.duration,
    fps: project.render_input.composition.fps,
  }
  assertProjectableSceneRanges(plan, master.word_timings, timing)
  const manifest = resolveTextVideoTemplate(
    project.render_input.templateId,
    project.render_input.templateVersion,
  )
  for (const item of plan.scenes) {
    validateVisualUpdate(item)
    if (!(manifest.animations as readonly string[]).includes(item.animation)) {
      fail(`scene animation is not supported: ${item.animation}`)
    }
  }

  const ranges = sceneRanges(plan, master.word_timings)
  const segments = ranges.map(({ scene, fromIndex }, index) => {
    const following = ranges[index + 1]
    const start = index === 0 ? 0 : master.word_timings[fromIndex].start
    const end = following
      ? master.word_timings[following.fromIndex].start
      : master.duration
    return {
      id: scene.id,
      start,
      end,
      text: scene.displayText,
      highlight: [...scene.highlight],
      animation: scene.animation,
    }
  })

  return {
    ...project,
    scene_plan: plan,
    render_input: {
      ...project.render_input,
      audio: master.audio_url,
      segments,
    },
  }
}
