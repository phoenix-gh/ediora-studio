'use client'

import { useEffect, useMemo, useState } from 'react'

import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { WorkspaceToolbar } from '@/components/layout/WorkspaceToolbar'
import { AssetDirectoryRail } from './AssetDirectoryRail'
import { ArticleAssetWorkspace } from './ArticleAssetWorkspace'
import { MediaAssetGrid } from './MediaAssetGrid'
import {
  createCreativeAsset,
  createCreativeAssetDirectory,
  creativeAssetUrl,
  deleteCreativeAsset,
  deleteCreativeAssetDirectory,
  listCreativeAssetDirectories,
  renameCreativeAssetDirectory,
  updateCreativeAsset,
  type CreativeAsset,
  type CreativeAssetDirectory,
} from '@/lib/api/assets'

type AssetType = 'article' | 'media'
type MediaFilter = 'all' | 'image' | 'video' | 'audio'
type ArticleDialogState = { content: string; error: string; title: string; url: string }
type DirectoryDialogState = { error: string; item: CreativeAssetDirectory | null; name: string }
type ConfirmationState = { action: () => Promise<void>; message: string }

export function AssetsClient({ initialAssets }: { initialAssets: CreativeAsset[] }) {
  const [assets, setAssets] = useState(initialAssets)
  const [type, setType] = useState<AssetType>('article')
  const [directory, setDirectory] = useState('')
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>('all')
  const [selectedId, setSelectedId] = useState<number | null>(initialAssets[0]?.id ?? null)
  const [previewAsset, setPreviewAsset] = useState<CreativeAsset | null>(null)
  const [directories, setDirectories] = useState<CreativeAssetDirectory[]>([])
  const [articleDialog, setArticleDialog] = useState<ArticleDialogState | null>(null)
  const [directoryDialog, setDirectoryDialog] = useState<DirectoryDialogState | null>(null)
  const [confirmation, setConfirmation] = useState<ConfirmationState | null>(null)

  useEffect(() => {
    void listCreativeAssetDirectories(type).then(setDirectories)
  }, [type])

  const visibleAssets = useMemo(() => assets.filter(asset => asset.asset_type === type
    && (!directory || asset.directory === directory)
    && (type !== 'media' || mediaFilter === 'all' || asset.media_kind === mediaFilter)), [assets, directory, mediaFilter, type])
  const selected = visibleAssets.find(asset => asset.id === selectedId) ?? visibleAssets[0]
  const count = (name: string) => assets.filter(asset => asset.asset_type === type && (!name || asset.directory === name)).length

  function changeType(nextType: AssetType) {
    setType(nextType)
    setDirectory('')
    setSelectedId(null)
  }

  function openNewDirectory() {
    setDirectoryDialog({ error: '', item: null, name: '' })
  }

  async function saveDirectory() {
    if (!directoryDialog) return
    const name = directoryDialog.name.trim()
    if (!name) {
      setDirectoryDialog(value => value ? { ...value, error: '请输入目录名称。' } : value)
      return
    }
    if (directoryDialog.item) {
      const updated = await renameCreativeAssetDirectory(directoryDialog.item.id, name)
      setDirectories(items => items.map(item => item.id === updated.id ? updated : item))
    } else {
      const parent = directories.find(item => item.name === directory)
      const created = await createCreativeAssetDirectory(name, type, parent?.id ?? null)
      setDirectories(items => [...items, created])
    }
    setDirectoryDialog(null)
  }

  function requestDirectoryDelete(item: CreativeAssetDirectory) {
    setConfirmation({
      message: `删除目录“${item.name}”及其子目录？目录内资产会移回未分类。`,
      action: async () => {
        await deleteCreativeAssetDirectory(item.id)
        setDirectories(items => removeDirectoryTree(items, item.id))
        if (directory === item.name) setDirectory('')
      },
    })
  }

  function openNewArticle() {
    setArticleDialog({ content: '', error: '', title: '', url: '' })
  }

  async function saveNewArticle() {
    if (!articleDialog) return
    const title = articleDialog.title.trim()
    const content = articleDialog.content.trim()
    if (!title || !content) {
      setArticleDialog(value => value ? { ...value, error: '请填写标题和原始内容。' } : value)
      return
    }
    const created = await createCreativeAsset({
      asset_type: 'article',
      content,
      directory,
      filename: '',
      media_kind: null,
      media_type: '',
      tags: [],
      title,
      url: articleDialog.url.trim(),
    })
    setAssets(items => [created, ...items])
    setSelectedId(created.id)
    setArticleDialog(null)
  }

  function changeSelectedArticle(asset: CreativeAsset) {
    setAssets(items => items.map(item => item.id === asset.id ? asset : item))
  }

  async function saveSelectedArticle() {
    if (!selected) return
    const updated = await updateCreativeAsset(selected.id, { content: selected.content, title: selected.title, url: selected.url })
    setAssets(items => items.map(item => item.id === updated.id ? updated : item))
  }

  function requestArticleDelete() {
    if (!selected) return
    setConfirmation({
      message: '删除这条原始素材？',
      action: async () => {
        await deleteCreativeAsset(selected.id)
        setAssets(items => items.filter(item => item.id !== selected.id))
        setSelectedId(null)
      },
    })
  }

  return <div className="flex h-full min-h-0 overflow-hidden bg-surface">
    <AssetDirectoryRail
      activeDirectory={directory}
      count={count}
      directories={directories}
      onAddDirectory={openNewDirectory}
      onDeleteDirectory={requestDirectoryDelete}
      onDirectoryChange={setDirectory}
      onRenameDirectory={item => setDirectoryDialog({ error: '', item, name: item.name })}
      onTypeChange={changeType}
      type={type}
    />
    <div className="flex min-w-0 flex-1 flex-col">
      <WorkspaceToolbar
        actions={type === 'article' ? <Button onClick={openNewArticle} size="sm">新增素材</Button> : undefined}
        count={`${visibleAssets.length} 项`}
        title={directory || '全部资产'}
      >
        {type === 'media' ? <div aria-label="媒体筛选" className="flex gap-1">
          {(['all', 'image', 'video', 'audio'] as MediaFilter[]).map(filter => <Button key={filter} onClick={() => setMediaFilter(filter)} size="xs" variant={mediaFilter === filter ? 'secondary' : 'ghost'}>{mediaFilterLabel(filter)}</Button>)}
        </div> : null}
      </WorkspaceToolbar>
      {type === 'article'
        ? <ArticleAssetWorkspace assets={visibleAssets} onChange={changeSelectedArticle} onDelete={requestArticleDelete} onSave={saveSelectedArticle} onSelect={setSelectedId} selected={selected} />
        : <MediaAssetGrid assets={visibleAssets} onPreview={setPreviewAsset} onSelect={setSelectedId} selectedId={selected?.id ?? null} />}
    </div>

    <Dialog open={previewAsset !== null} onOpenChange={open => { if (!open) setPreviewAsset(null) }}>
      <DialogContent size="lg">
        <DialogHeader><DialogTitle>{previewAsset?.title}</DialogTitle><DialogDescription>双击多媒体资产打开预览。</DialogDescription></DialogHeader>
        {previewAsset?.media_kind === 'image' ? <img alt={previewAsset.title} className="max-h-[75vh] w-full object-contain" src={creativeAssetUrl(previewAsset.url)} /> : null}
        {previewAsset?.media_kind === 'video' ? <video autoPlay className="max-h-[75vh] w-full" controls src={creativeAssetUrl(previewAsset.url)} /> : null}
        {previewAsset?.media_kind === 'audio' ? <audio autoPlay className="w-full" controls src={creativeAssetUrl(previewAsset.url)} /> : null}
      </DialogContent>
    </Dialog>

    <Dialog open={articleDialog !== null} onOpenChange={open => { if (!open) setArticleDialog(null) }}>
      <DialogContent size="md">
        <DialogHeader><DialogTitle>新增文章素材</DialogTitle><DialogDescription>填写标题和原始内容，来源 URL 可留空。</DialogDescription></DialogHeader>
        <div className="space-y-3">
          <Input autoFocus onChange={event => setArticleDialog(value => value ? { ...value, error: '', title: event.target.value } : value)} placeholder="文章标题" value={articleDialog?.title ?? ''} />
          <Textarea onChange={event => setArticleDialog(value => value ? { ...value, content: event.target.value, error: '' } : value)} placeholder="粘贴原始文章内容" value={articleDialog?.content ?? ''} />
          <Input onChange={event => setArticleDialog(value => value ? { ...value, url: event.target.value } : value)} placeholder="来源 URL（可留空）" value={articleDialog?.url ?? ''} />
          {articleDialog?.error ? <p className="text-xs text-destructive">{articleDialog.error}</p> : null}
        </div>
        <DialogFooter><Button onClick={() => setArticleDialog(null)} variant="outline">取消</Button><Button onClick={() => void saveNewArticle()}>保存</Button></DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={directoryDialog !== null} onOpenChange={open => { if (!open) setDirectoryDialog(null) }}>
      <DialogContent size="sm">
        <DialogHeader><DialogTitle>{directoryDialog?.item ? '重命名目录' : '新增目录'}</DialogTitle></DialogHeader>
        <Input autoFocus onChange={event => setDirectoryDialog(value => value ? { ...value, error: '', name: event.target.value } : value)} placeholder="目录名称" value={directoryDialog?.name ?? ''} />
        {directoryDialog?.error ? <p className="text-xs text-destructive">{directoryDialog.error}</p> : null}
        <DialogFooter><Button onClick={() => setDirectoryDialog(null)} variant="outline">取消</Button><Button onClick={() => void saveDirectory()}>保存</Button></DialogFooter>
      </DialogContent>
    </Dialog>

    <AlertDialog open={confirmation !== null} onOpenChange={open => { if (!open) setConfirmation(null) }}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>确认操作</AlertDialogTitle><AlertDialogDescription>{confirmation?.message}</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction onClick={() => { const action = confirmation?.action; setConfirmation(null); if (action) void action() }} variant="destructive">确认</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
}

function mediaFilterLabel(filter: MediaFilter) {
  if (filter === 'all') return '全部'
  if (filter === 'image') return '图片'
  if (filter === 'video') return '视频'
  return '音频'
}

function removeDirectoryTree(directories: CreativeAssetDirectory[], id: number) {
  const removed = new Set([id])
  let changed = true
  while (changed) {
    changed = false
    for (const directory of directories) {
      if (directory.parent_id !== null && removed.has(directory.parent_id) && !removed.has(directory.id)) {
        removed.add(directory.id)
        changed = true
      }
    }
  }
  return directories.filter(directory => !removed.has(directory.id))
}
