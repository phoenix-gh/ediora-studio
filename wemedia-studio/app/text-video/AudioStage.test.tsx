// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import {
  makeMasterAudio,
  makeSpeechSegment,
  makeTextVideoProject,
} from '@/lib/text-video/test-fixtures'

import { AudioStage } from './AudioStage'

function renderStage(
  project = makeTextVideoProject({
    script: '甲。乙。丙。',
    stage: 'audio',
    paragraphs: [
      makeSpeechSegment('draft', '甲。'),
      makeSpeechSegment('generating', '乙。', { status: 'generating' }),
      makeSpeechSegment('ready', '丙。', {
        status: 'ready',
        audio_url: '/api/uploads/ready.mp3',
        duration: 1.2,
        source_hash: 'a'.repeat(64),
        generation_revision: 2,
      }),
    ],
  }),
  overrides: Partial<React.ComponentProps<typeof AudioStage>> = {},
) {
  const props: React.ComponentProps<typeof AudioStage> = {
    project,
    selectedSegmentId: 'ready',
    onSelectSegment: vi.fn(),
    onVoiceSettingsChange: vi.fn(),
    onGeneratePending: vi.fn(),
    onGenerateSegment: vi.fn(),
    onConfirmSegment: vi.fn(),
    onBuildMasterAudio: vi.fn(),
    onRealignMasterAudio: vi.fn(),
    ...overrides,
  }
  return { ...render(<AudioStage {...props} />), props }
}

