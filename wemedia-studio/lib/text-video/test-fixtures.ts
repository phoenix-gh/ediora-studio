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
  const value: ScenePlanDocument & { applied_job_id: number | null } = {
    status: 'missing',
    generation_revision: 0,
    master_source_hash: '',
    scenes: [],
    job_id: null,
    applied_job_id: null,
    error: '',
    ...overrides,
  }
  return value
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
    output_stale: false,
    render_state: {
      status: 'missing',
      generation: 0,
      source_hash: '',
      job_id: null,
      applied_job_id: null,
      asset_id: null,
      progress: 0,
      error: '',
    },
    revision: 1,
    duration: 0,
    aspect_ratio: '9:16',
    created_at: '2026-07-29T00:00:00Z',
    updated_at: '2026-07-29T00:00:00Z',
  }
  return { ...base, ...overrides }
}

export function makeVideoReadyProject(
  overrides: Partial<TextVideoProject> = {},
): TextVideoProject {
  const sourceHash = 'm'.repeat(64)
  const audioUrl = '/api/uploads/master.mp3'
  const wordTimings: GlobalWordTiming[] = [
    {
      id: 'word-1',
      text: '甲',
      start: 0,
      end: 0.7,
      speech_segment_id: 'speech-1',
    },
    {
      id: 'word-2',
      text: '乙',
      start: 0.8,
      end: 1.6,
      speech_segment_id: 'speech-1',
    },
    {
      id: 'word-3',
      text: '丙',
      start: 2,
      end: 2.8,
      speech_segment_id: 'speech-1',
    },
    {
      id: 'word-4',
      text: '丁',
      start: 3,
      end: 3.8,
      speech_segment_id: 'speech-1',
    },
  ]
  const scenes = [
    {
      id: 'scene-1',
      fromWordId: 'word-1',
      throughWordId: 'word-2',
      displayText: '甲乙',
      highlight: ['甲'],
      animation: 'fade-up',
    },
    {
      id: 'scene-2',
      fromWordId: 'word-3',
      throughWordId: 'word-4',
      displayText: '丙丁',
      highlight: ['丁'],
      animation: 'scale',
    },
  ]
  const project = makeTextVideoProject({
    stage: 'video',
    status: 'video_ready',
    script: '甲乙丙丁',
    paragraphs: [makeSpeechSegment('speech-1', '甲乙丙丁', {
      status: 'confirmed',
      audio_url: '/api/uploads/speech-1.mp3',
      duration: 4,
      source_hash: 's'.repeat(64),
    })],
    master_audio: makeMasterAudio({
      status: 'ready',
      timeline_status: 'ready',
      audio_url: audioUrl,
      duration: 4,
      source_hash: sourceHash,
      word_timings: wordTimings,
      timeline_source: 'provider',
    }),
    scene_plan: makeScenePlan({
      status: 'ready',
      generation_revision: 1,
      master_source_hash: sourceHash,
      scenes,
    }),
    render_input: makeRenderInput({
      audio: audioUrl,
      segments: [
        {
          id: 'scene-1',
          start: 0,
          end: 2,
          text: '甲乙',
          highlight: ['甲'],
          animation: 'fade-up',
        },
        {
          id: 'scene-2',
          start: 2,
          end: 4,
          text: '丙丁',
          highlight: ['丁'],
          animation: 'scale',
        },
      ],
    }),
    duration: 4,
  })
  return { ...project, ...overrides }
}
