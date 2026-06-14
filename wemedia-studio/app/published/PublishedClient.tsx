'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Publication, updatePublication } from '@/lib/api/published'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

const STAT_FIELDS: { key: 'read_count' | 'like_count' | 'look_count' | 'share_count'; label: string }[] = [
  { key: 'read_count', label: '阅读' },
  { key: 'like_count', label: '点赞' },
  { key: 'look_count', label: '在看' },
  { key: 'share_count', label: '分享' },
]

export function PublishedClient({ initial }: { initial: Publication[] }) {
  const [rows, setRows] = useState<Publication[]>(initial)
  const [saving, setSaving] = useState<number | null>(null)

  function patchLocal(id: number, patch: Partial<Publication>) {
    setRows(rs => rs.map(r => (r.id === id ? { ...r, ...patch } : r)))
  }

  async function save(row: Publication) {
    setSaving(row.id)
    try {
      const updated = await updatePublication(row.id, {
        url: row.url,
        read_count: row.read_count,
        like_count: row.like_count,
        look_count: row.look_count,
        share_count: row.share_count,
      })
      patchLocal(row.id, updated)
      toast.success('已保存')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(null)
    }
  }

  async function markPublished(row: Publication) {
    setSaving(row.id)
    try {
      const updated = await updatePublication(row.id, { status: 'published' })
      patchLocal(row.id, updated)
      toast.success('已标记发布')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败')
    } finally {
      setSaving(null)
    }
  }

  if (rows.length === 0) {
    return (
      <div className="text-sm text-zinc-400 border border-dashed border-zinc-200 dark:border-zinc-800 rounded-xl p-8 text-center">
        暂无发布记录——从草稿箱发布到公众号后会自动出现在这里。
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {rows.map(row => (
        <div key={row.id} className="border border-zinc-200 dark:border-zinc-800 rounded-xl p-4">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">{row.title || '(无标题)'}</p>
              <p className="text-xs text-zinc-400">
                {row.account_name || row.account_id} · {row.status === 'published' ? '已发布' : '草稿箱'}
                {row.published_at ? ` · ${row.published_at.slice(0, 10)}` : ''}
              </p>
            </div>
            {row.status !== 'published' && (
              <Button size="sm" variant="outline" disabled={saving === row.id} onClick={() => markPublished(row)}>
                标记已发布
              </Button>
            )}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            {STAT_FIELDS.map(f => (
              <label key={f.key} className="text-xs text-zinc-500">
                <span className="block mb-1">{f.label}</span>
                <Input
                  type="number" min={0} value={row[f.key]}
                  onChange={e => patchLocal(row.id, { [f.key]: Math.max(0, Number(e.target.value)) } as Partial<Publication>)}
                  className="h-9 w-24 text-sm"
                />
              </label>
            ))}
            <label className="text-xs text-zinc-500 flex-1 min-w-[200px]">
              <span className="block mb-1">文章 URL（可选）</span>
              <Input
                value={row.url}
                onChange={e => patchLocal(row.id, { url: e.target.value })}
                placeholder="https://mp.weixin.qq.com/s/..."
                className="h-9 text-sm"
              />
            </label>
            <Button size="sm" disabled={saving === row.id} onClick={() => save(row)}>保存</Button>
          </div>
        </div>
      ))}
    </div>
  )
}