describe('AudioStage', () => {
  it('renders truthful segment states and only real generated audio', () => {
    const { container } = renderStage()

    expect(screen.getAllByTestId('speech-segment-card')).toHaveLength(3)
    expect(screen.getByText('合成音频与成片时间轴')).toBeVisible()
    expect(screen.getByText('未生成')).toBeVisible()
    expect(screen.getByText('生成中')).toBeVisible()
    expect(screen.getAllByText('待确认').length).toBeGreaterThan(0)
    expect(screen.queryByText(/演示波形/)).not.toBeInTheDocument()
    expect(container.querySelector('audio[data-testid="segment-audio"]'))
      .toHaveAttribute(
        'src',
        'http://localhost:8000/api/uploads/ready.mp3',
      )
  })

  it('edits voice settings through controlled fields and pins the model', () => {
    const onVoiceSettingsChange = vi.fn()
    renderStage(undefined, { onVoiceSettingsChange })

    expect(screen.getByLabelText('语音模型')).toHaveValue('mimo-v2.5-tts')
    expect(screen.getByLabelText('语音模型')).toHaveAttribute('readonly')
    expect(screen.getByText('MP3 · 44.1 kHz · 128 kbps · 单声道'))
      .toBeVisible()

    const voice = screen.getByLabelText('音色 ID')
    fireEvent.change(voice, { target: { value: 'voice-clone-1' } })
    expect(onVoiceSettingsChange).toHaveBeenLastCalledWith({
      voice_id: 'voice-clone-1',
    })

    const speed = screen.getByLabelText('语速')
    fireEvent.change(speed, { target: { value: '1.2' } })
    expect(onVoiceSettingsChange).toHaveBeenLastCalledWith({ speed: 1.2 })
  })

  it('calls the selected, pending, confirmation, and master actions from real state', async () => {
    const user = userEvent.setup()
    const onGeneratePending = vi.fn()
    const onGenerateSegment = vi.fn()
    const onConfirmSegment = vi.fn()
    const project = makeTextVideoProject({
      script: '甲。乙。',
      stage: 'audio',
      paragraphs: [
        makeSpeechSegment('a', '甲。', { status: 'confirmed' }),
        makeSpeechSegment('b', '乙。', {
          status: 'ready',
          source_hash: 'b'.repeat(64),
          generation_revision: 4,
          audio_url: '/api/uploads/b.mp3',
        }),
      ],
    })
    renderStage(project, {
      selectedSegmentId: 'b',
      onGeneratePending,
      onGenerateSegment,
      onConfirmSegment,
    })

    expect(screen.getByRole('button', { name: '生成全部未生成段落' }))
      .toBeDisabled()
    await user.click(screen.getByRole('button', { name: '重新生成当前段' }))
    expect(onGenerateSegment).toHaveBeenCalledWith('b')
    await user.click(screen.getByRole('button', { name: '确认当前段' }))
    expect(onConfirmSegment).toHaveBeenCalledWith(project.paragraphs[1])
    expect(screen.getByRole('button', { name: '生成主音频' }))
      .toBeDisabled()
  })

  it('ignores whitespace for the master gate and blocks confirmation during regeneration', () => {
    const project = makeTextVideoProject({
      script: '甲。   ',
      stage: 'audio',
      paragraphs: [
        makeSpeechSegment('a', '甲。', {
          status: 'ready',
          source_hash: 'a'.repeat(64),
          audio_url: '/api/uploads/a.mp3',
        }),
        makeSpeechSegment('blank', '   '),
      ],
    })
    const { rerender, props } = renderStage(project, {
      selectedSegmentId: 'a',
      actionStates: {
        'speech:a': {
          status: 'running',
          error: '',
          retryable: false,
          jobId: null,
          stepKey: '',
        },
      },
    })

    expect(screen.getByRole('button', { name: '确认当前段' })).toBeDisabled()

    const confirmed = {
      ...project,
      paragraphs: [
        { ...project.paragraphs[0], status: 'confirmed' as const },
        project.paragraphs[1],
      ],
    }
    rerender(
      <AudioStage
        {...props}
        project={confirmed}
        actionStates={{}}
      />,
    )
    expect(screen.queryByRole('button', { name: '生成主音频' }))
      .not.toBeInTheDocument()
    expect(screen.queryByText('主音频与全局时间轴'))
      .not.toBeInTheDocument()
    expect(screen.queryByText('合成音频与成片时间轴'))
      .not.toBeInTheDocument()
    expect(screen.queryByTestId('master-audio')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '播放全部' }))
      .not.toBeInTheDocument()
    expect(screen.getByTestId('single-segment-timeline-status'))
      .toHaveTextContent('正在生成成片时间轴')

    rerender(
      <AudioStage
        {...props}
        project={confirmed}
        actionStates={{
          master: {
            status: 'running',
            error: '',
            retryable: false,
            jobId: null,
            stepKey: '',
          },
        }}
      />,
    )
    expect(screen.queryByRole('button', { name: '生成主音频' }))
      .not.toBeInTheDocument()
    expect(screen.getByTestId('single-segment-timeline-status'))
      .toHaveTextContent('正在生成成片时间轴')
  })

  it('prevents speech and master generation from overlapping while a launch is pending', () => {
    const project = makeTextVideoProject({
      script: '甲。乙。',
      stage: 'audio',
      paragraphs: [
        makeSpeechSegment('a', '甲。', {
          status: 'confirmed',
          source_hash: 'a'.repeat(64),
          audio_url: '/api/uploads/a.mp3',
        }),
        makeSpeechSegment('b', '乙。', {
          status: 'confirmed',
          source_hash: 'b'.repeat(64),
          audio_url: '/api/uploads/b.mp3',
        }),
      ],
    })
    const { rerender, props } = renderStage(project, {
      selectedSegmentId: 'a',
      actionStates: {
        master: {
          status: 'running',
          error: '',
          retryable: false,
          jobId: null,
          stepKey: '',
        },
      },
    })

    expect(screen.getByRole('button', { name: '重新生成当前段' }))
      .toBeDisabled()

    rerender(
      <AudioStage
        {...props}
        project={project}
        actionStates={{
          'speech:a': {
            status: 'running',
            error: '',
            retryable: false,
            jobId: null,
            stepKey: '',
          },
        }}
      />,
    )
    expect(screen.getByRole('button', { name: '生成主音频' })).toBeDisabled()
  })

  it('keeps single-segment alignment recovery beside the only audio player', async () => {
    const user = userEvent.setup()
    const onRealignMasterAudio = vi.fn()
    const project = makeTextVideoProject({
      script: '甲。',
      stage: 'audio',
      paragraphs: [
        makeSpeechSegment('a', '甲。', {
          status: 'confirmed',
          audio_url: '/api/uploads/master.mp3',
          duration: 1.6,
        }),
      ],
      master_audio: makeMasterAudio({
        status: 'ready',
        timeline_status: 'failed',
        audio_url: '/api/uploads/master.mp3',
        duration: 1.6,
        timeline_error: '时间戳与原稿无法对齐',
        job_id: 73,
      }),
    })
    const { container } = renderStage(project, {
      selectedSegmentId: 'a',
      onRealignMasterAudio,
    })

    const timelineStatus = screen.getByTestId(
      'single-segment-timeline-status',
    )
    expect(timelineStatus).toHaveTextContent('成片时间轴生成失败')
    expect(timelineStatus).toHaveTextContent('时间戳与原稿无法对齐')
    expect(container.querySelectorAll('audio')).toHaveLength(1)
    expect(container.querySelector('audio[data-testid="segment-audio"]'))
      .toHaveAttribute(
        'src',
        'http://localhost:8000/api/uploads/master.mp3',
      )
    expect(screen.queryByTestId('master-audio')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '播放全部' }))
      .not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '重新对齐' }))
    expect(onRealignMasterAudio).toHaveBeenCalledWith(73)
  })

  it('offers single-segment timeline preparation recovery inline', async () => {
    const user = userEvent.setup()
    const onBuildMasterAudio = vi.fn()
    const project = makeTextVideoProject({
      script: '甲。',
      stage: 'audio',
      paragraphs: [makeSpeechSegment('a', '甲。', {
        status: 'confirmed',
        source_hash: 'a'.repeat(64),
        audio_url: '/api/uploads/a.mp3',
      })],
      master_audio: makeMasterAudio({
        status: 'failed',
        error: '音频文件校验失败',
      }),
    })
    renderStage(project, {
      selectedSegmentId: 'a',
      onBuildMasterAudio,
    })

    expect(screen.queryByRole('button', { name: /生成主音频/ }))
      .not.toBeInTheDocument()
    const timelineStatus = screen.getByTestId(
      'single-segment-timeline-status',
    )
    expect(timelineStatus).toHaveTextContent('成片时间轴准备失败')
    expect(timelineStatus).toHaveTextContent('音频文件校验失败')
    await user.click(screen.getByRole('button', {
      name: '重新准备时间轴',
    }))
    expect(onBuildMasterAudio).toHaveBeenCalledOnce()
  })

  it('shows ready single-segment timing inline without duplicate master audio', () => {
    const project = makeTextVideoProject({
      script: '甲。',
      stage: 'audio',
      paragraphs: [makeSpeechSegment('a', '甲。', {
        status: 'confirmed',
        source_hash: 'a'.repeat(64),
        audio_url: '/api/uploads/a.mp3',
        duration: 1.6,
      })],
      master_audio: makeMasterAudio({
        status: 'ready',
        timeline_status: 'ready',
        audio_url: '/api/uploads/a.mp3',
        duration: 1.6,
      }),
    })
    const { container } = renderStage(project, {
      selectedSegmentId: 'a',
    })

    expect(screen.getByTestId('single-segment-timeline-status'))
      .toHaveTextContent('成片时间轴已就绪')
    expect(container.querySelectorAll('audio')).toHaveLength(1)
    expect(screen.queryByTestId('master-audio')).not.toBeInTheDocument()
    expect(screen.queryByText('主音频与全局时间轴'))
      .not.toBeInTheDocument()
  })
})
