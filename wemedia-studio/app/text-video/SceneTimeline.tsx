'use client'

import { Music2 } from 'lucide-react'

import type { TextVideoProject } from '@/lib/api/text-videos'
import { creativeAssetUrl } from '@/lib/api/assets'
import { canPreviewVideo } from '@/lib/text-video/project-merge'
import { cn } from '@/lib/utils'


export function SceneTimeline({
  project,
  selectedSceneId,
  onSelectScene,
}: {
  project: TextVideoProject
  selectedSceneId: string
  onSelectScene(sceneId: string): void
}) {
  const duration = project.master_audio.duration
  const scenes = project.render_input.segments
  const validDuration = Number.isFinite(duration) && duration > 0
  const validIntervals = (
    canPreviewVideo(project)
    && validDuration
    && scenes.every(scene => (
    Number.isFinite(scene.start)
    && Number.isFinite(scene.end)
    && scene.start >= 0
    && scene.end > scene.start
    && scene.end <= duration
    ))
  )

  return (
    <section
      data-testid="scene-timeline"
      className="col-span-3 border-t border-border bg-surface"
    >
      <div className="grid min-h-32 grid-cols-[170px_1fr]">
        <div className="flex flex-col justify-center border-r border-border px-4">
          <p className="text-xs font-semibold text-foreground">画面时间轴</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {validDuration
              ? `主音频 · ${duration.toFixed(1)} 秒`
              : '主音频时长不可用'}
          </p>
        </div>
        <div className="min-w-0 overflow-x-auto px-4 py-3">
          <div className="min-w-[760px]">
            {validIntervals && scenes.length > 0 ? (
              <>
                <div
                  aria-label="分镜时间区间"
                  className="relative h-16 overflow-hidden rounded-lg border border-border bg-muted/40"
                >
                  {scenes.map((scene, index) => {
                    const left = `${(scene.start / duration) * 100}%`
                    const width = `${
                      ((scene.end - scene.start) / duration) * 100
                    }%`
                    return (
                      <button
                        key={scene.id}
                        type="button"
                        data-testid="timeline-scene"
                        aria-label={`时间轴场景 ${String(index + 1).padStart(2, '0')}`}
                        title={`${scene.start.toFixed(1)}–${scene.end.toFixed(1)} 秒`}
                        onClick={() => onSelectScene(scene.id)}
                        style={{ left, width }}
                        className={cn(
                          'absolute inset-y-0 overflow-hidden border-r border-background/70 px-2 text-left',
                          selectedSceneId === scene.id
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-primary/12 text-foreground hover:bg-primary/20',
                        )}
                      >
                        <span className="block truncate text-[10px] font-semibold">
                          {String(index + 1).padStart(2, '0')} · {
                            (scene.end - scene.start).toFixed(1)
                          }s
                        </span>
                        <span className="mt-1 block truncate text-[11px]">
                          {scene.text}
                        </span>
                      </button>
                    )
                  })}
                </div>
                <div className="mt-1 flex justify-between font-mono text-[10px] text-muted-foreground">
                  <span>0.0s</span>
                  <span>{duration.toFixed(1)}s</span>
                </div>
              </>
            ) : (
              <div
                role={validDuration ? 'status' : 'alert'}
                className="flex h-16 items-center justify-center rounded-lg border border-dashed border-border text-xs text-muted-foreground"
              >
                {validDuration
                  ? '生成分镜后将在这里显示真实时间区间'
                  : '主音频时间轴无效，无法绘制分镜区间'}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="grid min-h-14 grid-cols-[170px_1fr] border-t border-border">
        <div className="flex items-center border-r border-border px-4 text-xs text-muted-foreground">
          <Music2 data-icon className="mr-2 size-3.5" />
          配音音频
        </div>
        <div className="flex min-w-0 items-center gap-3 px-4 py-2">
          {project.master_audio.audio_url ? (
            <audio
              aria-label="主音频"
              className="h-9 min-w-0 flex-1"
              controls
              preload="metadata"
              src={creativeAssetUrl(project.master_audio.audio_url)}
            />
          ) : (
            <p className="text-xs text-muted-foreground">
              主音频文件尚未生成
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
