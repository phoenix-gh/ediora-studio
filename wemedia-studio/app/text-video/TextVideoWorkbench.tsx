'use client'

import { useMemo, useState } from 'react'
import { Check, ChevronRight, CircleDashed, Film, Save } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { TEXT_VIDEO_FIXTURE, type TextVideoFixtureProject } from '@/lib/text-video/fixture'
import { cn } from '@/lib/utils'

import { AudioStage } from './AudioStage'
import { ScriptStage } from './ScriptStage'
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
}: {
  initialProject?: TextVideoFixtureProject
}) {
  const [stage, setStage] = useState<Stage>('script')
  const [selectedParagraph, setSelectedParagraph] = useState(0)
  const [selectedScene, setSelectedScene] = useState(0)
  const [previewAll, setPreviewAll] = useState(false)
  const [ratio, setRatio] = useState<keyof typeof ratioDimensions>('9:16')
  const confirmed = initialProject.paragraphs.filter(item => item.status === 'confirmed').length
  const audioReady = confirmed === initialProject.paragraphs.length
  const project = useMemo(() => ({
    ...initialProject,
    renderInput: {
      ...initialProject.renderInput,
      composition: {
        ...initialProject.renderInput.composition,
        ...ratioDimensions[ratio],
      },
    },
  }), [initialProject, ratio])

  function chooseScene(index: number) {
    setSelectedScene(index)
    setPreviewAll(false)
  }

  return (
    <div className="min-h-full bg-background">
      <header className="border-b border-border bg-surface/80 px-5 py-4 backdrop-blur lg:px-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Film data-icon className="size-5" />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-xl font-semibold tracking-tight">{project.title}</h1>
                <Badge variant="outline">演示数据</Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{project.description}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Select value={ratio} onValueChange={value => setRatio(value as keyof typeof ratioDimensions)}>
              <SelectTrigger aria-label="画面比例"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="9:16">9:16 竖屏</SelectItem>
                  <SelectItem value="16:9">16:9 横屏</SelectItem>
                  <SelectItem value="1:1">1:1 方形</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button variant="outline" disabled><Save data-icon />保存项目</Button>
          </div>
        </div>

        <div role="tablist" aria-label="文字视频制作阶段" className="mt-5 flex max-w-2xl items-center">
          {stages.map((item, index) => {
            const active = stage === item.id
            const disabled = item.id === 'video' && !audioReady
            return (
              <div key={item.id} className="flex min-w-0 flex-1 items-center">
                <button
                  type="button"
                  role="tab"
                  aria-label={item.label}
                  aria-selected={active}
                  disabled={disabled}
                  onClick={() => setStage(item.id)}
                  className={cn(
                    'flex min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-sm font-medium transition-colors',
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
                  <span className="truncate">{item.label}</span>
                </button>
                {index < stages.length - 1 ? <ChevronRight data-icon className="mx-1 size-4 shrink-0 text-border" /> : null}
              </div>
            )
          })}
        </div>
        {!audioReady ? <p className="mt-2 text-xs text-amber-600">还需确认 {project.paragraphs.length - confirmed} 段配音</p> : null}
      </header>

      {stage === 'script' ? (
        <ScriptStage project={project} selectedParagraph={selectedParagraph} onSelectParagraph={setSelectedParagraph} />
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
  )
}
