import { describe, expect, it } from 'vitest'

import type { TextVideoProject } from '@/lib/api/text-videos'

import {
  makeGlobalWords,
  makeMasterAudio,
  makeRenderInput,
  makeScenePlan,
  makeSpeechSegment,
  makeTextVideoProject,
} from './test-fixtures'
import {
  canEnterVideoStage,
  canPreviewVideo,
  mergeWorkerProject,
  updateProjectVoiceSettings,
} from './project-merge'
import {
  editSpeechSegment,
  reorderSpeechSegment,
} from './speech-segments'


const canonicalScenes = [{
  id: 'scene-1',
  fromWordId: 'word-1',
  throughWordId: 'word-2',
  displayText: '甲乙',
  highlight: ['甲'],
  animation: 'fade-up',
}]

function makeVideoReadyProject(): TextVideoProject {
  const sourceHash = 'm'.repeat(64)
  const audioUrl = '/api/uploads/master.mp3'
  return makeTextVideoProject({
    script: '甲乙',
    paragraphs: [makeSpeechSegment('a', '甲乙', {
      status: 'confirmed',
    })],
    master_audio: makeMasterAudio({
      status: 'ready',
      timeline_status: 'ready',
      audio_url: audioUrl,
      duration: 2.4,
      source_hash: sourceHash,
      word_timings: makeGlobalWords(['甲', '乙'], 'a'),
    }),
    scene_plan: makeScenePlan({
      status: 'ready',
      master_source_hash: sourceHash,
      scenes: canonicalScenes,
    }),
    render_input: makeRenderInput({
      audio: audioUrl,
      segments: [{
        id: 'scene-1',
        start: 0,
        end: 2.4,
        text: '甲乙',
        highlight: ['甲'],
        animation: 'fade-up',
      }],
    }),
    duration: 2.4,
  })
}

