'use client'

import { useState } from 'react'
import { FileVideo, Plus } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  createTalkingVideo,
  type DigitalHuman,
  type TalkingVideoProject,
} from '@/lib/api/digital-humans'
import { cn } from '@/lib/utils'


export function TalkingProjectList({
  projects,
  roles,
  selectedId,
  onSelect,
  onCreated,
}: {
  projects: TalkingVideoProject[]
  roles: DigitalHuman[]
  selectedId: number | null
  onSelect: (project: TalkingVideoProject) => void
  onCreated: (project: TalkingVideoProject) => void
}) {
  const readyRoles = roles.filter(role => role.status === 'ready')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [roleId, setRoleId] = useState(String(readyRoles[0]?.id ?? ''))
  const [saving, setSaving] = useState(false)

  async function create() {
    if (!roleId) return
    setSaving(true)
    try {
      const project = await createTalkingVideo({
        title: title.trim() || '未命名口播作品',
        digital_human_id: Number(roleId),
      })
      onCreated(project)
      setDialogOpen(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '作品创建失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="flex flex-col gap-3">
        <Button
          variant="outline"
          onClick={() => setDialogOpen(true)}
          disabled={!readyRoles.length}
        >
          <Plus data-icon="inline-start" />
          新建口播作品
        </Button>
        {!projects.length ? (
          <Empty className="min-h-52 border">
            <EmptyHeader>
              <EmptyMedia variant="icon"><FileVideo /></EmptyMedia>
              <EmptyTitle>还没有口播作品</EmptyTitle>
              <EmptyDescription>
                先准备一个可创作的数字人角色，再新建作品。
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent />
          </Empty>
        ) : projects.map(project => (
          <button
            key={project.id}
            type="button"
            onClick={() => onSelect(project)}
            className={cn(
              'rounded-lg border p-3 text-left hover:bg-muted',
              selectedId === project.id && 'bg-muted ring-1 ring-ring',
            )}
          >
            <span className="block truncate font-medium">{project.title}</span>
            <span className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
              {project.role.name}
              <Badge variant="secondary">
                {project.renders?.[0]?.status ?? '未生成'}
              </Badge>
            </span>
          </button>
        ))}
      </div>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建口播作品</DialogTitle>
            <DialogDescription>
              脚本属于当前作品，默认使用角色的环境图。
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="project-title">作品名称</FieldLabel>
              <Input
                id="project-title"
                value={title}
                onChange={event => setTitle(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel>数字人角色</FieldLabel>
              <Select value={roleId} onValueChange={value => value && setRoleId(value)}>
                <SelectTrigger>
                  <SelectValue placeholder="选择已就绪角色" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {readyRoles.map(role => (
                      <SelectItem key={role.id} value={String(role.id)}>
                        {role.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Button onClick={() => void create()} disabled={saving || !roleId}>
              创建并编辑
            </Button>
          </FieldGroup>
        </DialogContent>
      </Dialog>
    </>
  )
}
