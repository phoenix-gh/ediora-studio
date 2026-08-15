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


export function buildShotPrompt(input: {
  framing: string
  spokenText: string
  motionPrompt?: string
}) {
  const framingLabel = FRAMING_LABEL[input.framing] || 'medium shot'
  const spoken = input.spokenText.trim()
  const motion = input.motionPrompt?.trim()
  const camera = input.framing === 'close'
    ? 'Very slow push-in. Eye-level. No shake.'
    : 'Static locked-off camera. Eye-level. No pan, tilt, or zoom.'
  const action = motion
    ? `${motion} `
    : ''
  return [
    'Video Description:',
    `<Subject 1> stands in <Background 1> and speaks to camera. ${action}He/she says, "${spoken}"`,
    "Uses <Audio 1>'s voice. No music. No on-screen text, captions, logos, or subtitles.",
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
