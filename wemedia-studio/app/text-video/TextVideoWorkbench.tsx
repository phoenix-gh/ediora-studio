'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import {
  ArrowLeft,
  Check,
  ChevronRight,
  CircleAlert,
  CircleDashed,
  Cloud,
  CloudOff,
  LoaderCircle,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { TextVideoProject } from '@/lib/api/text-videos'
import { TEXT_VIDEO_FIXTURE, type TextVideoFixtureProject } from '@/lib/text-video/fixture'
import { cn } from '@/lib/utils'

import { AudioStage } from './AudioStage'
import { ScriptStage } from './ScriptStage'
import type { TextVideoSaveState } from './useTextVideoAutosave'
import { VideoStage } from './VideoStage'

type Stage = 'script' | 'audio' | 'video'

const stages: Array<{ id: Stage; label: string }> = [
  { id: 'script', label: '稿件与分镜' },
  { id: 'audio', label: '配音制作' },
  { id: 'video', label: '视频合成' },
]

const ratioDimensions = {
  '9:16': { width: 1080, height: 1920 },
  '16:9': { width: 1920, height: 1080 },
  '1:1': { width: 1080, height: 1080 },
} as const

export function TextVideoWorkbench({
  initialProject = TEXT_VIDEO_FIXTURE,
  projectDocument,
  saveState = 'saved',
  onProjectChange,
  onSave,
}: {
  initialProject?: TextVideoFixtureProject
  projectDocument?: TextVideoProject
  saveState?: TextVideoSaveState
  onProjectChange?: (project: TextVideoProject) => void
  onSave?: () => void
}) {
  const [localStage, setLocalStage] = useState<Stage>(projectDocument?.stage ?? 'script')
  const [selectedParagraph, setSelectedParagraph] = useState(0)
  const [selectedScene, setSelectedScene] = useState(0)
  const [previewAll, setPreviewAll] = useState(false)
  const [fixtureRatio, setFixtureRatio] = useState<keyof typeof ratioDimensions>('9:16')
  const stage = projectDocument?.stage ?? localStage
  const ratio = projectDocument ? aspectRatio(projectDocument) : fixtureRatio
  const project = useMemo(
    () => projectDocument ? documentToWorkbench(projectDocument) : {
      ...initialProject,
      renderInput: {
        ...initialProject.renderInput,
        composition: {
          ...initialProject.renderInput.composition,
          ...ratioDimensions[fixtureRatio],
        },
      },
    },
    [fixtureRatio, initialProject, projectDocument],
  )
  const confirmed = project.paragraphs.filter(item => item.status === 'confirmed').length
  const audioReady = project.paragraphs.length > 0 && confirmed === project.paragraphs.length

  function changeDocument(update: (current: TextVideoProject) => TextVideoProject) {
    if (projectDocument && onProjectChange) onProjectChange(update(projectDocument))
  }

  function chooseStage(nextStage: Stage) {
    setLocalStage(nextStage)
    changeDocument(current => ({
      ...current,
      stage: nextStage,
      status: nextStage === 'video' ? 'video_ready' : current.status,
    }))
  }

  function changeRatio(nextRatio: keyof typeof ratioDimensions) {
    setFixtureRatio(nextRatio)
    changeDocument(current => ({
      ...current,
      aspect_ratio: nextRatio,
      render_input: {
        ...current.render_input,
        composition: {
          ...current.render_input.composition,
          ...ratioDimensions[nextRatio],
        },
      },
    }))
  }

  function changeParagraphText(text: string) {
    changeDocument(current => {
      const paragraphs = current.paragraphs.map((paragraph, index) => (
        index === selectedParagraph
          ? { ...paragraph, text, status: 'draft' as const, audio_url: '', word_timings: [] }
          : paragraph
      ))
      const script = paragraphs.map(paragraph => paragraph.text).filter(Boolean).join('\n\n')
      const segments = current.render_input.segments.map((segment, index) => (
        index === Math.min(selectedParagraph, current.render_input.segments.length - 1)
          ? { ...segment, text: text.trim() || '在这里输入稿件', highlight: [] }
          : segment
      ))
      return {
        ...current,
        script,
        status: 'draft',
        paragraphs,
        render_input: { ...current.render_input, segments },
      }
    })
  }

  function chooseScene(index: number) {
    setSelectedScene(index)
    setPreviewAll(false)
  }

  return (
    <div className="min-h-full overflow-x-auto bg-background">
      <div className="min-w-[1120px]">
        <header data-testid="editor-topbar" className="flex h-[72px] items-center border-b border-border bg-surface px-4">
          <div className="flex w-[28%] min-w-0 items-center gap-2 pr-4">
            <Link href="/text-video" aria-label="返回文字视频作品" className={buttonVariants({ size: 'icon-sm', variant: 'ghost' })}>
              <ArrowLeft data-icon />
            </Link>
            <Input
              aria-label="作品标题"
              value={project.title}
              readOnly={!projectDocument}
              onChange={event => changeDocument(current => ({ ...current, title: event.target.value }))}
              className="h-9 min-w-0 border-transparent bg-transparent px-2 text-base font-semibold shadow-none hover:border-border focus-visible:bg-background"
            />
            {!projectDocument ? <Badge variant="outline">演示</Badge> : null}
            {!projectDocument ? <span className="sr-only">{project.description}</span> : null}
          </div>

          <div role="tablist" aria-label="文字视频制作阶段" className="flex w-[52%] items-center justify-center px-3">
            {stages.map((item, index) => {
              const active = stage === item.id
              const disabled = item.id === 'video' && !audioReady
              return (
                <div key={item.id} className="flex min-w-0 items-center">
                  <button
                    type="button"
                    role="tab"
                    aria-label={item.label}
                    aria-selected={active}
                    disabled={disabled}
                    onClick={() => chooseStage(item.id)}
                    className={cn(
                      'flex min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                      active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground',
                      disabled && 'cursor-not-allowed opacity-45',
                    )}
                  >
                    <span className={cn(
                      'flex size-6 shrink-0 items-center justify-center rounded-full border text-xs',
                      active ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background',
                    )}>
                      {index < stages.findIndex(value => value.id === stage)
                        ? <Check data-icon className="size-3.5" />
                        : disabled ? <CircleDashed data-icon className="size-3.5" /> : index + 1}
                    </span>
                    <span>{item.label}</span>
                  </button>
                  {index < stages.length - 1 ? <ChevronRight data-icon className="mx-1 size-4 text-border" /> : null}
                </div>
              )
            })}
          </div>

          <div className="flex w-[20%] items-center justify-end gap-2 pl-3">
            <SaveIndicator state={saveState} onSave={onSave} />
            <Select value={ratio} onValueChange={value => changeRatio(value as keyof typeof ratioDimensions)}>
              <SelectTrigger aria-label="画面比例" size="sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="9:16">9:16 竖屏</SelectItem>
                  <SelectItem value="16:9">16:9 横屏</SelectItem>
                  <SelectItem value="1:1">1:1 方形</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </header>

        {!audioReady ? (
          <div className="border-b border-amber-500/20 bg-amber-500/8 px-5 py-1.5 text-center text-xs text-amber-700">
            <span>还需确认 {project.paragraphs.length - confirmed} 段配音</span>，确认后可进入视频合成
          </div>
        ) : null}

        {stage === 'script' ? (
          <ScriptStage
            project={project}
            selectedParagraph={selectedParagraph}
            onSelectParagraph={setSelectedParagraph}
            onParagraphTextChange={projectDocument ? changeParagraphText : undefined}
          />
        ) : stage === 'audio' ? (
          <AudioStage project={project} selectedParagraph={selectedParagraph} onSelectParagraph={setSelectedParagraph} />
        ) : (
          <VideoStage
            project={project}
            selectedScene={selectedScene}
            onSelectScene={chooseScene}
            previewAll={previewAll}
            onPreviewAll={() => setPreviewAll(true)}
          />
        )}
      </div>
    </div>
  )
}

