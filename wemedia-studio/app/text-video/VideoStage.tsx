'use client'

import {
  Clapperboard,
  Maximize2,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  Volume2,
  WandSparkles,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { TextVideoFixtureProject } from '@/lib/text-video/fixture'
import { cn } from '@/lib/utils'

import { RemotionPreview } from './RemotionPreview'
import { SceneTimeline } from './SceneTimeline'

export function VideoStage({
  project,
  selectedScene,
  onSelectScene,
  previewAll,
  onPreviewAll,
}: {
  project: TextVideoFixtureProject
  selectedScene: number
  onSelectScene: (index: number) => void
  previewAll: boolean
  onPreviewAll: () => void
}) {
  const scene = project.renderInput.segments[selectedScene]
  return (
    <div data-testid="editor-workspace" className="grid min-h-[650px] grid-cols-[28fr_52fr_20fr] border-border">
      <aside className="border-r border-border bg-surface/60 p-3">
        <div className="mb-3 flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-foreground-subtle">画面场景</p>
          <Badge variant="secondary">{project.renderInput.segments.length} scenes</Badge>
        </div>
        <div className="space-y-2">
          {project.renderInput.segments.map((item, index) => (
            <button
              key={item.id}
              type="button"
              aria-label={`SCENE ${String(index + 1).padStart(2, '0')}`}
              onClick={() => onSelectScene(index)}
              className={cn(
                'grid w-full grid-cols-[72px_1fr] gap-3 rounded-xl border p-2 text-left transition-colors',
                selectedScene === index && !previewAll
                  ? 'border-primary/50 bg-primary/8'
                  : 'border-transparent bg-background/60 hover:border-border',
              )}
            >
              <span className="flex h-14 items-center justify-center rounded-md bg-[#07111f] px-1 text-center text-[10px] font-semibold leading-4 text-cyan-50">
                {item.text.replace('\n', ' · ')}
              </span>
              <span className="min-w-0">
                <span className="flex items-center justify-between text-[10px] text-muted-foreground">
                  <span>SCENE {String(index + 1).padStart(2, '0')}</span>
                  <span>{(item.end - item.start).toFixed(1)}s</span>
                </span>
                <span className="mt-1 line-clamp-2 whitespace-pre-line text-xs font-medium leading-4">{item.text}</span>
                <span className="mt-1 inline-flex rounded bg-muted px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">{item.animation}</span>
              </span>
            </button>
          ))}
        </div>
      </aside>

      <section className="flex min-w-0 flex-col p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-medium text-primary">{previewAll ? '全片预览' : `SCENE ${String(selectedScene + 1).padStart(2, '0')}`}</p>
            <h2 className="mt-1 text-base font-semibold">Remotion 实时画面</h2>
          </div>
          <Button size="sm" variant="outline" onClick={onPreviewAll}><Play data-icon />预览全片</Button>
        </div>
        <div className="mx-auto flex min-h-[455px] w-full flex-1 items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-[#030711] p-3 shadow-[0_22px_60px_rgba(2,8,23,0.18)]">
          <div
            className={cn(
              'overflow-hidden rounded-xl shadow-2xl',
              project.renderInput.composition.width === project.renderInput.composition.height
                ? 'aspect-square h-auto w-full max-w-[440px]'
                : project.renderInput.composition.width > project.renderInput.composition.height
                  ? 'aspect-video w-full'
                  : 'h-[440px] aspect-[9/16]',
            )}
          >
            <RemotionPreview input={project.renderInput} selectedScene={scene} previewAll={previewAll} />
          </div>
        </div>
        <div data-testid="player-controls" className="mt-3 flex h-10 items-center gap-3 rounded-lg border border-border bg-surface px-3">
          <Button aria-label="暂停预览" size="icon-xs" variant="ghost" disabled><Pause data-icon /></Button>
          <span className="font-mono text-xs">00:{String(Math.floor(scene.start)).padStart(2, '0')} / 00:{String(Math.ceil(project.renderInput.segments.at(-1)!.end)).padStart(2, '0')}</span>
          <div className="h-1.5 flex-1 rounded-full bg-muted"><div className="h-full w-1/3 rounded-full bg-primary" /></div>
          <Button aria-label="重新播放" size="icon-xs" variant="ghost" disabled><RotateCcw data-icon /></Button>
          <Button aria-label="音量" size="icon-xs" variant="ghost" disabled><Volume2 data-icon /></Button>
          <Button aria-label="全屏" size="icon-xs" variant="ghost" disabled><Maximize2 data-icon /></Button>
        </div>
      </section>

      <aside className="border-l border-border bg-surface/45 p-4">
        <div className="flex items-center gap-2">
          <Clapperboard data-icon className="size-4 text-primary" />
          <p className="text-sm font-semibold">模板与导演</p>
        </div>
        <Field className="mt-5">
          <FieldLabel>视频模板</FieldLabel>
          <Select defaultValue="tech-text-v1">
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="tech-text-v1">科技资讯动态文字</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <FieldDescription>tech-text-v1 · 版本锁定</FieldDescription>
        </Field>
        <div className="mt-5 border-t border-border pt-4">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-foreground-subtle">画面</p>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
            <div><dt className="text-muted-foreground">主题色</dt><dd className="mt-1 font-medium">科技蓝</dd></div>
            <div><dt className="text-muted-foreground">字体</dt><dd className="mt-1 font-medium">思源黑体</dd></div>
            <div><dt className="text-muted-foreground">背景</dt><dd className="mt-1 font-medium">深色网格</dd></div>
            <div><dt className="text-muted-foreground">密度</dt><dd className="mt-1 font-medium">标准</dd></div>
          </dl>
        </div>
        <div className="mt-5 rounded-xl border bg-background/55 p-4">
          <div className="flex items-center gap-2 text-sm font-medium"><Sparkles data-icon className="size-4" />当前场景</div>
          <dl className="mt-4 space-y-3 text-xs">
            <div><dt className="text-muted-foreground">动效</dt><dd className="mt-1 font-mono font-medium">{scene.animation}</dd></div>
            <div><dt className="text-muted-foreground">高亮</dt><dd className="mt-1 font-medium">{scene.highlight.join('、') || '无'}</dd></div>
            <div><dt className="text-muted-foreground">转场</dt><dd className="mt-1 font-mono font-medium">soft-push</dd></div>
          </dl>
        </div>
        <Button className="mt-5 w-full" variant="outline" disabled><WandSparkles data-icon />让 AI 调整画面</Button>
        <Button className="mt-3 w-full" disabled>渲染 MP4（下一阶段）</Button>
      </aside>

      <SceneTimeline project={project} selectedScene={selectedScene} onSelectScene={onSelectScene} />
    </div>
  )
}