describe('mergeWorkerProject', () => {
  it('adopts ready audio when launch-time voice defaults match the server', () => {
    const baseline = makeTextVideoProject({
      script: '甲。',
      voice_settings: {
        voice_id: '',
        model: '',
        speed: 1,
        volume: 1,
        pitch: 0,
      },
      paragraphs: [makeSpeechSegment('a', '甲。')],
    })
    const configuredVoice = {
      voice_id: 'task12-voice',
      model: 'mimo-v2.5-tts',
      speed: 1,
      volume: 1,
      pitch: 0,
    }
    const generating = {
      ...baseline,
      voice_settings: configuredVoice,
      paragraphs: [makeSpeechSegment('a', '甲。', {
        status: 'generating',
        source_hash: 'a'.repeat(64),
        job_id: 41,
      })],
    }
    const ready = {
      ...generating,
      paragraphs: [makeSpeechSegment('a', '甲。', {
        status: 'ready',
        source_hash: 'a'.repeat(64),
        audio_url: '/api/uploads/a.mp3',
        job_id: null,
      })],
    }

    const merged = mergeWorkerProject(generating, ready, {
      editableBaseline: baseline,
      localDirty: false,
    })

    expect(merged.voice_settings).toEqual(configuredVoice)
    expect(merged.paragraphs[0]).toMatchObject({
      status: 'ready',
      audio_url: '/api/uploads/a.mp3',
      job_id: null,
    })
  })

  it('keeps a real local voice edit instead of accepting ready launch audio', () => {
    const baseline = makeTextVideoProject({
      script: '甲。',
      voice_settings: {
        voice_id: '',
        model: '',
        speed: 1,
        volume: 1,
        pitch: 0,
      },
      paragraphs: [makeSpeechSegment('a', '甲。')],
    })
    const configuredVoice = {
      voice_id: 'task12-voice',
      model: 'mimo-v2.5-tts',
      speed: 1,
      volume: 1,
      pitch: 0,
    }
    const generating = {
      ...baseline,
      voice_settings: configuredVoice,
      paragraphs: [makeSpeechSegment('a', '甲。', {
        status: 'generating',
        source_hash: 'a'.repeat(64),
        generation_revision: 1,
        job_id: 41,
      })],
    }
    const local = updateProjectVoiceSettings(generating, {
      speed: 1.25,
    })
    const ready = {
      ...generating,
      paragraphs: [makeSpeechSegment('a', '甲。', {
        status: 'ready',
        source_hash: 'a'.repeat(64),
        audio_url: '/api/uploads/a.mp3',
        generation_revision: 1,
        job_id: null,
      })],
    }

    const merged = mergeWorkerProject(local, ready, {
      editableBaseline: baseline,
      localDirty: true,
    })

    expect(merged.voice_settings).toEqual({
      ...configuredVoice,
      speed: 1.25,
    })
    expect(merged.paragraphs[0]).toMatchObject({
      status: 'draft',
      audio_url: '',
      source_hash: '',
      generation_revision: 2,
      job_id: null,
    })
  })

  it('merges completed speech without replacing an unrelated local edit', () => {
    const baseline = makeTextVideoProject({
      script: '甲。乙。',
      paragraphs: [
        makeSpeechSegment('a', '甲。'),
        makeSpeechSegment('b', '乙。'),
      ],
      master_audio: makeMasterAudio({
        status: 'ready',
        timeline_status: 'ready',
        audio_url: '/api/uploads/old-master.mp3',
      }),
    })
    const local = editSpeechSegment(baseline, 'b', '本地乙。')
    const server = {
      ...baseline,
      paragraphs: baseline.paragraphs.map(segment => (
        segment.id === 'a'
          ? {
              ...segment,
              status: 'ready' as const,
              audio_url: '/api/uploads/a.mp3',
              duration: 1.2,
              source_hash: 'a'.repeat(64),
              job_id: null,
            }
          : segment
      )),
    }

    const merged = mergeWorkerProject(local, server, {
      editableBaseline: baseline,
      localDirty: true,
    })

    expect(merged.paragraphs.find(item => item.id === 'a')).toMatchObject({
      status: 'ready',
      audio_url: '/api/uploads/a.mp3',
    })
    expect(merged.paragraphs.find(item => item.id === 'b')).toMatchObject({
      text: '本地乙。',
      status: 'draft',
    })
    expect(merged.master_audio.status).toBe('stale')
    expect(merged.render_input.audio).toBe('')
  })

  it('never attaches old worker audio to a locally edited same-ID segment', () => {
    const baseline = makeTextVideoProject({
      script: '甲。',
      paragraphs: [makeSpeechSegment('a', '甲。')],
    })
    const local = editSpeechSegment(baseline, 'a', '甲改。')
    const server = {
      ...baseline,
      paragraphs: [makeSpeechSegment('a', '甲。', {
        status: 'ready',
        audio_url: '/api/uploads/a.mp3',
        source_hash: 'a'.repeat(64),
      })],
    }

    const merged = mergeWorkerProject(local, server, {
      editableBaseline: baseline,
      localDirty: true,
    })

    expect(merged.paragraphs[0]).toMatchObject({
      text: '甲改。',
      status: 'draft',
      audio_url: '',
      generation_revision: 1,
    })
  })

  it('does not revive old audio after narration is edited and reverted', () => {
    const baseline = makeTextVideoProject({
      script: '甲。',
      paragraphs: [makeSpeechSegment('a', '甲。', {
        status: 'confirmed',
        audio_url: '/api/uploads/old-a.mp3',
        source_hash: 'a'.repeat(64),
        generation_revision: 3,
      })],
      master_audio: makeMasterAudio({
        status: 'ready',
        timeline_status: 'ready',
        audio_url: '/api/uploads/old-master.mp3',
      }),
      render_input: {
        ...makeTextVideoProject().render_input,
        audio: '/api/uploads/old-master.mp3',
      },
    })
    const edited = editSpeechSegment(baseline, 'a', '甲改。')
    const reverted = editSpeechSegment(edited, 'a', '甲。')

    const merged = mergeWorkerProject(reverted, baseline, {
      editableBaseline: baseline,
      localDirty: true,
    })

    expect(merged.paragraphs[0]).toMatchObject({
      status: 'draft',
      audio_url: '',
      generation_revision: 5,
    })
    expect(merged.master_audio.status).toBe('stale')
    expect(merged.render_input.audio).toBe('')
  })

  it('does not revive old audio after voice settings are changed and reverted', () => {
    const baseline = makeTextVideoProject({
      script: '甲。',
      paragraphs: [makeSpeechSegment('a', '甲。', {
        status: 'confirmed',
        audio_url: '/api/uploads/old-a.mp3',
        source_hash: 'a'.repeat(64),
        generation_revision: 3,
      })],
      master_audio: makeMasterAudio({
        status: 'ready',
        timeline_status: 'ready',
        audio_url: '/api/uploads/old-master.mp3',
      }),
      render_input: {
        ...makeTextVideoProject().render_input,
        audio: '/api/uploads/old-master.mp3',
      },
    })
    const changed = updateProjectVoiceSettings(baseline, { speed: 1.2 })
    const reverted = updateProjectVoiceSettings(changed, { speed: 1 })

    const merged = mergeWorkerProject(reverted, baseline, {
      editableBaseline: baseline,
      localDirty: true,
    })

    expect(merged.voice_settings.speed).toBe(1)
    expect(merged.paragraphs[0]).toMatchObject({
      status: 'draft',
      audio_url: '',
      generation_revision: 5,
    })
    expect(merged.master_audio.status).toBe('stale')
    expect(merged.render_input.audio).toBe('')
  })

  it('preserves an explicit AI split mode when exact slices stay unchanged', () => {
    const baseline = makeTextVideoProject({
      script: '甲。乙。',
      paragraphs: [
        makeSpeechSegment('a', '甲。'),
        makeSpeechSegment('b', '乙。'),
      ],
      speech_split_mode: 'manual',
    })
    const local = {
      ...baseline,
      speech_split_mode: 'auto' as const,
    }

    const merged = mergeWorkerProject(local, baseline, {
      editableBaseline: baseline,
      localDirty: true,
    })

    expect(merged.speech_split_mode).toBe('auto')
  })

  it('merges visual scenes without replacing server job metadata or duration', () => {
    const baseline = makeTextVideoProject({
      duration: 4,
      scene_plan: {
        ...makeTextVideoProject().scene_plan,
        status: 'ready',
        generation_revision: 1,
        scenes: [{
          id: 'scene-1',
          fromWordId: 'word-1',
          throughWordId: 'word-2',
          displayText: '原屏显',
          highlight: [],
          animation: 'fade-up',
        }],
      },
    })
    const local = {
      ...baseline,
      duration: 99,
      scene_plan: {
        ...baseline.scene_plan,
        scenes: [{
          ...baseline.scene_plan.scenes[0],
          displayText: '本地屏显',
        }],
      },
      render_input: {
        ...baseline.render_input,
        segments: [{
          ...baseline.render_input.segments[0],
          text: '本地屏显',
        }],
      },
    }
    const server = {
      ...baseline,
      duration: 4.5,
      scene_plan: {
        ...baseline.scene_plan,
        status: 'generating' as const,
        generation_revision: 2,
        job_id: 88,
      },
    }

    const merged = mergeWorkerProject(local, server, {
      editableBaseline: baseline,
      localDirty: true,
    })

    expect(merged.scene_plan).toMatchObject({
      status: 'generating',
      generation_revision: 2,
      job_id: 88,
      scenes: [expect.objectContaining({ displayText: '本地屏显' })],
    })
    expect(merged.duration).toBe(4.5)
  })

  it('keeps local scene intent but uses server render seconds, audio, and duration', () => {
    const baseline = makeVideoReadyProject()
    const local = {
      ...baseline,
      duration: 99,
      scene_plan: {
        ...baseline.scene_plan,
        scenes: [{
          ...baseline.scene_plan.scenes[0],
          displayText: '本地视觉意图',
        }],
      },
      render_input: {
        ...baseline.render_input,
        audio: '/api/uploads/local-stale.mp3',
        segments: [{
          ...baseline.render_input.segments[0],
          end: 99,
          text: '本地旧秒数',
        }],
      },
    }
    const server = {
      ...baseline,
      revision: 2,
      duration: 4.2,
      render_input: {
        ...baseline.render_input,
        segments: [{
          ...baseline.render_input.segments[0],
          end: 4.2,
          text: '服务端权威投影',
        }],
      },
    }

    const merged = mergeWorkerProject(local, server, {
      editableBaseline: baseline,
      localDirty: true,
    })

    expect(merged.scene_plan.scenes[0].displayText).toBe('本地视觉意图')
    expect(merged.render_input.segments).toEqual(server.render_input.segments)
    expect(merged.render_input.audio).toBe(server.render_input.audio)
    expect(merged.duration).toBe(server.duration)
  })

  it('uses the saved server projection after a local narration invalidation', () => {
    const baseline = makeVideoReadyProject()
    const edited = editSpeechSegment(baseline, 'a', '甲乙改')
    const local = {
      ...edited,
      duration: 99,
      render_input: {
        ...edited.render_input,
        segments: [{
          ...edited.render_input.segments[0],
          end: 99,
          text: '浏览器旧投影',
        }],
      },
    }
    const server = {
      ...edited,
      revision: 2,
      duration: 0,
      render_input: {
        ...edited.render_input,
        segments: [{
          ...edited.render_input.segments[0],
          end: 2.4,
          text: '服务端失效后投影',
        }],
      },
    }

    const merged = mergeWorkerProject(local, server, {
      editableBaseline: baseline,
      localDirty: true,
    })

    expect(merged.render_input.segments).toEqual(server.render_input.segments)
    expect(merged.render_input.audio).toBe(server.render_input.audio)
    expect(merged.duration).toBe(0)
  })

  it('keeps newer local worker state when an older action snapshot arrives', () => {
    const baseline = makeTextVideoProject({
      script: '甲。乙。',
      paragraphs: [
        makeSpeechSegment('a', '甲。'),
        makeSpeechSegment('b', '乙。'),
      ],
    })
    const local = {
      ...baseline,
      paragraphs: [
        makeSpeechSegment('a', '甲。', {
          status: 'generating',
          source_hash: 'a'.repeat(64),
          job_id: 11,
        }),
        makeSpeechSegment('b', '乙。', {
          status: 'generating',
          source_hash: 'b'.repeat(64),
          job_id: 22,
        }),
      ],
    }
    const olderServer = {
      ...baseline,
      paragraphs: [
        local.paragraphs[0],
        baseline.paragraphs[1],
      ],
    }

    const merged = mergeWorkerProject(local, olderServer, {
      editableBaseline: baseline,
      localDirty: false,
    })

    expect(merged.paragraphs).toMatchObject([
      { id: 'a', status: 'generating', job_id: 11 },
      { id: 'b', status: 'generating', job_id: 22 },
    ])
  })

  it('does not revive downstream master, scene, or render state from a speech-stale snapshot', () => {
    const baseline = makeTextVideoProject({
      script: '甲。',
      paragraphs: [makeSpeechSegment('a', '甲。', {
        status: 'confirmed',
        generation_revision: 3,
        source_hash: 'old'.repeat(21) + 'o',
        audio_url: '/api/uploads/old-speech.mp3',
      })],
    })
    const local = {
      ...baseline,
      paragraphs: [makeSpeechSegment('a', '甲。', {
        status: 'generating',
        generation_revision: 4,
        source_hash: 'new'.repeat(21) + 'n',
        job_id: 22,
      })],
      master_audio: {
        ...baseline.master_audio,
        status: 'missing' as const,
        job_id: null,
      },
      scene_plan: {
        ...baseline.scene_plan,
        status: 'stale' as const,
        job_id: null,
      },
      render_input: {
        ...baseline.render_input,
        audio: '',
        segments: [{
          ...baseline.render_input.segments[0],
          id: 'new-scene',
          text: '新分镜',
        }],
      },
      duration: 0,
    }
    const delayedMasterSnapshot = {
      ...baseline,
      master_audio: {
        ...baseline.master_audio,
        status: 'building' as const,
        source_hash: 'master-old',
        job_id: 11,
      },
      scene_plan: {
        ...baseline.scene_plan,
        status: 'generating' as const,
        generation_revision: 2,
        job_id: 31,
      },
      render_input: {
        ...baseline.render_input,
        audio: '/api/uploads/old-master.mp3',
        segments: [{
          ...baseline.render_input.segments[0],
          id: 'old-scene',
          text: '旧分镜',
        }],
      },
      duration: 9,
    }

    const merged = mergeWorkerProject(local, delayedMasterSnapshot, {
      editableBaseline: baseline,
      localDirty: false,
    })

    expect(merged.paragraphs[0]).toMatchObject({
      status: 'generating',
      generation_revision: 4,
      job_id: 22,
    })
    expect(merged.master_audio).toMatchObject({
      status: 'missing',
      job_id: null,
    })
    expect(merged.scene_plan).toMatchObject({
      status: 'stale',
      job_id: null,
    })
    expect(merged.render_input.audio).toBe('')
    expect(merged.render_input.segments[0].id).toBe('new-scene')
    expect(merged.duration).toBe(0)
  })
})

