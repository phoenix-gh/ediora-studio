'use client'

import { Archive, Plus, RefreshCw, Trash2, Video } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { creativeAssetUrl } from '@/lib/api/assets'
import {
  archiveDigitalHuman,
  deleteDigitalHuman,
  retryDigitalHuman,
  type DigitalHuman,
} from '@/lib/api/digital-humans'


const statusCopy: Record<DigitalHuman['status'], string> = {
  processing: '处理中',
  ready: '可以创作',
  failed: '处理失败',
  archived: '已归档',
}


export function RoleLibrary({
  roles,
  onCreate,
  onChanged,
  onStartProject,
}: {
  roles: DigitalHuman[]
  onCreate: () => void
  onChanged: (role: DigitalHuman | null) => void
  onStartProject: (role: DigitalHuman) => void
}) {
  if (!roles.length) {
    return (
      <Empty className="min-h-80 border">
        <EmptyHeader>
          <EmptyMedia variant="icon"><Video /></EmptyMedia>
          <EmptyTitle>还没有数字人角色</EmptyTitle>
          <EmptyDescription>
            从一张正面照和一段录音开始创建第一个口播角色。
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={onCreate}>
            <Plus data-icon="inline-start" />
            创建数字人
          </Button>
        </EmptyContent>
      </Empty>
    )
  }

  async function remove(role: DigitalHuman) {
    try {
      if ((role.project_count ?? 0) > 0) {
        onChanged(await archiveDigitalHuman(role.id))
        toast.success('角色已归档')
      } else {
        await deleteDigitalHuman(role.id)
        onChanged(null)
        toast.success('角色已删除')
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '操作失败')
    }
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {roles.map(role => (
        <Card key={role.id}>
          {role.portrait ? (
            <img
              src={creativeAssetUrl(role.portrait.url)}
              alt={role.name}
              className="aspect-[4/3] w-full object-cover"
            />
          ) : null}
          <CardHeader>
            <CardTitle>{role.name}</CardTitle>
            <CardDescription>
              {role.project_count ?? 0} 个口播作品
            </CardDescription>
            <CardAction>
              <Badge variant={role.status === 'failed' ? 'destructive' : 'secondary'}>
                {statusCopy[role.status]}
              </Badge>
            </CardAction>
          </CardHeader>
          <CardContent>
            <p className="truncate text-sm text-muted-foreground">
              默认环境：{role.default_environment?.title || '未设置'}
            </p>
            {role.error ? (
              <p className="mt-2 text-sm text-destructive">{role.error}</p>
            ) : null}
          </CardContent>
          <CardFooter className="gap-2">
            {role.status === 'ready' ? (
              <Button onClick={() => onStartProject(role)}>
                <Video data-icon="inline-start" />
                新建口播
              </Button>
            ) : null}
            {role.status === 'failed' ? (
              <Button
                variant="outline"
                onClick={async () => onChanged(await retryDigitalHuman(role.id))}
              >
                <RefreshCw data-icon="inline-start" />
                重试
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => void remove(role)}>
              {(role.project_count ?? 0) > 0
                ? <Archive data-icon="inline-start" />
                : <Trash2 data-icon="inline-start" />}
              {(role.project_count ?? 0) > 0 ? '归档' : '删除'}
            </Button>
          </CardFooter>
        </Card>
      ))}
    </div>
  )
}
