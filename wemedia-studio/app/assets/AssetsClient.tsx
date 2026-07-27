'use client'
import { useEffect, useMemo, useState } from 'react'
import { Image as ImageIcon, LockKeyhole, Music, Pencil, Plus, Trash2, Video } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { MarkdownEditor } from '@/app/drafts/MarkdownEditor'
import '@uiw/react-md-editor/markdown-editor.css'
import { cn } from '@/lib/utils'
import { createCreativeAsset, createCreativeAssetDirectory, creativeAssetUrl, deleteCreativeAsset, deleteCreativeAssetDirectory, listCreativeAssetDirectories, renameCreativeAssetDirectory, updateCreativeAsset, type CreativeAsset, type CreativeAssetDirectory } from '@/lib/api/assets'

type TypeTab = 'article' | 'media'
type MediaFilter = 'all' | 'image' | 'video' | 'audio'

export function AssetsClient({ initialAssets }: { initialAssets: CreativeAsset[] }) {
  const [assets, setAssets] = useState(initialAssets)
  const [type, setType] = useState<TypeTab>('article')
  const [directory, setDirectory] = useState('')
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>('all')
  const [selectedId, setSelectedId] = useState<number | null>(initialAssets[0]?.id ?? null)
  const [previewAsset, setPreviewAsset] = useState<CreativeAsset | null>(null)
  const [directories, setDirectories] = useState<CreativeAssetDirectory[]>([])
  const [articleDialog, setArticleDialog] = useState<{ content: string; title: string; url: string; error: string } | null>(null)
  const [directoryDialog, setDirectoryDialog] = useState<{ item: CreativeAssetDirectory | null; name: string; error: string } | null>(null)
  const [confirmDialog, setConfirmDialog] = useState<{ message: string; action: () => Promise<void> } | null>(null)
  const [messageDialog, setMessageDialog] = useState<string | null>(null)
  useEffect(() => { void listCreativeAssetDirectories(type).then(setDirectories) }, [type])
  const visible = useMemo(() => assets.filter(item => item.asset_type === type && (!directory || item.directory === directory) && (type !== 'media' || mediaFilter === 'all' || item.media_kind === mediaFilter)), [assets, type, directory, mediaFilter])
  const selected = visible.find(item => item.id === selectedId) ?? visible[0]
  const count = (value: string) => assets.filter(item => item.asset_type === type && (!value || item.directory === value)).length
  const tree = useMemo(() => { const walk = (parentId: number | null, depth = 0): Array<CreativeAssetDirectory & { depth: number }> => directories.filter(item => item.parent_id === parentId).flatMap(item => [{ ...item, depth }, ...walk(item.id, depth + 1)]); return walk(null) }, [directories])
  function addDirectory() { setDirectoryDialog({ item: null, name: '', error: '' }) }
  function editDirectory(item: CreativeAssetDirectory) { setDirectoryDialog({ item, name: item.name, error: '' }) }
  async function saveDirectory() { if (!directoryDialog) return; const name = directoryDialog.name.trim(); if (!name) { setDirectoryDialog(value => value ? { ...value, error: '请输入目录名称。' } : value); return }; if (directoryDialog.item) { const updated = await renameCreativeAssetDirectory(directoryDialog.item.id, name); setDirectories(items => items.map(value => value.id === updated.id ? updated : value)) } else { const parent = directories.find(item => item.name === directory) ?? null; const created = await createCreativeAssetDirectory(name, type, parent?.id ?? null); setDirectories(items => [...items, created]) }; setDirectoryDialog(null) }
  async function removeDirectory(item: CreativeAssetDirectory) {
    setConfirmDialog({ message: `删除目录“${item.name}”及其子目录？目录内资产会移回未分类。`, action: async () => { await deleteCreativeAssetDirectory(item.id)
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
    if (directory === item.name) setDirectory('') } })
  }
  function openArticleDialog() { setArticleDialog({ title: '', content: '', url: '', error: '' }) }
  async function saveArticle() { if (!articleDialog) return; const title = articleDialog.title.trim(); const content = articleDialog.content.trim(); if (!title || !content) { setArticleDialog(value => value ? { ...value, error: '请填写标题和原始内容。' } : value); return }; const created = await createCreativeAsset({ asset_type: 'article', media_kind: null, title, content, url: articleDialog.url.trim(), media_type: '', filename: '', directory, tags: [] }); setAssets(items => [created, ...items]); setSelectedId(created.id); setArticleDialog(null) }
  async function saveSelectedArticle() { if (!selected) return; const updated = await updateCreativeAsset(selected.id, { title: selected.title, content: selected.content, url: selected.url }); setAssets(items => items.map(value => value.id === updated.id ? updated : value)) }
  async function removeArticle(item: CreativeAsset) { setConfirmDialog({ message: '删除这条原始素材？', action: async () => { await deleteCreativeAsset(item.id); setAssets(items => items.filter(value => value.id !== item.id)); setSelectedId(null) } }) }
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
      <div className="flex h-12 items-center gap-4 border-b border-zinc-200 px-6 dark:border-zinc-800"><span className="text-xs font-medium">{directory || '全部资产'}</span>{type === 'article' && <button onClick={() => openArticleDialog()} className="text-xs text-indigo-600">新增素材</button>}{type === 'media' && <div className="flex gap-3 text-xs text-zinc-500">{(['all','image','video','audio'] as MediaFilter[]).map(item => <button key={item} onClick={() => setMediaFilter(item)} className={cn(mediaFilter === item && 'font-medium text-indigo-600')}>{item === 'all' ? '全部' : item === 'image' ? '图片' : item === 'video' ? '视频' : item === 'audio' ? '音频' : ''}</button>)}</div>}<span className="ml-auto text-xs text-zinc-400">{visible.length} 项</span></div>
      <div className={cn('min-h-0 flex-1', type === 'article' && 'grid grid-cols-[minmax(260px,1fr)_minmax(0,3fr)]')}><section className={cn('overflow-y-auto', type === 'article' ? 'divide-y divide-zinc-100 dark:divide-zinc-800' : 'grid grid-cols-3 content-start gap-3 p-4 md:grid-cols-6 xl:grid-cols-8')}>
        {type === 'article' ? visible.map(item => <button key={item.id} onClick={() => setSelectedId(item.id)} className={cn('block w-full px-6 py-4 text-left hover:bg-zinc-50 dark:hover:bg-zinc-900', selected?.id === item.id && 'bg-indigo-50/70 dark:bg-indigo-950/20')}><div className="flex items-center gap-2"><span className="text-sm font-medium">{item.title || item.content.slice(0, 36)}</span><span className="text-[10px] text-zinc-400">文章</span></div><p className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-500">{item.content}</p></button>) : visible.map(item => <button key={item.id} onClick={() => setSelectedId(item.id)} onDoubleClick={() => setPreviewAsset(item)} title="双击预览" className={cn('overflow-hidden rounded-lg border text-left transition-colors hover:border-indigo-300 hover:bg-indigo-50/30 dark:border-zinc-800 dark:hover:border-indigo-700', selected?.id === item.id && 'border-indigo-500 ring-1 ring-indigo-500')}>
          <div className="relative flex aspect-[4/3] items-center justify-center overflow-hidden bg-zinc-100 dark:bg-zinc-900">{item.media_kind === 'image' ? <img src={creativeAssetUrl(item.url)} alt={item.title} className="h-full w-full object-cover" /> : item.media_kind === 'video' ? <><video src={creativeAssetUrl(item.url)} className="h-full w-full object-cover" muted preload="metadata" /><span className="absolute rounded-full bg-black/55 p-2 text-white"><Video className="h-4 w-4" /></span></> : <div className="flex flex-col items-center gap-2 text-zinc-400"><Music className="h-8 w-8" /><span className="text-[11px]">音频</span></div>}</div>
          <div className="p-3"><p className="truncate text-xs font-medium text-zinc-800 dark:text-zinc-100">{item.title}</p><div className="mt-1 flex items-center gap-1 text-[10px] text-zinc-400">{item.media_kind === 'image' ? <ImageIcon className="h-3 w-3" /> : item.media_kind === 'video' ? <Video className="h-3 w-3" /> : <Music className="h-3 w-3" />}<span>{item.media_kind === 'image' ? '图片' : item.media_kind === 'video' ? '视频' : '音频'}</span></div></div>
        </button>)}
      </section>
      {type === 'article' && <aside className="flex min-h-0 flex-col overflow-hidden border-l border-zinc-200 bg-zinc-50 p-6 dark:border-zinc-800 dark:bg-zinc-950">{selected ? <><div className="flex items-center gap-2"><h3 className="text-lg font-semibold">编辑素材</h3><button onClick={() => void saveSelectedArticle()} className="ml-auto text-xs text-indigo-600">保存</button><button onClick={() => void removeArticle(selected)} className="text-xs text-red-500">删除</button></div><div className="mt-4 space-y-3"><Input value={selected.title} onChange={event => setAssets(items => items.map(item => item.id === selected.id ? { ...item, title: event.target.value } : item))} placeholder="文章标题" /><Input value={selected.url} onChange={event => setAssets(items => items.map(item => item.id === selected.id ? { ...item, url: event.target.value } : item))} placeholder="来源 URL（可留空）" /></div><div className="mt-4 min-h-0 flex-1 overflow-hidden rounded-lg border bg-white"><MarkdownEditor value={selected.content} onChange={content => setAssets(items => items.map(item => item.id === selected.id ? { ...item, content } : item))} minHeight={420} /></div></> : <p className="text-sm text-zinc-400">当前目录没有资产。</p>}</aside>}</div>
    </main>
    <Dialog open={previewAsset !== null} onOpenChange={open => !open && setPreviewAsset(null)}>
      <DialogContent className="max-w-5xl p-4">
        <DialogHeader><DialogTitle>{previewAsset?.title}</DialogTitle><DialogDescription>双击多媒体资产打开预览。</DialogDescription></DialogHeader>
        {previewAsset?.media_kind === 'image' ? <img src={creativeAssetUrl(previewAsset.url)} alt={previewAsset.title} className="max-h-[75vh] w-full object-contain" /> : previewAsset?.media_kind === 'video' ? <video src={creativeAssetUrl(previewAsset.url)} controls autoPlay className="max-h-[75vh] w-full" /> : previewAsset?.media_kind === 'audio' ? <audio src={creativeAssetUrl(previewAsset.url)} controls autoPlay className="w-full" /> : null}
      </DialogContent>
    </Dialog>
    <Dialog open={articleDialog !== null} onOpenChange={open => !open && setArticleDialog(null)}>
      <DialogContent className="max-w-xl"><DialogHeader><DialogTitle>新增文章素材</DialogTitle><DialogDescription>填写标题和原始内容，来源 URL 可留空。</DialogDescription></DialogHeader><div className="space-y-3"><Input autoFocus value={articleDialog?.title ?? ''} onChange={event => setArticleDialog(value => value ? { ...value, title: event.target.value, error: '' } : value)} placeholder="文章标题" /><Textarea value={articleDialog?.content ?? ''} onChange={event => setArticleDialog(value => value ? { ...value, content: event.target.value, error: '' } : value)} placeholder="粘贴原始文章内容" className="min-h-48" /><Input value={articleDialog?.url ?? ''} onChange={event => setArticleDialog(value => value ? { ...value, url: event.target.value } : value)} placeholder="来源 URL（可留空）" />{articleDialog?.error && <p className="text-xs text-red-500">{articleDialog.error}</p>}</div><DialogFooter><Button variant="outline" onClick={() => setArticleDialog(null)}>取消</Button><Button onClick={() => void saveArticle()}>保存</Button></DialogFooter></DialogContent>
    </Dialog>
    <Dialog open={directoryDialog !== null} onOpenChange={open => !open && setDirectoryDialog(null)}><DialogContent><DialogHeader><DialogTitle>{directoryDialog?.item ? '重命名目录' : '新增目录'}</DialogTitle></DialogHeader><Input autoFocus value={directoryDialog?.name ?? ''} onChange={event => setDirectoryDialog(value => value ? { ...value, name: event.target.value, error: '' } : value)} placeholder="目录名称" />{directoryDialog?.error && <p className="text-xs text-red-500">{directoryDialog.error}</p>}<DialogFooter><Button variant="outline" onClick={() => setDirectoryDialog(null)}>取消</Button><Button onClick={() => void saveDirectory()}>保存</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={confirmDialog !== null} onOpenChange={open => !open && setConfirmDialog(null)}><DialogContent><DialogHeader><DialogTitle>确认操作</DialogTitle><DialogDescription>{confirmDialog?.message}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setConfirmDialog(null)}>取消</Button><Button variant="destructive" onClick={() => { const action = confirmDialog?.action; setConfirmDialog(null); if (action) void action() }}>确认</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={messageDialog !== null} onOpenChange={open => !open && setMessageDialog(null)}><DialogContent><DialogHeader><DialogTitle>提示</DialogTitle><DialogDescription>{messageDialog}</DialogDescription></DialogHeader><DialogFooter><Button onClick={() => setMessageDialog(null)}>知道了</Button></DialogFooter></DialogContent></Dialog>
  </div>
}