describe('project speech settings and video gate', () => {
  it('invalidates speech and downstream state when a voice setting changes', () => {
    const project = makeTextVideoProject({
      script: '甲。',
      paragraphs: [makeSpeechSegment('a', '甲。', {
        status: 'confirmed',
        audio_url: '/api/uploads/a.mp3',
        generation_revision: 3,
      })],
      master_audio: makeMasterAudio({
        status: 'ready',
        timeline_status: 'ready',
        audio_url: '/api/uploads/master.mp3',
      }),
      render_input: {
        ...makeTextVideoProject().render_input,
        audio: '/api/uploads/master.mp3',
      },
    })

    const next = updateProjectVoiceSettings(project, { speed: 1.2 })

    expect(next.voice_settings.speed).toBe(1.2)
    expect(next.paragraphs[0]).toMatchObject({
      status: 'draft',
      audio_url: '',
      generation_revision: 4,
    })
    expect(next.master_audio.status).toBe('stale')
    expect(next.master_audio.timeline_status).toBe('stale')
    expect(next.render_input.audio).toBe('')
  })

  it('requires non-empty confirmed speech and both authoritative audio states', () => {
    const canonical = makeVideoReadyProject()
    const ready = {
      ...canonical,
      script: `${canonical.script}   `,
      paragraphs: [
        ...canonical.paragraphs,
        makeSpeechSegment('blank', '   '),
      ],
    }

    expect(canEnterVideoStage(ready)).toBe(true)
    expect(canEnterVideoStage({
      ...ready,
      paragraphs: [makeSpeechSegment('blank', '   ')],
      script: '   ',
    })).toBe(false)
    expect(canEnterVideoStage({
      ...ready,
      master_audio: {
        ...ready.master_audio,
        timeline_status: 'failed',
      },
    })).toBe(false)
  })

  it('opens video composition before scenes exist but keeps preview gated', () => {
    const canonical = makeVideoReadyProject()
    const audioReady = {
      ...canonical,
      scene_plan: makeScenePlan(),
      render_input: {
        ...canonical.render_input,
        audio: '',
      },
    }

    expect(canEnterVideoStage(audioReady)).toBe(true)
    expect(canPreviewVideo(audioReady)).toBe(false)
    expect(canPreviewVideo(canonical)).toBe(true)
  })

  it.each([
    [
      'missing current words',
      (project: TextVideoProject) => ({
        ...project,
        master_audio: { ...project.master_audio, word_timings: [] },
      }),
    ],
    [
      'stale scene plan',
      (project: TextVideoProject) => ({
        ...project,
        scene_plan: { ...project.scene_plan, status: 'stale' as const },
      }),
    ],
    [
      'scene plan from another master',
      (project: TextVideoProject) => ({
        ...project,
        scene_plan: {
          ...project.scene_plan,
          master_source_hash: 'stale-master',
        },
      }),
    ],
    [
      'render audio mismatch',
      (project: TextVideoProject) => ({
        ...project,
        render_input: {
          ...project.render_input,
          audio: '/api/uploads/other.mp3',
        },
      }),
    ],
    [
      'unknown template pair',
      (project: TextVideoProject) => ({
        ...project,
        render_input: {
          ...project.render_input,
          templateId: 'retired-template',
        },
      }),
    ],
    [
      'tampered render segments',
      (project: TextVideoProject) => ({
        ...project,
        render_input: {
          ...project.render_input,
          segments: [{
            ...project.render_input.segments[0],
            text: '被篡改的投影',
            highlight: [],
          }],
        },
      }),
    ],
  ])('rejects %s', (_name, mutate) => {
    expect(canPreviewVideo(mutate(makeVideoReadyProject()))).toBe(false)
  })
})

describe('mergeWorkerProject ordering', () => {
  it('keeps a local reorder and reusable segment speech while master stays stale', () => {
    const baseline = makeTextVideoProject({
      script: '甲。乙。',
      paragraphs: [
        makeSpeechSegment('a', '甲。'),
        makeSpeechSegment('b', '乙。'),
      ],
      master_audio: makeMasterAudio({
        status: 'ready',
        timeline_status: 'ready',
      }),
    })
    const local = reorderSpeechSegment(baseline, 'b', 0)
    const server = {
      ...baseline,
      paragraphs: baseline.paragraphs.map(segment => ({
        ...segment,
        status: 'ready' as const,
        audio_url: `/api/uploads/${segment.id}.mp3`,
        source_hash: segment.id.repeat(64),
      })),
    }

    const merged = mergeWorkerProject(local, server, {
      editableBaseline: baseline,
      localDirty: true,
    })

    expect(merged.paragraphs.map(item => item.id)).toEqual(['b', 'a'])
    expect(merged.paragraphs.map(item => item.audio_url)).toEqual([
      '/api/uploads/b.mp3',
      '/api/uploads/a.mp3',
    ])
    expect(merged.script).toBe('乙。甲。')
    expect(merged.master_audio.status).toBe('stale')
  })
})
