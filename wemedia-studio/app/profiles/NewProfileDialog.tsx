'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { createProfile, type ProfileSummary } from '@/lib/api/profiles'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  candidates: ProfileSummary[]
  onCreated: (id: string) => void
}

const ID_RE = /^[a-zA-Z0-9_-]+$/

export function NewProfileDialog({ open, onOpenChange, candidates, onCreated }: Props) {
  const [id, setId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [cloneFrom, setCloneFrom] = useState<string>('default')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)

  function reset() {
    setId('')
    setDisplayName('')
    setCloneFrom('default')
    setDescription('')
  }

  async function handleCreate() {
    if (!ID_RE.test(id)) {
      toast.error('agent id 只允许字母/数字/下划线/横线')
      return
    }
    setBusy(true)
    try {
      const meta = await createProfile({
        id,
        display_name: displayName || id,
        clone_from: cloneFrom,
        description,
      })
      toast.success(`已创建 ${meta.id}`)
      reset()
      onOpenChange(false)
      onCreated(meta.id)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建 Agent Profile</DialogTitle>
          <DialogDescription>
            通过 hermes CLI 克隆现有 profile 作为模板。agent id 不可改名。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Agent ID（不可改）</Label>
            <Input
              placeholder="wms_my_agent"
              value={id}
              onChange={e => setId(e.target.value.trim())}
              disabled={busy}
            />
          </div>
          <div className="space-y-1">
            <Label>显示名</Label>
            <Input
              placeholder="选填，留空用 id"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="space-y-1">
            <Label>克隆来源</Label>
            <Select value={cloneFrom} onValueChange={v => setCloneFrom(v as string)} disabled={busy}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {candidates.map(p => (
                  <SelectItem key={p.name} value={p.name}>
                    {p.display_name || p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>描述（kanban 路由用）</Label>
            <textarea
              className="w-full min-h-[80px] rounded border bg-background p-2 text-sm"
              placeholder="一两句话说明这个 agent 擅长什么"
              value={description}
              onChange={e => setDescription(e.target.value)}
              disabled={busy}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button onClick={handleCreate} disabled={busy || !id}>
            {busy ? '创建中…' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