function SaveIndicator({
  state,
  onSave,
}: {
  state: TextVideoSaveState
  onSave?: () => void
}) {
  const config = {
    saved: { label: '已保存', icon: Cloud, className: 'text-emerald-600' },
    dirty: { label: '有未保存更改', icon: CloudOff, className: 'text-amber-600' },
    saving: { label: '正在保存', icon: LoaderCircle, className: 'text-muted-foreground' },
    error: { label: '保存失败，点击重试', icon: CircleAlert, className: 'text-destructive' },
    conflict: { label: '保存冲突', icon: CircleAlert, className: 'text-destructive' },
  }[state]
  const Icon = config.icon
  return (
    <button
      type="button"
      disabled={!onSave || (state !== 'error' && state !== 'dirty')}
      onClick={onSave}
      className={cn('inline-flex items-center gap-1 whitespace-nowrap text-xs', config.className)}
    >
      <Icon data-icon className={cn('size-3.5', state === 'saving' && 'animate-spin')} />
      {config.label}
    </button>
  )
}

function aspectRatio(project: TextVideoProject): keyof typeof ratioDimensions {
  const { width, height } = project.render_input.composition
  if (width === height) return '1:1'
  return width > height ? '16:9' : '9:16'
}

function documentToWorkbench(project: TextVideoProject): TextVideoFixtureProject {
  return {
    id: String(project.id),
    title: project.title,
    description: '',
    script: project.script,
    voiceName: String(project.voice_settings.voice_name ?? '默认音色'),
    paragraphs: project.paragraphs.map(paragraph => ({
      id: paragraph.id,
      text: paragraph.text,
      duration: paragraph.duration,
      status: paragraph.status,
    })),
    renderInput: project.render_input,
  }
}
