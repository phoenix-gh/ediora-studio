import type {
  GlobalWordTiming,
  MasterAudioDocument,
  ScenePlanDocument,
  TextVideoParagraph,
  TextVideoProject,
} from '@/lib/api/text-videos'
import type { TextVideoRenderInput } from '@/remotion/types'


export function makeSpeechSegment(
  id: string,
  text: string,
  overrides: Partial<TextVideoParagraph> = {},
): TextVideoParagraph {
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
    ...overrides,
  }
}

export function makeMasterAudio(
  overrides: Partial<MasterAudioDocument> = {},
): MasterAudioDocument {
  return {
    status: 'missing',
    timeline_status: 'missing',
    audio_url: '',
    duration: 0,
    source_hash: '',
    word_timings: [],
    timeline_source: '',
    error: '',
    timeline_error: '',
    job_id: null,
    ...overrides,
  }
}

export function makeScenePlan(
  overrides: Partial<ScenePlanDocument> = {},
): ScenePlanDocument {
  return {
    status: 'missing',
    generation_revision: 0,
    master_source_hash: '',
    scenes: [],
    job_id: null,
    applied_job_id: null,
    error: '',
    ...overrides,
  }
}

export function makeRenderInput(
  overrides: Partial<TextVideoRenderInput> = {},
): TextVideoRenderInput {
  return {
    templateId: 'tech-text-v1',
    templateVersion: 1,
    composition: { width: 1080, height: 1920, fps: 30 },
    audio: '',
    segments: [{
      id: 'scene-1',
      start: 0,
      end: 2.4,
      text: '在这里输入稿件',
      highlight: [],
      animation: 'fade-up',
    }],
    templateProps: {
      theme: 'tech-blue',
      font: 'source-han-sans',
      background: 'dark-grid',
      transition: 'soft-push',
      textDensity: 'standard',
    },
    ...overrides,
  }
}

export function makeGlobalWords(
  words: string[] = ['做', 'AI', '视频'],
  speechSegmentId = 'segment-1',
): GlobalWordTiming[] {
  return words.map((text, index) => ({
    id: `word-${index + 1}`,
    text,
    start: index * 0.4,
    end: (index + 1) * 0.4,
    speech_segment_id: speechSegmentId,
  }))
}

export function makeTextVideoProject(
  overrides: Partial<TextVideoProject> = {},
): TextVideoProject {
  const base: TextVideoProject = {
    id: 1,
    title: '测试文字视频',
    status: 'draft',
    stage: 'script',
    script: '',
    voice_settings: {
      voice_id: 'mimo_default',
      model: 'mimo-v2.5-tts',
      speed: 1,
      volume: 1,
      pitch: 0,
    },
    paragraphs: [makeSpeechSegment('segment-1', '')],
    speech_split_mode: 'single',
    master_audio: makeMasterAudio(),
    scene_plan: makeScenePlan(),
    render_input: makeRenderInput(),
    cover_asset_url: '',
    output_asset_url: '',
    revision: 1,
    duration: 0,
    aspect_ratio: '9:16',
    created_at: '2026-07-29T00:00:00Z',
    updated_at: '2026-07-29T00:00:00Z',
  }
  return { ...base, ...overrides }
}
