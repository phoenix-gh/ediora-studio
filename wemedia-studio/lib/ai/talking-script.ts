import { z } from 'zod'


export const talkingScriptRequestSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('generate'),
    topic: z.string().trim().min(1).max(10_000),
    instructions: z.string().trim().max(4_000).optional(),
  }),
  z.object({
    mode: z.literal('convert_draft'),
    draftId: z.number().int().positive(),
    instructions: z.string().trim().max(4_000).optional(),
  }),
  z.object({
    mode: z.literal('rewrite'),
    script: z.string().trim().min(1).max(60_000),
    instructions: z.string().trim().min(1).max(4_000),
  }),
])


export type TalkingScriptRequest = z.infer<typeof talkingScriptRequestSchema>


type SourceDraft = { title: string; content: string }


const sharedRules = [
  '只返回最终可直接口播的文本，不要解释创作过程。',
  '使用自然口语，句子长短适合真人连续朗读。',
  '保留输入中已经核实的事实、数字、专有名词和因果关系；不要编造新事实。',
  '不要输出 Markdown 标题、链接、列表符号、代码块、舞台指令或镜头指令。',
  '不要触发视频生成、发布、保存草稿或任何外部操作。',
].join('\n')


export function buildTalkingScriptPrompt(
  input: TalkingScriptRequest,
  draft?: SourceDraft,
) {
  if (input.mode === 'generate') {
    return `${sharedRules}

任务：围绕下面的主题创作一篇完整口播脚本。
主题：
${input.topic}
${input.instructions ? `\n额外要求：\n${input.instructions}` : ''}`
  }
  if (input.mode === 'rewrite') {
    return `${sharedRules}

任务：按要求改写下面的口播脚本。保留原脚本事实，只调整表达、结构与节奏。
改写要求：
${input.instructions}

原口播脚本：
${input.script}`
  }
  if (!draft) throw new Error('转换草稿时缺少原稿')
  return `${sharedRules}

任务：把下面的文章草稿转换为自然口语的完整口播脚本。保留原文事实和核心观点，去掉仅适合阅读的格式、链接与引用标记。
${input.instructions ? `额外要求：\n${input.instructions}\n\n` : ''}原稿标题：
${draft.title}

原稿正文：
${draft.content}`
}


export function cleanTalkingScript(text: string) {
  return text
    .trim()
    .replace(/^```(?:markdown|md|text)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))+\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .trim()
}
