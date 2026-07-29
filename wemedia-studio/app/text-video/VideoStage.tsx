'use client'

import { Clapperboard, Play, Sparkles, WandSparkles } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { TextVideoFixtureProject } from '@/lib/text-video/fixture'
import { cn } from '@/lib/utils'

import { RemotionPreview } from './RemotionPreview'

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
    <div className="grid min-h-[650px] grid-cols-1 border-t border-border xl:grid-cols-[28fr_52fr_20fr]">
      <aside className="border-b border-border bg-surface/60 p-4 xl:border-r xl:border-b-0">
        <div className="mb-3 flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-foreground-subtle">画面场景</p>
          <Badge variant="secondary">{project.renderInput.segments.length} scenes</Badge>
        </div>
        <div className="space-y-2">
          {project.renderInput.segments.map((item, index) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectScene(index)}
              className={cn(
                'w-full rounded-xl border p-3 text-left transition-colors',
                selectedScene === index && !previewAll
                  ? 'border-primary/50 bg-primary/8'
                  : 'border-transparent bg-background/60 hover:border-border',
              )}
            >
              <span className="flex items-center justify-between text-xs text-muted-foreground">
                <span>SCENE {String(index + 1).padStart(2, '0')}</span>
                <span>{item.start.toFixed(1)}–{item.end.toFixed(1)}s</span>
              </span>
              <span className="mt-1.5 line-clamp-2 whitespace-pre-line text-sm font-medium leading-5">{item.text}</span>
              <span className="mt-2 inline-flex rounded-md bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground">{item.animation}</span>
            </button>
          ))}
        </div>
      </aside>

      <section className="flex min-w-0 flex-col p-4 lg:p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-medium text-primary">{previewAll ? '全片预览' : `SCENE ${String(selectedScene + 1).padStart(2, '0')}`}</p>
            <h2 className="mt-1 text-lg font-semibold">Remotion 实时画面</h2>
          </div>
          <Button variant="outline" onClick={onPreviewAll}><Play data-icon />预览全片</Button>
        </div>
        <div className="mx-auto flex min-h-[470px] w-full max-w-3xl flex-1 items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-[#030711] p-3 shadow-[0_22px_60px_rgba(2,8,23,0.22)]">
          <div
            className={cn(
              'overflow-hidden rounded-xl shadow-2xl',
              project.renderInput.composition.width === project.renderInput.composition.height
                ? 'aspect-square h-auto w-full max-w-[500px]'
                : project.renderInput.composition.width > project.renderInput.composition.height
                  ? 'aspect-video w-full'
                  : 'h-[470px] aspect-[9/16]',
            )}
          >
            <RemotionPreview input={project.renderInput} selectedScene={scene} previewAll={previewAll} />
          </div>
        </div>
      </section>

      <aside className="border-t border-border bg-surface/45 p-5 xl:border-t-0 xl:border-l">
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
        <div className="mt-6 rounded-xl border bg-background/55 p-4">
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
    </div>
  )
}
