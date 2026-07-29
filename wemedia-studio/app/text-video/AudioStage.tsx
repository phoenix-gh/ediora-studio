'use client'

import { Check, CirclePlay, Mic2, RotateCcw, SlidersHorizontal } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { TextVideoFixtureProject } from '@/lib/text-video/fixture'
import { cn } from '@/lib/utils'

export function AudioStage({
  project,
  selectedParagraph,
  onSelectParagraph,
}: {
  project: TextVideoFixtureProject
  selectedParagraph: number
  onSelectParagraph: (index: number) => void
}) {
  const paragraph = project.paragraphs[selectedParagraph]
  const confirmed = project.paragraphs.filter(item => item.status === 'confirmed').length
  return (
    <div className="grid min-h-[650px] grid-cols-1 border-t border-border xl:grid-cols-[28fr_52fr_20fr]">
      <aside className="border-b border-border bg-surface/60 p-4 xl:border-r xl:border-b-0">
        <div className="mb-3 flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-foreground-subtle">配音段落</p>
          <Badge variant="secondary">{confirmed} / {project.paragraphs.length} 段已确认</Badge>
        </div>
        <div className="space-y-2">
          {project.paragraphs.map((item, index) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectParagraph(index)}
              className={cn(
                'flex w-full items-start gap-3 rounded-xl border p-3 text-left',
                selectedParagraph === index ? 'border-primary/50 bg-primary/8' : 'border-transparent bg-background/60',
              )}
            >
              <span className={cn(
                'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border',
                item.status === 'confirmed' ? 'border-emerald-500/35 bg-emerald-500/12 text-emerald-500' : 'text-muted-foreground',
              )}>
                {item.status === 'confirmed' ? <Check data-icon className="size-3.5" /> : index + 1}
              </span>
              <span>
                <span className="line-clamp-2 text-sm leading-5">{item.text}</span>
                <span className="mt-1 block text-xs text-muted-foreground">{item.duration.toFixed(1)} 秒</span>
              </span>
            </button>
          ))}
        </div>
      </aside>

      <section className="flex flex-col p-5 lg:p-7">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium text-primary">段落 {String(selectedParagraph + 1).padStart(2, '0')}</p>
            <h2 className="mt-1 text-lg font-semibold">试听与确认</h2>
          </div>
          <Badge variant={paragraph.status === 'confirmed' ? 'default' : 'secondary'}>
            {paragraph.status === 'confirmed' ? '已确认' : '待确认'}
          </Badge>
        </div>
        <blockquote className="mt-7 border-l-2 border-primary pl-4 text-lg leading-8">{paragraph.text}</blockquote>
        <div className="mt-8 rounded-2xl border bg-surface p-5">
          <div className="flex h-28 items-center gap-1 overflow-hidden">
            {Array.from({ length: 52 }, (_, index) => (
              <span
                key={index}
                className="min-w-0 flex-1 rounded-full bg-primary/40"
                style={{ height: `${18 + ((index * 17) % 70)}%` }}
              />
            ))}
          </div>
          <div className="mt-4 flex items-center justify-between">
            <Button size="icon" variant="secondary" aria-label="播放当前段落" disabled>
              <CirclePlay data-icon />
            </Button>
            <span className="font-mono text-xs text-muted-foreground">00:00 / 00:{String(Math.ceil(paragraph.duration)).padStart(2, '0')}</span>
          </div>
        </div>
        <p className="mt-4 text-center text-xs text-muted-foreground">演示波形 · MiMo 接入后可生成和试听真实音频</p>
      </section>

      <aside className="border-t border-border bg-surface/45 p-5 xl:border-t-0 xl:border-l">
        <div className="flex items-center gap-2">
          <Mic2 data-icon className="size-4 text-primary" />
          <p className="text-sm font-semibold">音色设置</p>
        </div>
        <Field className="mt-5">
          <FieldLabel>使用音色</FieldLabel>
          <Select defaultValue="lin-xiao">
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="lin-xiao">林晓 · 清晰叙事</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <FieldDescription>当前为界面演示音色。</FieldDescription>
        </Field>
        <div className="mt-6 rounded-xl border bg-background/55 p-4">
          <div className="flex items-center gap-2 text-sm font-medium"><SlidersHorizontal data-icon className="size-4" />语音参数</div>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
            <div><dt className="text-muted-foreground">语速</dt><dd className="mt-1 font-medium">1.0×</dd></div>
            <div><dt className="text-muted-foreground">音调</dt><dd className="mt-1 font-medium">0</dd></div>
            <div><dt className="text-muted-foreground">音量</dt><dd className="mt-1 font-medium">100%</dd></div>
            <div><dt className="text-muted-foreground">格式</dt><dd className="mt-1 font-medium">MP3</dd></div>
          </dl>
        </div>
        <Button className="mt-6 w-full" variant="outline" disabled><RotateCcw data-icon />重新生成当前段</Button>
      </aside>
    </div>
  )
}
