'use client'

import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toast } from 'sonner'
import { Loader2, PlayCircle, Rss } from 'lucide-react'

const GROUPS = ['AI 研究员', 'AI 公司', 'AI 创业', '开源大佬', '开源社区', '科技媒体', '学术', '未分组']
const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000/api'

function detectType(path: string): 'youtube' | 'rss' | null {
  if (!path) return null
  if (path.includes('youtube.com') || path.includes('youtu.be')) return 'youtube'
  if (path.startsWith('http') || path.startsWith('/')) return 'rss'
  return null
}

function toAvatar(name: string) {
  const chars = name.replace(/[^a-zA-Z一-龥]/g, '')
  return chars.slice(0, 2) || name.slice(0, 2)
}

function toPlatform(path: string, manual?: string) {
  if (manual) return manual
  if (path.includes('youtube.com')) return 'YouTube'
  if (path.includes('36kr.com') || path.includes('/36kr')) return '36Kr'
  if (path.includes('sspai.com') || path.includes('/sspai')) return '少数派'
  if (path.includes('arxiv.org') || path.includes('/arxiv')) return 'arXiv'
  if (path.includes('hackernews') || path.includes('/hackernews')) return 'HN'
  if (path.includes('weibo') || path.includes('/weibo')) return '微博'
  if (path.includes('zhihu') || path.includes('/zhihu')) return '知乎'
  if (path.includes('github.com') || path.includes('/github')) return 'GitHub'
  return 'RSS'
}

interface Props {
  open: boolean
  onClose: () => void
  onAdded: () => void
}

export function AddAccountDialog({ open, onClose, onAdded }: Props) {
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [group, setGroup] = useState<string>('未分组')
  const [priority, setPriority] = useState<'high' | 'normal'>('normal')
  const [loading, setLoading] = useState(false)

  const type = detectType(path)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !path.trim()) return
    setLoading(true)
    try {
      const id = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      const res = await fetch(`${API}/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          name: name.trim(),
          avatar: toAvatar(name.trim()),
          platform: toPlatform(path),
          group,
          priority,
          muted: false,
          rsshub_path: path.trim(),
        }),
      })
      if (!res.ok) throw new Error(await res.text())

      // 添加后立即触发采集
      fetch(`${API}/collect/account/${id}`, { method: 'POST' }).catch(() => {})

      toast.success(`已添加「${name}」，后台开始采集`)
      setName('')
      setPath('')
      setGroup('未分组')
      setPriority('normal')
      onAdded()
      onClose()
    } catch (err) {
      toast.error(`添加失败：${err}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="text-base">添加订阅源</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label className="text-xs">名称</Label>
            <Input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="如：单向街东京、arXiv cs.AI"
              className="h-8 text-sm"
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">订阅地址</Label>
            <div className="relative">
              <Input
                value={path}
                onChange={e => setPath(e.target.value)}
                placeholder="YouTube 频道链接 或 RSS/RSSHub 路径"
                className="h-8 text-sm pr-8"
                required
              />
              {type && (
                <div className="absolute right-2 top-1/2 -translate-y-1/2">
                  {type === 'youtube'
                    ? <PlayCircle className="w-4 h-4 text-red-500" />
                    : <Rss className="w-4 h-4 text-orange-400" />
                  }
                </div>
              )}
            </div>
            <p className="text-[11px] text-zinc-400">
              {type === 'youtube' && 'YouTube 频道，将通过 yt-dlp 采集'}
              {type === 'rss' && (path.startsWith('http') ? '直接订阅 RSS 地址' : 'RSSHub 路径，如 /hackernews/best')}
              {!type && '支持 https://www.youtube.com/@xxx 或 /rsshub/path 或 https://rss.example.com'}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">分组</Label>
              <Select value={group} onValueChange={v => v && setGroup(v)}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GROUPS.map(g => <SelectItem key={g} value={g} className="text-xs">{g}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">优先级</Label>
              <Select value={priority} onValueChange={v => v && setPriority(v as 'high' | 'normal')}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="high" className="text-xs">⭐ 高优先级</SelectItem>
                  <SelectItem value="normal" className="text-xs">普通</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>取消</Button>
            <Button type="submit" size="sm" disabled={loading || !name || !path}>
              {loading && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
              添加订阅
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
