import h3Ref2vaTemplate from './workflows/h3-ref2va-v1.json'
import h3Ref2vaMeta from './workflows/h3-ref2va-v1.meta.json'


export type WorkflowMeta = {
  workflow_version: string
  min_seconds: number
  max_seconds: number
  width: number
  height: number
  inputs: Record<string, string>
  output_node: string
}

export const H3_REF2VA_META = h3Ref2vaMeta as WorkflowMeta


export function applyWorkflowInputs(
  template: Record<string, { inputs?: Record<string, unknown> }>,
  meta: WorkflowMeta,
  values: Record<string, unknown>,
) {
  const prompt = structuredClone(template)
  for (const [key, mapping] of Object.entries(meta.inputs)) {
    if (!(key in values)) continue
    const [nodeId, inputName] = mapping.split(':')
    const node = prompt[nodeId]
    if (!node?.inputs || !inputName) {
      throw new Error(`工作流缺少输入映射 ${mapping}`)
    }
    node.inputs[inputName] = values[key]
  }
  return prompt
}


export function h3Ref2vaPrompt(values: {
  image_1: string
  image_2: string
  image_3: string
  audio_1: string
  prompt: string
  duration: number
  seed: number
}) {
  return applyWorkflowInputs(
    h3Ref2vaTemplate as Record<string, { inputs?: Record<string, unknown> }>,
    H3_REF2VA_META,
    values,
  )
}


const FRAMING_LABEL: Record<string, string> = {
  wide: 'wide shot',
  medium: 'medium shot',
  close: 'close-up',
}

export const DEFAULT_DELIVERY =
  'calm tutorial host; warm assured emotion; medium conversational speaking rate; clear Mandarin'

export const DEFAULT_PRESENCE =
  'seated upright facing camera, torso still, slight head nods on clause ends, one-hand open-palm beat on key words, eyes on lens'

export const CHARS_PER_SECOND = 5


export function estimateShotSeconds(
  text: string,
  minSeconds: number,
  maxSeconds: number,
) {
  const chars = [...text].filter(char => !/\s/.test(char)).length
  if (chars <= 0) return minSeconds
  const guessed = Math.max(minSeconds, Math.ceil(chars / CHARS_PER_SECOND))
  return Math.min(maxSeconds, guessed)
}


export function effectiveDelivery(shotDelivery = '', baseDelivery = '') {
  return shotDelivery.trim() || baseDelivery.trim() || DEFAULT_DELIVERY
}


export function effectivePresence(shotPresence = '', basePresence = '') {
  return shotPresence.trim() || basePresence.trim() || DEFAULT_PRESENCE
}


export function dialogueLanguageTag(text: string) {
  return /[\u4e00-\u9fff]/.test(text) ? 'Chinese' : 'English'
}


export function buildShotPrompt(input: {
  framing: string
  spokenText: string
  motionPrompt?: string
  delivery?: string
  baseDelivery?: string
  presence?: string
  basePresence?: string
}) {
  const framingLabel = FRAMING_LABEL[input.framing] || 'medium shot'
  const spoken = input.spokenText.trim()
  const motion = input.motionPrompt?.trim()
  const tone = effectiveDelivery(input.delivery, input.baseDelivery)
  const performance = effectivePresence(input.presence, input.basePresence)
  const camera = input.framing === 'close'
    ? 'Very slow push-in. Eye-level. No shake.'
    : 'Static locked-off camera. Eye-level. No pan, tilt, or zoom.'
  const action = motion
    ? `${motion} `
    : ''
  const lang = dialogueLanguageTag(spoken)
  return [
    'Video Description:',
    `<Subject 1> faces the camera in <Background 1> and is already speaking. ${action}<Subject 1> (S1) talks with this exact emotion and cadence: ${tone}. Emotion, cadence, and speaking rate come from this prompt, not from <Audio 1>.`,
    `<Subject 1> (S1) says ONLY this quoted line and then stops: <d>[${lang}] ${spoken}</d>`,
    `Performance: ${performance}. Stay seated facing camera; gestures stay small and speech-synced; no standing up, walking, or waving.`,
    'Already talking at the first frame; no silent intro and no fade-in from a still pose.',
    'No extra words, no filler, no humming, and no invented syllables after the line ends.',
    'Exactly as the last word ends, lips meet, the jaw stops, and the talking pose holds in silence.',
    'Uses <Audio 1> only as voice timbre. Do not copy words, emotion, rhythm, or pace from <Audio 1>. No music. No on-screen text, captions, logos, or subtitles.',
    '',
    'Camera Movement:',
    camera,
    '',
    'Shot Type:',
    `${framingLabel}, 16:9.`,
    '',
    'Style:',
    'Clean studio presentation. Soft key from camera-left, natural skin texture.',
    '',
    'Subjects:',
    '<Subject 1> is the person in <Picture 1>, same face, hair, clothing, and body proportions.',
    '',
    'Background:',
    '<Background 1> is the environment in <Picture 2>, unchanged lighting and set dressing.',
  ].join('\n')
}
