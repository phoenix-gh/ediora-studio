'use client'
import { useEffect, useMemo, useState } from 'react'
import { Image as ImageIcon, LockKeyhole, Music, Pencil, Plus, Trash2, Video } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { createCreativeAssetDirectory, creativeAssetUrl, deleteCreativeAssetDirectory, listCreativeAssetDirectories, renameCreativeAssetDirectory, type CreativeAsset, type CreativeAssetDirectory } from '@/lib/api/assets'

type TypeTab = 'article' | 'media'
type MediaFilter = 'all' | 'image' | 'video' | 'audio'

export function AssetsClient({ initialAssets }: { initialAssets: CreativeAsset[] }) {
  const [type, setType] = useState<TypeTab>('article')
  const [directory, setDirectory] = useState('')
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>('all')
  const [selectedId, setSelectedId] = useState<number | null>(initialAssets[0]?.id ?? null)
  const [previewAsset, setPreviewAsset] = useState<CreativeAsset | null>(null)
  const [directories, setDirectories] = useState<CreativeAssetDirectory[]>([])
  useEffect(() => { void listCreativeAssetDirectories(type).then(setDirectories) }, [type])
  const visible = useMemo(() => initialAssets.filter(item => item.asset_type === type && (!directory || item.directory === directory) && (type !== 'media' || mediaFilter === 'all' || item.media_kind === mediaFilter)), [initialAssets, type, directory, mediaFilter])
  const selected = visible.find(item => item.id === selectedId) ?? visible[0]
  const count = (value: string) => initialAssets.filter(item => item.asset_type === type && (!value || item.directory === value)).length
  const tree = useMemo(() => { const walk = (parentId: number | null, depth = 0): Array<CreativeAssetDirectory & { depth: number }> => directories.filter(item => item.parent_id === parentId).flatMap(item => [{ ...item, depth }, ...walk(item.id, depth + 1)]); return walk(null) }, [directories])
  async function addDirectory() { const name = window.prompt('目录名称'); if (!name?.trim()) return; const parent = directories.find(item => item.name === directory) ?? null; const created = await createCreativeAssetDirectory(name.trim(), type, parent?.id ?? null); setDirectories(items => [...items, created]) }
  async function editDirectory(item: CreativeAssetDirectory) { const name = window.prompt('目录名称', item.name); if (!name?.trim()) return; const updated = await renameCreativeAssetDirectory(item.id, name.trim()); setDirectories(items => items.map(value => value.id === item.id ? updated : value)) }
  async function removeDirectory(item: CreativeAssetDirectory) {
    if (!window.confirm(`删除目录“${item.name}”及其子目录？目录内资产会移回未分类。`)) return
    await deleteCreativeAssetDirectory(item.id)
    setDirectories(items => {
      const removed = new Set<number>([item.id])
      let changed = true
      while (changed) {
        changed = false
        for (const value of items) {
          if (value.parent_id !== null && removed.has(value.parent_id) && !removed.has(value.id)) {
            removed.add(value.id)
            changed = true
          }
        }
      }
      return items.filter(value => !removed.has(value.id))
    })
    if (directory === item.name) setDirectory('')
  }
  return <div className="flex h-full overflow-hidden bg-white dark:bg-zinc-950">
    <aside className="flex w-60 shrink-0 flex-col border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <div className="px-4 py-3"><h2 className="text-sm font-semibold">创作资产</h2></div>
      <div className="flex border-y border-zinc-200 dark:border-zinc-800">
        <button onClick={() => { setType('article'); setDirectory('') }} className={cn('flex-1 border-b-2 py-2.5 text-xs', type === 'article' ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-zinc-500')}>文章</button>
        <button onClick={() => { setType('media'); setDirectory('') }} className={cn('flex-1 border-b-2 py-2.5 text-xs', type === 'media' ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-zinc-500')}>多媒体</button>
      </div>
      <div className="flex items-center px-4 pt-4 pb-1 text-[11px] font-medium text-zinc-400">目录<button onClick={() => void addDirectory()} className="ml-auto text-indigo-500"><Plus className="h-3.5 w-3.5" /></button></div>
      <nav className="py-1">
        <button onClick={() => setDirectory('')} className={cn('flex w-full items-center px-4 py-2 text-left text-xs', !directory ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300' : 'text-zinc-600 hover:bg-zinc-50 dark:text-zinc-400 dark:hover:bg-zinc-800')}><span>全部资产</span><span className="ml-auto text-zinc-400">{count('')}</span></button>
        {tree.map(item => (
          <div key={item.id} className="group flex items-center" style={{ paddingLeft: `${item.depth * 14}px` }}>
            <button onClick={() => setDirectory(item.name)} className={cn('flex flex-1 items-center px-4 py-2 text-left text-xs', directory === item.name && 'bg-indigo-50 text-indigo-700')}>
              <span className="inline-flex items-center">
                {item.is_system ? <LockKeyhole aria-label="系统目录" className="mr-1 h-3 w-3" /> : <span aria-hidden="true">📁&nbsp;</span>}
                {item.name}
              </span>
              <span className="ml-auto text-zinc-400">{count(item.name)}</span>
            </button>
            {!item.is_system && (
              <span className="mr-2 hidden gap-1 group-hover:flex">
                <button aria-label={`重命名${item.name}`} onClick={() => void editDirectory(item)}><Pencil className="h-3 w-3" /></button>
                <button aria-label={`删除${item.name}`} className="text-red-500" onClick={() => void removeDirectory(item)}><Trash2 className="h-3 w-3" /></button>
              </span>
            )}
          </div>
        ))}
      </nav>
    </aside>
    <main className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-12 items-center gap-4 border-b border-zinc-200 px-6 dark:border-zinc-800"><span className="text-xs font-medium">{directory || '全部资产'}</span>{type === 'media' && <div className="flex gap-3 text-xs text-zinc-500">{(['all','image','video','audio'] as MediaFilter[]).map(item => <button key={item} onClick={() => setMediaFilter(item)} className={cn(mediaFilter === item && 'font-medium text-indigo-600')}>{item === 'all' ? '全部' : item === 'image' ? '图片' : item === 'video' ? '视频' : '音频'}</button>)}</div>}<span className="ml-auto text-xs text-zinc-400">{visible.length} 项</span></div>
      <div className={cn('min-h-0 flex-1', type === 'article' && 'grid grid-cols-[minmax(0,1fr)_minmax(320px,.8fr)]')}><section className={cn('overflow-y-auto', type === 'article' ? 'divide-y divide-zinc-100 dark:divide-zinc-800' : 'grid grid-cols-3 content-start gap-3 p-4 md:grid-cols-6 xl:grid-cols-8')}>
        {type === 'article' ? visible.map(item => <button key={item.id} onClick={() => setSelectedId(item.id)} className={cn('block w-full px-6 py-4 text-left hover:bg-zinc-50 dark:hover:bg-zinc-900', selected?.id === item.id && 'bg-indigo-50/70 dark:bg-indigo-950/20')}><div className="flex items-center gap-2"><span className="text-sm font-medium">{item.title}</span><span className="text-[10px] text-zinc-400">文章</span></div><p className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-500">{item.content}</p></button>) : visible.map(item => <button key={item.id} onClick={() => setSelectedId(item.id)} onDoubleClick={() => setPreviewAsset(item)} title="双击预览" className={cn('overflow-hidden rounded-lg border text-left transition-colors hover:border-indigo-300 hover:bg-indigo-50/30 dark:border-zinc-800 dark:hover:border-indigo-700', selected?.id === item.id && 'border-indigo-500 ring-1 ring-indigo-500')}>
          <div className="relative flex aspect-[4/3] items-center justify-center overflow-hidden bg-zinc-100 dark:bg-zinc-900">{item.media_kind === 'image' ? <img src={creativeAssetUrl(item.url)} alt={item.title} className="h-full w-full object-cover" /> : item.media_kind === 'video' ? <><video src={creativeAssetUrl(item.url)} className="h-full w-full object-cover" muted preload="metadata" /><span className="absolute rounded-full bg-black/55 p-2 text-white"><Video className="h-4 w-4" /></span></> : <div className="flex flex-col items-center gap-2 text-zinc-400"><Music className="h-8 w-8" /><span className="text-[11px]">音频</span></div>}</div>
          <div className="p-3"><p className="truncate text-xs font-medium text-zinc-800 dark:text-zinc-100">{item.title}</p><div className="mt-1 flex items-center gap-1 text-[10px] text-zinc-400">{item.media_kind === 'image' ? <ImageIcon className="h-3 w-3" /> : item.media_kind === 'video' ? <Video className="h-3 w-3" /> : <Music className="h-3 w-3" />}<span>{item.media_kind === 'image' ? '图片' : item.media_kind === 'video' ? '视频' : '音频'}</span></div></div>
        </button>)}
      </section>
      {type === 'article' && <aside className="overflow-y-auto border-l border-zinc-200 bg-zinc-50 p-6 dark:border-zinc-800 dark:bg-zinc-950">{selected ? <><h3 className="text-lg font-semibold">{selected.title}</h3><p className="mt-5 whitespace-pre-wrap text-sm leading-7 text-zinc-700 dark:text-zinc-200">{selected.content}</p></> : <p className="text-sm text-zinc-400">当前目录没有资产。</p>}</aside>}</div>
    </main>
    <Dialog open={previewAsset !== null} onOpenChange={open => !open && setPreviewAsset(null)}>
      <DialogContent className="max-w-5xl p-4">
        <DialogHeader><DialogTitle>{previewAsset?.title}</DialogTitle><DialogDescription>双击多媒体资产打开预览。</DialogDescription></DialogHeader>
        {previewAsset?.media_kind === 'image' ? <img src={creativeAssetUrl(previewAsset.url)} alt={previewAsset.title} className="max-h-[75vh] w-full object-contain" /> : previewAsset?.media_kind === 'video' ? <video src={creativeAssetUrl(previewAsset.url)} controls autoPlay className="max-h-[75vh] w-full" /> : previewAsset?.media_kind === 'audio' ? <audio src={creativeAssetUrl(previewAsset.url)} controls autoPlay className="w-full" /> : null}
      </DialogContent>
    </Dialog>
  </div>
}
