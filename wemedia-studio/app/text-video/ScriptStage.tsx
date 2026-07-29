'use client'

import { Clock3, Sparkles } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'
import type { TextVideoFixtureProject } from '@/lib/text-video/fixture'
import { cn } from '@/lib/utils'

export function ScriptStage({
  project,
  selectedParagraph,
  onSelectParagraph,
  onParagraphTextChange,
}: {
  project: TextVideoFixtureProject
  selectedParagraph: number
  onSelectParagraph: (index: number) => void
  onParagraphTextChange?: (text: string) => void
}) {
  const paragraph = project.paragraphs[selectedParagraph]
  return (
    <div data-testid="editor-workspace" className="grid min-h-[650px] grid-cols-[28fr_52fr_20fr] border-border">
      <aside className="border-r border-border bg-surface/60 p-4">
        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-foreground-subtle">口播段落</p>
        <div className="space-y-2">
          {project.paragraphs.map((item, index) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectParagraph(index)}
              className={cn(
                'w-full rounded-xl border p-3 text-left transition-colors',
                selectedParagraph === index
                  ? 'border-primary/50 bg-primary/8'
                  : 'border-transparent bg-background/60 hover:border-border',
              )}
            >
              <span className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                <span>段落 {String(index + 1).padStart(2, '0')}</span>
                <span className="inline-flex items-center gap-1"><Clock3 data-icon className="size-3" />{item.duration.toFixed(1)}s</span>
              </span>
              <span className="line-clamp-2 text-sm leading-6">{item.text}</span>
            </button>
          ))}
        </div>
      </aside>

      <section className="p-5 lg:p-7">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium text-primary">段落 {String(selectedParagraph + 1).padStart(2, '0')}</p>
            <h2 className="mt-1 text-lg font-semibold">编辑口播稿</h2>
          </div>
          <Button variant="outline" disabled title="AI 导演将在下一阶段接入">
            <Sparkles data-icon />AI 优化分镜
          </Button>
        </div>
        <Field>
          <FieldLabel htmlFor="text-video-script">口播内容</FieldLabel>
          <Textarea
            id="text-video-script"
            value={paragraph.text}
            readOnly={!onParagraphTextChange}
            onChange={event => onParagraphTextChange?.(event.target.value)}
            className="min-h-52 resize-none bg-surface text-base leading-8"
          />
          <FieldDescription>修改口播内容后，需要重新生成这一段配音。</FieldDescription>
        </Field>
        <div className="mt-6 rounded-xl border border-dashed border-primary/30 bg-primary/5 p-4">
          <p className="text-sm font-medium">AI 视觉导演</p>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            后续可用自然语言要求 AI 拆分画面、压缩屏显文字、选择关键词与模板支持的动效。
          </p>
        </div>
      </section>

      <aside className="border-l border-border bg-surface/45 p-5">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-foreground-subtle">稿件信息</p>
        <dl className="mt-5 space-y-4 text-sm">
          <div><dt className="text-muted-foreground">段落数量</dt><dd className="mt-1 font-medium">{project.paragraphs.length} 段</dd></div>
          <div><dt className="text-muted-foreground">预计时长</dt><dd className="mt-1 font-medium">{project.paragraphs.reduce((sum, item) => sum + item.duration, 0).toFixed(1)} 秒</dd></div>
          <div><dt className="text-muted-foreground">分镜方式</dt><dd className="mt-1 font-medium">按语义节奏拆分</dd></div>
        </dl>
        <Button className="mt-7 w-full" disabled>生成配音（待接入 MiMo）</Button>
      </aside>
    </div>
  )
}
