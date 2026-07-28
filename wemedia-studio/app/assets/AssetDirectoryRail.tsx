import type { ReactNode } from 'react'
import { Folder, LockKeyhole, Pencil, Plus, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import type { CreativeAssetDirectory } from '@/lib/api/assets'

type AssetDirectoryRailProps = {
  type: 'article' | 'media'
  activeDirectory: string
  directories: CreativeAssetDirectory[]
  count: (name: string) => number
  onTypeChange: (type: 'article' | 'media') => void
  onDirectoryChange: (name: string) => void
  onAddDirectory: () => void
  onRenameDirectory: (directory: CreativeAssetDirectory) => void
  onDeleteDirectory: (directory: CreativeAssetDirectory) => void
}

export function AssetDirectoryRail({
  type,
  activeDirectory,
  directories,
  count,
  onTypeChange,
  onDirectoryChange,
  onAddDirectory,
  onRenameDirectory,
  onDeleteDirectory,
}: AssetDirectoryRailProps) {
  const tree = buildTree(directories)

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-surface-muted">
      <div className="px-4 py-4"><h2 className="text-sm font-semibold">创作资产</h2></div>
      <Tabs value={type} onValueChange={value => onTypeChange(value as 'article' | 'media')} className="px-3 pb-3">
        <TabsList className="w-full" variant="line">
          <TabsTrigger className="flex-1" value="article">文章</TabsTrigger>
          <TabsTrigger className="flex-1" value="media">多媒体</TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="flex items-center px-4 py-2 text-xs font-medium text-muted-foreground">
        目录
        <Button aria-label="新增目录" className="ml-auto" onClick={onAddDirectory} size="icon-xs" variant="ghost"><Plus /></Button>
      </div>
      <nav aria-label="资产目录" className="min-h-0 overflow-y-auto px-2 pb-3">
        <DirectoryButton active={!activeDirectory} count={count('')} name="全部资产" onClick={() => onDirectoryChange('')} />
        {tree.map(({ directory, depth }) => (
          <div key={directory.id} className="group flex items-center" style={{ paddingLeft: `${depth * 12}px` }}>
            <DirectoryButton
              active={activeDirectory === directory.name}
              count={count(directory.name)}
              icon={directory.is_system ? <LockKeyhole aria-label="系统目录" className="size-3.5" /> : <Folder className="size-3.5" />}
              name={directory.name}
              onClick={() => onDirectoryChange(directory.name)}
            />
            {!directory.is_system ? (
              <span className="mr-1 hidden shrink-0 items-center gap-0.5 group-hover:flex">
                <Button aria-label={`重命名${directory.name}`} onClick={() => onRenameDirectory(directory)} size="icon-xs" variant="ghost"><Pencil /></Button>
                <Button aria-label={`删除${directory.name}`} onClick={() => onDeleteDirectory(directory)} size="icon-xs" variant="ghost"><Trash2 className="text-destructive" /></Button>
              </span>
            ) : null}
          </div>
        ))}
      </nav>
    </aside>
  )
}

function DirectoryButton({ active, count, icon, name, onClick }: { active: boolean; count: number; icon?: ReactNode; name: string; onClick: () => void }) {
  return (
    <button className={cn('flex min-w-0 flex-1 items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground', active && 'bg-primary/10 text-primary')} onClick={onClick} type="button">
      {icon}
      <span className="truncate">{name}</span>
      <span className="ml-auto text-muted-foreground">{count}</span>
    </button>
  )
}

function buildTree(directories: CreativeAssetDirectory[]) {
  const walk = (parentId: number | null, depth = 0): Array<{ directory: CreativeAssetDirectory; depth: number }> => directories
    .filter(directory => directory.parent_id === parentId)
    .flatMap(directory => [{ directory, depth }, ...walk(directory.id, depth + 1)])

  return walk(null)
}
