import h3I2vTemplate from './workflows/h3-i2v-v1.json'
import h3I2vMeta from './workflows/h3-i2v-v1.meta.json'


export type WorkflowMeta = {
  workflow_version: string
  min_seconds: number
  max_seconds: number
  width: number
  height: number
  inputs: Record<string, string>
  output_node: string
}

export const H3_I2V_META = h3I2vMeta as WorkflowMeta


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


export function h3I2vPrompt(values: {
  image: string
  prompt: string
  duration: number
  seed: number
}) {
  return applyWorkflowInputs(
    h3I2vTemplate as Record<string, { inputs?: Record<string, unknown> }>,
    H3_I2V_META,
    values,
  )
}


export function buildShotPrompt(input: {
  framing: string
  spokenText: string
  motionPrompt?: string
}) {
  const framingLabel = input.framing === 'wide'
    ? 'wide shot'
    : input.framing === 'close'
      ? 'close-up'
      : 'medium shot'
  const motion = input.motionPrompt?.trim()
  return [
    'The same person from the first frame talks to camera.',
    'Keep identity, clothing, and background stable.',
    `Framing: ${framingLabel}.`,
    motion,
    `The person says: "${input.spokenText.trim()}"`,
    'Natural speech motion, no subtitles, no captions, no on-screen text.',
  ].filter(Boolean).join('\n')
}
