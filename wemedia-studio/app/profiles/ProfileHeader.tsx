'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2, Pencil, Sparkles, Trash2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  deleteProfile,
  generateAvatar,
  updateProfileMeta,
  uploadAvatar,
  type ProfileDetail,
} from '@/lib/api/profiles'
import { API_BASE } from '@/lib/api/client'

function absoluteAvatar(url: string): string {
  if (!url) return ''
  if (url.startsWith('http')) return url
  if (url.startsWith('/api/')) {
    const root = API_BASE.replace(/\/api$/, '')
    return `${root}${url}`
  }
  return url
}

function Avatar({ url, name, size = 56 }: { url: string; name: string; size?: number }) {
  const initial = (name || '?').slice(0, 2).toUpperCase()
  const src = absoluteAvatar(url)
  if (src) {
    return (
      <img
        src={src}
        alt={name}
        className="rounded-full object-cover bg-muted"
        style={{ width: size, height: size }}
      />
    )
  }
  return (
    <div
      className="rounded-full bg-muted flex items-center justify-center text-muted-foreground font-medium"
      style={{ width: size, height: size, fontSize: size * 0.35 }}
    >
      {initial}
    </div>
  )
}

interface Props {
  detail: ProfileDetail
  onChanged: (next: Partial<ProfileDetail>) => void
  onDeleted: () => void
}

export function ProfileHeader({ detail, onChanged, onDeleted }: Props) {
  const readonly = detail.is_default
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState(detail.display_name)
  const [descDraft, setDescDraft] = useState(detail.description)

  useEffect(() => {
    setNameDraft(detail.display_name)
    setDescDraft(detail.description)
    setEditingName(false)
  }, [detail.name])
  const [savingDesc, setSavingDesc] = useState(false)
  const [busyAvatar, setBusyAvatar] = useState(false)
  const [genOpen, setGenOpen] = useState(false)
  const [genPrompt, setGenPrompt] = useState('')
  const [confirmDel, setConfirmDel] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  async function commitName() {
    setEditingName(false)
    const val = nameDraft.trim() || detail.name
    if (val === detail.display_name) return
    try {
      const meta = await updateProfileMeta(detail.name, { display_name: val })
      onChanged({ display_name: meta.display_name })
      toast.success('已更新显示名')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
      setNameDraft(detail.display_name)
    }
  }

  async function saveDesc() {
    if (descDraft === detail.description) return
    setSavingDesc(true)
    try {
      const meta = await updateProfileMeta(detail.name, { description: descDraft })
      onChanged({ description: meta.description })
      toast.success('描述已保存')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setSavingDesc(false)
    }
  }

  async function onUpload(file: File) {
    setBusyAvatar(true)
    try {
      const { avatar_url } = await uploadAvatar(detail.name, file)
      onChanged({ avatar_url })
      toast.success('头像已更新')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyAvatar(false)
    }
  }

  async function onGenerate() {
    if (!genPrompt.trim()) {
      toast.error('请输入 prompt')
      return
    }
    setBusyAvatar(true)
    try {
      const { avatar_url } = await generateAvatar(detail.name, genPrompt)
      onChanged({ avatar_url })
      setGenOpen(false)
      setGenPrompt('')
      toast.success('头像已生成')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyAvatar(false)
    }
  }

  async function onDelete() {
    setConfirmDel(false)
    try {
      await deleteProfile(detail.name)
      toast.success(`已删除 ${detail.name}`)
      onDeleted()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="mb-6 flex items-start gap-4">
      <Popover>
        <PopoverTrigger
          disabled={readonly || busyAvatar}
          className="relative shrink-0 rounded-full focus:outline-none disabled:opacity-60"
        >
          <Avatar url={detail.avatar_url} name={detail.display_name || detail.name} />
          {busyAvatar && (
            <span className="absolute inset-0 flex items-center justify-center rounded-full bg-background/70">
              <Loader2 className="size-5 animate-spin" />
            </span>
          )}
        </PopoverTrigger>
        <PopoverContent className="w-44 p-1">
          <button
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
            onClick={() => fileRef.current?.click()}
          >
            <Upload className="size-4" /> 上传图片
          </button>
          <button
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
            onClick={() => setGenOpen(true)}
          >
            <Sparkles className="size-4" /> AI 生成
          </button>
        </PopoverContent>
      </Popover>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={e => {
          const f = e.target.files?.[0]
          if (f) onUpload(f)
          e.target.value = ''
        }}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {editingName ? (
            <Input
              autoFocus
              value={nameDraft}
              onChange={e => setNameDraft(e.target.value)}
              onBlur={commitName}
              onKeyDown={e => {
                if (e.key === 'Enter') commitName()
                if (e.key === 'Escape') {
                  setEditingName(false)
                  setNameDraft(detail.display_name)
                }
              }}
              className="h-8 max-w-sm text-xl font-semibold"
            />
          ) : (
            <>
              <h1 className="truncate text-xl font-semibold">
                {detail.display_name || detail.name}
              </h1>
              {!readonly && (
                <button
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setNameDraft(detail.display_name || detail.name)
                    setEditingName(true)
                  }}
                  title="改显示名"
                >
                  <Pencil className="size-3.5" />
                </button>
              )}
            </>
          )}
          {readonly && <span className="text-xs text-muted-foreground">(default · 只读)</span>}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground font-mono">{detail.name}</div>
        <div className="mt-3">
          <textarea
            value={descDraft}
            onChange={e => setDescDraft(e.target.value)}
            onBlur={saveDesc}
            disabled={readonly || savingDesc}
            placeholder="描述（kanban 路由会读取）"
            className="min-h-[48px] w-full max-w-2xl resize-y rounded border bg-background p-2 text-xs disabled:opacity-60"
          />
        </div>
      </div>
      {!readonly && (
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 text-destructive"
          onClick={() => setConfirmDel(true)}
        >
          <Trash2 className="size-4" /> 删除
        </Button>
      )}

      <Dialog open={genOpen} onOpenChange={setGenOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>AI 生成头像</DialogTitle>
          </DialogHeader>
          <textarea
            value={genPrompt}
            onChange={e => setGenPrompt(e.target.value)}
            placeholder="如：一只戴眼镜的赛博朋克猫头鹰，复古插画风"
            className="min-h-[120px] w-full rounded border bg-background p-2 text-sm"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setGenOpen(false)} disabled={busyAvatar}>
              取消
            </Button>
            <Button onClick={onGenerate} disabled={busyAvatar || !genPrompt.trim()}>
              {busyAvatar ? '生成中…' : '生成'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmDel} onOpenChange={setConfirmDel}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除 {detail.name}？</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            将通过 hermes CLI 删除 profile 目录，并从数据库硬删除元数据 + SOUL 备份历史。此操作不可恢复。
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDel(false)}>取消</Button>
            <Button onClick={onDelete} className="bg-destructive text-destructive-foreground">
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export { Avatar }
