'use client'

import { Check, Clock3, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { cancelJob } from '@/lib/api/jobs'
import {
  deleteTalkingVideoRender,
  selectTalkingVideoRender,
  type TalkingVideoProject,
  type TalkingVideoRender,
} from '@/lib/api/digital-humans'

import { formatRenderCreatedAt } from './render-time'


const statusLabel: Record<TalkingVideoRender['status'], string> = {
  queued: '等待中',
  running: '生成中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
}


export function RenderVersionsPanel({
  projectId,
  renders,
  currentRenderId,
  onChanged,
}: {
  projectId: number
  renders: TalkingVideoRender[]
  currentRenderId: number | null
  onChanged?: (project?: TalkingVideoProject) => void
}) {
  async function select(render: TalkingVideoRender) {
    try {
      onChanged?.(await selectTalkingVideoRender(projectId, render.id))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '版本选择失败')
    }
  }

  async function stop(render: TalkingVideoRender) {
    try {
      if (render.job_id) await cancelJob(render.job_id)
      onChanged?.()
    } catch (error) {
      onChanged?.()
      toast.error(error instanceof Error ? error.message : '停止失败')
    }
  }

  async function remove(render: TalkingVideoRender) {
    try {
      await deleteTalkingVideoRender(projectId, render.id)
      onChanged?.()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '版本删除失败')
    }
  }

  if (!renders.length) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        还没有生成记录
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {renders.map((render, index) => (
        <div key={render.id}>
          {index > 0 ? <Separator className="mb-3" /> : null}
          <Card size="sm">
            <CardHeader>
              <CardTitle>版本 {render.version}</CardTitle>
              <CardDescription>
                {formatRenderCreatedAt(render.created_at)}
              </CardDescription>
              <CardAction>
                <Badge variant={render.status === 'failed' ? 'destructive' : 'secondary'}>
                  {currentRenderId === render.id ? '当前 · ' : ''}
                  {statusLabel[render.status]}
                </Badge>
              </CardAction>
            </CardHeader>
            {render.error ? (
              <CardContent>
                <p className="text-sm text-destructive">{render.error}</p>
              </CardContent>
            ) : null}
            <CardContent className="flex gap-2">
              {render.status === 'succeeded' && currentRenderId !== render.id ? (
                <Button size="sm" variant="outline" onClick={() => void select(render)}>
                  <Check data-icon="inline-start" />
                  设为当前
                </Button>
              ) : null}
              {['failed', 'cancelled'].includes(render.status) ? (
                <Button size="sm" variant="ghost" onClick={() => void remove(render)}>
                  <Trash2 data-icon="inline-start" />
                  删除
                </Button>
              ) : null}
              {['queued', 'running'].includes(render.status) ? (
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock3 />
                    {render.digital_human_snapshot?.provider === 'comfyui'
                      ? '正在拼接成片'
                      : 'HeyGen 正在处理'}
                  </span>
                  <Button size="sm" variant="outline" onClick={() => void stop(render)}>
                    停止
                  </Button>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>
      ))}
    </div>
  )
}
