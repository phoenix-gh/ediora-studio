import { Trash2 } from 'lucide-react'

import { MarkdownEditor } from '@/app/drafts/MarkdownEditor'
import { AsyncState } from '@/components/layout/AsyncState'
import { SplitWorkspace } from '@/components/layout/SplitWorkspace'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { CreativeAsset } from '@/lib/api/assets'
import '@uiw/react-md-editor/markdown-editor.css'

type ArticleAssetWorkspaceProps = {
  assets: CreativeAsset[]
  selected: CreativeAsset | undefined
  onSelect: (id: number) => void
  onChange: (asset: CreativeAsset) => void
  onSave: () => void
  onDelete: () => void
}

export function ArticleAssetWorkspace({ assets, selected, onSelect, onChange, onSave, onDelete }: ArticleAssetWorkspaceProps) {
  return (
    <SplitWorkspace
      editorLabel="素材编辑器"
      listLabel="素材列表"
      list={assets.length ? <div className="divide-y divide-border">
        {assets.map(asset => <button key={asset.id} className={cn('relative block w-full px-5 py-4 text-left hover:bg-muted/70', selected?.id === asset.id && 'bg-primary/10 before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-primary')} onClick={() => onSelect(asset.id)} type="button">
          <div className="flex items-center gap-2"><span className="truncate text-sm font-medium">{asset.title || asset.content.slice(0, 36)}</span><span className="text-[10px] text-muted-foreground">文章</span></div>
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{asset.content}</p>
        </button>)}
      </div> : <AsyncState description="新增文章素材后会显示在这里。" title="当前目录没有素材" variant="empty" />}
      editor={selected ? <div className="flex h-full min-h-0 flex-col p-6">
        <div className="flex items-center gap-2">
          <Input aria-label="文章标题" className="max-w-xl border-0 bg-transparent px-0 text-lg font-semibold shadow-none focus-visible:ring-0" onChange={event => onChange({ ...selected, title: event.target.value })} placeholder="文章标题" value={selected.title} />
          <Button className="ml-auto" onClick={onDelete} size="sm" variant="destructive"><Trash2 />删除</Button>
          <Button onClick={onSave} size="sm">保存</Button>
        </div>
        <div className="mt-4 grid gap-3">
          <Input aria-label="来源 URL" onChange={event => onChange({ ...selected, url: event.target.value })} placeholder="来源 URL（可留空）" value={selected.url} />
        </div>
        <div className="mt-4 min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-surface">
          <MarkdownEditor minHeight={420} onChange={content => onChange({ ...selected, content })} value={selected.content} />
        </div>
      </div> : <AsyncState description="从左侧素材列表选择文章开始编辑。" title="尚未选择素材" variant="empty" />}
    />
  )
}
