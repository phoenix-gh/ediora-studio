import { useState } from 'react'
import { Trash2 } from 'lucide-react'

import { AsyncState } from '@/components/layout/AsyncState'
import { SplitWorkspace } from '@/components/layout/SplitWorkspace'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import type { CreativeAsset, CreativeAssetDirectory } from '@/lib/api/assets'
import { MarkdownEditor, type MarkdownEditorMode } from '@/components/MarkdownEditor'

const UNCATEGORIZED_DIRECTORY = '__uncategorized__'

export function formatArticleUpdatedAt(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const two = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
}

export function articleListTitle(asset: Pick<CreativeAsset, 'title' | 'content'>) {
  const savedTitle = asset.title.trim()
  if (savedTitle) return savedTitle
  const firstBodyLine = asset.content.split(/\r?\n/).find(line => line.trim())
  const bodyTitle = firstBodyLine?.trim().replace(/^#{1,6}\s*/, '').trim()
  return bodyTitle || '未命名文章'
}

type ArticleAssetWorkspaceProps = {
  assets: CreativeAsset[]
  directories: CreativeAssetDirectory[]
  selected: CreativeAsset | undefined
  isSaving?: boolean
  onSelect: (id: number) => void
  onChange: (asset: CreativeAsset) => void
  onSave: () => void
  onDelete: () => void
}

export function ArticleAssetWorkspace({ assets, directories, selected, isSaving = false, onSelect, onChange, onSave, onDelete }: ArticleAssetWorkspaceProps) {
  const [editorMode, setEditorMode] = useState<MarkdownEditorMode>('visual')

  return (
    <SplitWorkspace
      editorLabel="素材编辑器"
      listLabel="素材列表"
      list={assets.length ? <div className="divide-y divide-border">
        {assets.map(asset => {
          const updatedAt = formatArticleUpdatedAt(asset.updated_at)
          return <button key={asset.id} className={cn('relative block w-full px-4 py-3 text-left hover:bg-muted/70', selected?.id === asset.id && 'bg-primary/10 before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-primary')} onClick={() => onSelect(asset.id)} type="button">
            <span className="block truncate text-sm font-medium">{articleListTitle(asset)}</span>
            {updatedAt ? <time className="mt-1 block text-[10px] text-muted-foreground" dateTime={asset.updated_at}>更新于 {updatedAt}</time> : null}
          </button>
        })}
      </div> : <AsyncState description="新增文章素材后会显示在这里。" title="当前目录没有素材" variant="empty" />}
      editor={selected ? <div className="flex h-full min-h-0 flex-col p-6">
        <div className="flex items-center gap-2">
          <Input aria-label="文章标题" className="max-w-xl border-0 bg-transparent px-0 text-lg font-semibold shadow-none dark:bg-transparent" onChange={event => onChange({ ...selected, title: event.target.value })} placeholder="文章标题" value={selected.title} />
          <Button className="ml-auto" onClick={onDelete} size="sm" variant="destructive"><Trash2 />删除</Button>
          <Button disabled={isSaving} onClick={onSave} size="sm">{isSaving ? '保存中…' : '保存'}</Button>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Select onValueChange={value => onChange({ ...selected, directory: value === UNCATEGORIZED_DIRECTORY ? '' : value ?? '' })} value={selected.directory || UNCATEGORIZED_DIRECTORY}>
            <SelectTrigger aria-label="所属目录" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={UNCATEGORIZED_DIRECTORY}>未分类</SelectItem>
              {directories.map(directory => <SelectItem key={directory.id} value={directory.name}>{directory.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Input aria-label="来源 URL" onChange={event => onChange({ ...selected, url: event.target.value })} placeholder="来源 URL（可留空）" value={selected.url} />
        </div>
        <div className="mt-4 min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-surface">
          <MarkdownEditor
            documentKey={selected.id}
            key={selected.id}
            mode={editorMode}
            onChange={content => onChange({ ...selected, content })}
            onModeChange={setEditorMode}
            value={selected.content}
          />
        </div>
      </div> : <AsyncState description="从左侧素材列表选择文章开始编辑。" title="尚未选择素材" variant="empty" />}
    />
  )
}
