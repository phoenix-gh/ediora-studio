import type { TextVideoRenderInput } from '@/remotion/contract'

export type SpeechParagraphStatus = 'confirmed' | 'ready' | 'draft'

export type SpeechParagraph = {
  id: string
  text: string
  duration: number
  status: SpeechParagraphStatus
}

export type TextVideoFixtureProject = {
  id: string
  title: string
  description: string
  script: string
  voiceName: string
  paragraphs: SpeechParagraph[]
  renderInput: TextVideoRenderInput
}

const paragraphs: SpeechParagraph[] = [
  { id: 'paragraph-1', text: '做 AI 视频的，一个月没赚到钱。', duration: 2.7, status: 'confirmed' },
  { id: 'paragraph-2', text: '问题可能不是工具，而是你还在从画面开始。', duration: 3.5, status: 'confirmed' },
  { id: 'paragraph-3', text: '真正高效的流程，是先让声音确定节奏。', duration: 3.2, status: 'confirmed' },
  { id: 'paragraph-4', text: '再把每句话拆成清晰、可读的视觉场景。', duration: 3.3, status: 'confirmed' },
  { id: 'paragraph-5', text: '模板负责稳定风格，AI 负责导演创意。', duration: 3.1, status: 'confirmed' },
  { id: 'paragraph-6', text: '你可以强调关键词，也可以调整分镜节奏。', duration: 3.2, status: 'confirmed' },
  { id: 'paragraph-7', text: '试听确认以后，再交给 Remotion 合成。', duration: 3.1, status: 'confirmed' },
  { id: 'paragraph-8', text: '这样，每一次修改都可控，也能持续复用。', duration: 3.2, status: 'confirmed' },
]

const renderInput: TextVideoRenderInput = {
  templateId: 'tech-text-v1',
  templateVersion: 1,
  composition: { width: 1080, height: 1920, fps: 30 },
  audio: '',
  segments: [
    { id: 'scene-1', start: 0, end: 2.7, text: '做 AI 视频的\n一个月没赚到钱', highlight: ['没赚到钱'], animation: 'fade-up' },
    { id: 'scene-2', start: 2.7, end: 6.2, text: '问题不在工具\n而在起点', highlight: ['起点'], animation: 'scale' },
    { id: 'scene-3', start: 6.2, end: 9.4, text: '先让声音\n确定节奏', highlight: ['声音', '节奏'], animation: 'fade-up' },
    { id: 'scene-4', start: 9.4, end: 12.7, text: '把每句话\n变成视觉场景', highlight: ['视觉场景'], animation: 'scale' },
    { id: 'scene-5', start: 12.7, end: 15.8, text: '模板稳定风格\nAI 导演创意', highlight: ['AI'], animation: 'fade-up' },
    { id: 'scene-6', start: 15.8, end: 19, text: '强调关键词\n调整分镜节奏', highlight: ['关键词'], animation: 'scale' },
    { id: 'scene-7', start: 19, end: 22.1, text: '试听确认\n再进行合成', highlight: ['试听确认'], animation: 'fade-up' },
    { id: 'scene-8', start: 22.1, end: 25.3, text: '每次修改都可控\n每套模板可复用', highlight: ['可控', '复用'], animation: 'scale' },
  ],
  templateProps: {
    theme: 'tech-blue',
    font: 'source-han-sans',
    background: 'dark-grid',
    transition: 'soft-push',
    textDensity: 'standard',
  },
}

export const TEXT_VIDEO_FIXTURE: TextVideoFixtureProject = {
  id: 'demo-text-video',
  title: 'AI 视频创作，不要从画面开始',
  description: '演示项目 · 所有音频段已确认',
  script: paragraphs.map(paragraph => paragraph.text).join('\n\n'),
  voiceName: '林晓 · 清晰叙事',
  paragraphs,
  renderInput,
}

export const TEXT_VIDEO_INCOMPLETE_FIXTURE: TextVideoFixtureProject = {
  ...TEXT_VIDEO_FIXTURE,
  id: 'demo-text-video-incomplete',
  description: '演示项目 · 尚有 2 段音频待确认',
  paragraphs: paragraphs.map((paragraph, index) => ({
    ...paragraph,
    status: index < 6 ? 'confirmed' : 'ready',
  })),
}
