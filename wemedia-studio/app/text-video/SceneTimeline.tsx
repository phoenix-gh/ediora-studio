'use client'

import { Music2, Plus, Sparkles } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { TextVideoFixtureProject } from '@/lib/text-video/fixture'
import { cn } from '@/lib/utils'

export function SceneTimeline({
  project,
  selectedScene,
  onSelectScene,
}: {
  project: TextVideoFixtureProject
  selectedScene: number
  onSelectScene: (index: number) => void
}) {
  return (
    <section data-testid="scene-timeline" className="col-span-3 border-t border-border bg-surface">
      <div className="flex h-32">
        <div className="flex w-[170px] shrink-0 flex-col justify-center gap-2 border-r border-border px-3">
          <Button size="sm" variant="outline" disabled><Plus data-icon />添加场景</Button>
          <Button size="sm" variant="ghost" disabled><Sparkles data-icon />智能排序</Button>
        </div>
        <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto p-3">
          {project.renderInput.segments.map((scene, index) => (
            <button
              key={scene.id}
              type="button"
              onClick={() => onSelectScene(index)}
              className={cn(
                'w-40 shrink-0 rounded-lg border bg-background p-2 text-left transition-colors',
                selectedScene === index ? 'border-primary ring-2 ring-primary/15' : 'border-border hover:border-primary/40',
              )}
            >
              <span className="flex items-center justify-between text-[10px] text-muted-foreground">
                <span>{String(index + 1).padStart(2, '0')}</span>
                <span>{(scene.end - scene.start).toFixed(1)}s</span>
              </span>
              <span className="mt-1 flex h-12 items-center justify-center rounded-md bg-[#07111f] px-2 text-center text-[11px] font-medium leading-4 text-cyan-50">
                {scene.text.replace('\n', ' · ')}
              </span>
              <span className="mt-1 block truncate text-[10px] text-muted-foreground">{scene.animation}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="flex h-9 items-center border-t border-border px-4 text-xs text-muted-foreground">
        <Music2 data-icon className="mr-2 size-3.5" />
        <span className="w-28 shrink-0">配音音频</span>
        <div className="flex h-4 flex-1 items-center gap-0.5 overflow-hidden rounded bg-muted px-2">
          {Array.from({ length: 96 }, (_, index) => (
            <span key={index} className="w-px shrink-0 bg-primary/45" style={{ height: `${20 + (index * 19) % 75}%` }} />
          ))}
        </div>
      </div>
    </section>
  )
}
