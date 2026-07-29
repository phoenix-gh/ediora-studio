'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMemo, useState } from 'react'
import {
  Clock3,
  Film,
  Pencil,
  Plus,
  Ratio,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/layout/PageHeader'
import {
  createTextVideoProject,
  deleteTextVideoProject,
  updateTextVideoProject,
  type TextVideoProjectStatus,
  type TextVideoProjectSummary,
} from '@/lib/api/text-videos'
import { cn } from '@/lib/utils'

const filters: Array<{ id: 'all' | TextVideoProjectStatus; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'draft', label: '稿件' },
  { id: 'audio_ready', label: '配音' },
  { id: 'video_ready', label: '合成' },
  { id: 'completed', label: '已完成' },
  { id: 'archived', label: '已归档' },
]

const stageLabel = {
  script: '稿件与分镜',
  audio: '配音制作',
  video: '视频合成',
} as const

export function TextVideoProjectsClient({
  initialProjects,
}: {
  initialProjects: TextVideoProjectSummary[]
}) {
  const router = useRouter()
  const [projects, setProjects] = useState(initialProjects)
  const [filter, setFilter] = useState<'all' | TextVideoProjectStatus>('all')
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<TextVideoProjectSummary | null>(null)
  const [renameTitle, setRenameTitle] = useState('')
  const [deleting, setDeleting] = useState<TextVideoProjectSummary | null>(null)
  const visibleProjects = useMemo(
    () => filter === 'all' ? projects : projects.filter(project => project.status === filter),
    [filter, projects],
  )

  async function createProject() {
    setCreating(true)
    try {
      const project = await createTextVideoProject('未命名文字视频')
      router.push(`/text-video/${project.id}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建作品失败')
    } finally {
      setCreating(false)
    }
  }

  async function renameProject() {
    if (!renaming) return
    try {
      const updated = await updateTextVideoProject(renaming.id, {
        revision: renaming.revision,
        title: renameTitle,
      })
      setProjects(current => current.map(project => (
        project.id === updated.id ? { ...project, ...updated } : project
      )))
      setRenaming(null)
      toast.success('作品已重命名')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '重命名失败')
    }
  }

  async function removeProject() {
    if (!deleting) return
    try {
      await deleteTextVideoProject(deleting.id)
      setProjects(current => current.filter(project => project.id !== deleting.id))
      setDeleting(null)
      toast.success('作品已删除')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除失败')
    }
  }

  return (
    <div className="min-h-full bg-background">
      <PageHeader
        eyebrow="创作 / 文字视频"
        title="文字视频"
        count={`${projects.length} 个作品`}
        description="从稿件、配音到动态文字视频，持续管理每一个创作项目。"
        actions={(
          <Button onClick={() => void createProject()} disabled={creating}>
            <Plus data-icon />
            {creating ? '正在创建' : '新建文字视频'}
          </Button>
        )}
      />

      <div className="px-7 pb-8">
        <div className="mb-5 flex flex-wrap items-center gap-2 border-b border-border pb-4">
          {filters.map(item => (
            <Button
              key={item.id}
              size="sm"
              variant={filter === item.id ? 'secondary' : 'ghost'}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
            </Button>
          ))}
        </div>

        {visibleProjects.length ? (
          <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
            {visibleProjects.map(project => (
              <article key={project.id} className="group overflow-hidden rounded-2xl border border-border bg-surface transition-shadow hover:shadow-md">
                <div className="relative flex h-44 items-center justify-center overflow-hidden border-b border-border bg-[#07111f]">
                  <div className="absolute inset-0 opacity-60 [background-image:linear-gradient(rgba(74,191,220,.1)_1px,transparent_1px),linear-gradient(90deg,rgba(74,191,220,.1)_1px,transparent_1px)] [background-size:24px_24px]" />
                  {project.cover_asset_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={project.cover_asset_url} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <div className="relative flex flex-col items-center text-cyan-100">
                      <Film data-icon className="size-9 text-cyan-300" />
                      <span className="mt-3 max-w-64 truncate px-4 text-sm font-semibold">{project.title}</span>
                    </div>
                  )}
                  <Badge className="absolute left-3 top-3" variant="secondary">{stageLabel[project.stage]}</Badge>
                  <Button
                    aria-label={`删除 ${project.title}`}
                    className="absolute right-2 top-2 opacity-0 group-hover:opacity-100"
                    size="icon-sm"
                    variant="secondary"
                    onClick={() => setDeleting(project)}
                  >
                    <Trash2 data-icon />
                  </Button>
                </div>
                <div className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="truncate text-base font-semibold">{project.title}</h2>
                      <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1"><Ratio data-icon className="size-3.5" />{project.aspect_ratio}</span>
                        <span className="inline-flex items-center gap-1"><Clock3 data-icon className="size-3.5" />{project.duration.toFixed(1)} 秒</span>
                        <span>{formatUpdatedAt(project.updated_at)}</span>
                      </div>
                    </div>
                    <Button
                      aria-label={`重命名 ${project.title}`}
                      size="icon-sm"
                      variant="ghost"
                      onClick={() => {
                        setRenaming(project)
                        setRenameTitle(project.title)
                      }}
                    >
                      <Pencil data-icon />
                    </Button>
                  </div>
                  <div className="mt-4 flex items-center justify-between">
                    <span className={cn(
                      'text-xs',
                      project.status === 'completed' ? 'text-emerald-600' : 'text-muted-foreground',
                    )}>
                      {project.status === 'completed' ? '已生成成片' : '自动保存'}
                    </span>
                    <Link
                      href={`/text-video/${project.id}`}
                      aria-label={`继续编辑 ${project.title}`}
                      className={buttonVariants({ size: 'sm' })}
                    >
                      继续编辑
                    </Link>
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="flex min-h-96 flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-surface/45 text-center">
            <span className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Film data-icon /></span>
            <h2 className="mt-4 text-lg font-semibold">还没有文字视频作品</h2>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">创建第一个项目，从稿件开始组织配音和动态文字场景。</p>
            <Button className="mt-5" onClick={() => void createProject()} disabled={creating}><Plus data-icon />新建文字视频</Button>
          </div>
        )}
      </div>

      <Dialog open={Boolean(renaming)} onOpenChange={open => !open && setRenaming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重命名文字视频</DialogTitle>
            <DialogDescription>名称会显示在作品管理和编辑器顶部。</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="text-video-rename">作品名称</FieldLabel>
            <Input id="text-video-rename" value={renameTitle} onChange={event => setRenameTitle(event.target.value)} />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenaming(null)}>取消</Button>
            <Button onClick={() => void renameProject()}>保存名称</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(deleting)} onOpenChange={open => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除文字视频作品？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除“{deleting?.title}”的项目数据。已上传到创作资产的文件不会被删除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void removeProject()}>确认删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function formatUpdatedAt(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '刚刚更新'
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}
