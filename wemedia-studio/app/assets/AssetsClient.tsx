'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
type ArticleDialogState = { busy: boolean; content: string; error: string; id: number; title: string; url: string }
type DirectoryDialogState = { busy: boolean; error: string; id: number; item: CreativeAssetDirectory | null; name: string }
type ConfirmationState = { action: () => Promise<void>; busy: boolean; error: string; message: string }
type OperationError = { assetId: number; message: string }

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
  const [directoryLoadError, setDirectoryLoadError] = useState('')
  const [operationError, setOperationError] = useState<OperationError | null>(null)
  const [savingAssetId, setSavingAssetId] = useState<number | null>(null)
  const formId = useRef(0)

  useEffect(() => {
    let current = true
    void listCreativeAssetDirectories(type)
      .then(items => { if (current) setDirectories(items) })
      .catch(() => { if (current) setDirectoryLoadError('加载目录失败，请重试。') })
    return () => { current = false }
  }, [type])

  const visibleAssets = useMemo(() => assets.filter(asset => asset.asset_type === type
    && (!directory || asset.directory === directory)
    && (type !== 'media' || mediaFilter === 'all' || asset.media_kind === mediaFilter)), [assets, directory, mediaFilter, type])
  const selected = visibleAssets.find(asset => asset.id === selectedId) ?? visibleAssets[0]
  const count = (name: string) => assets.filter(asset => asset.asset_type === type && (!name || asset.directory === name)).length

  function changeType(nextType: AssetType) {
    setType(nextType)
    setDirectory('')
    setDirectories([])
    setDirectoryLoadError('')
    setSelectedId(null)
    setOperationError(null)
  }

  function openNewDirectory() {
    if (directoryDialog?.busy) return
    setDirectoryDialog({ busy: false, error: '', id: ++formId.current, item: null, name: '' })
  }

  async function saveDirectory() {
    if (!directoryDialog || directoryDialog.busy) return
    const form = directoryDialog
    const name = form.name.trim()
    if (!name) {
      setDirectoryDialog(value => value ? { ...value, error: '请输入目录名称。' } : value)
      return
    }
    setDirectoryDialog(value => value?.id === form.id ? { ...value, busy: true, error: '' } : value)
    try {
      if (form.item) {
        const previous = form.item
        const updated = await renameCreativeAssetDirectory(previous.id, name)
        setDirectories(items => items.map(item => item.id === updated.id ? updated : item))
        setAssets(items => items.map(item => item.asset_type === previous.asset_type && item.directory === previous.name ? { ...item, directory: updated.name } : item))
        if (directory === previous.name) setDirectory(updated.name)
      } else {
        const parent = directories.find(item => item.name === directory)
        const created = await createCreativeAssetDirectory(name, type, parent?.id ?? null)
        setDirectories(items => [...items, created])
      }
      setDirectoryDialog(value => value?.id === form.id ? null : value)
    } catch {
      setDirectoryDialog(value => value?.id === form.id ? { ...value, busy: false, error: '保存目录失败，请重试。' } : value)
    }
  }

  function requestDirectoryDelete(item: CreativeAssetDirectory) {
    const removedDirectories = getDirectorySubtree(directories, item.id)
    const removedNames = new Set(removedDirectories.map(directory => directory.name))
    setConfirmation({
      busy: false,
      error: '',
      message: `删除目录“${item.name}”及其子目录？目录内资产会移回未分类。`,
      action: async () => {
        await deleteCreativeAssetDirectory(item.id)
        setDirectories(items => items.filter(directory => !removedNames.has(directory.name)))
        setAssets(items => items.map(asset => asset.asset_type === item.asset_type && removedNames.has(asset.directory) ? { ...asset, directory: '' } : asset))
        if (removedNames.has(directory)) setDirectory('')
      },
    })
  }

  function openNewArticle() {
    if (articleDialog?.busy) return
    setArticleDialog({ busy: false, content: '', error: '', id: ++formId.current, title: '', url: '' })
  }

  async function saveNewArticle() {
    if (!articleDialog || articleDialog.busy) return
    const form = articleDialog
    const title = form.title.trim()
    const content = form.content.trim()
    if (!title || !content) {
      setArticleDialog(value => value ? { ...value, error: '请填写标题和原始内容。' } : value)
      return
    }
    setArticleDialog(value => value?.id === form.id ? { ...value, busy: true, error: '' } : value)
    try {
      const created = await createCreativeAsset({
        asset_type: 'article',
        content,
        directory,
        filename: '',
        media_kind: null,
        media_type: '',
        tags: [],
        title,
        url: form.url.trim(),
      })
      setAssets(items => [created, ...items])
      setSelectedId(created.id)
      setArticleDialog(value => value?.id === form.id ? null : value)
    } catch {
      setArticleDialog(value => value?.id === form.id ? { ...value, busy: false, error: '保存文章素材失败，请重试。' } : value)
    }
  }

  function changeSelectedArticle(asset: CreativeAsset) {
    setAssets(items => items.map(item => item.id === asset.id ? asset : item))
    setOperationError(null)
  }

  async function saveSelectedArticle() {
    if (!selected || savingAssetId !== null) return
    const assetId = selected.id
    const snapshot = { content: selected.content, title: selected.title, url: selected.url }
    setOperationError(null)
    setSavingAssetId(assetId)
    try {
      const updated = await updateCreativeAsset(assetId, snapshot)
      setAssets(items => items.map(item => item.id !== assetId ? item : {
        ...updated,
        content: item.content === snapshot.content ? updated.content : item.content,
        title: item.title === snapshot.title ? updated.title : item.title,
        url: item.url === snapshot.url ? updated.url : item.url,
      }))
    } catch {
      setOperationError({ assetId, message: '更新文章素材失败，请重试。' })
    } finally {
      setSavingAssetId(value => value === assetId ? null : value)
    }
  }

  function selectArticle(id: number) {
    setSelectedId(id)
    setOperationError(null)
  }

  function requestArticleDelete() {
    if (!selected) return
    setConfirmation({
      busy: false,
      error: '',
      message: '删除这条原始素材？',
      action: async () => {
        await deleteCreativeAsset(selected.id)
        setAssets(items => items.filter(item => item.id !== selected.id))
        setSelectedId(null)
      },
    })
  }

  async function confirmDeletion() {
    if (!confirmation || confirmation.busy) return
    setConfirmation(value => value ? { ...value, busy: true, error: '' } : value)
    try {
      await confirmation.action()
      setConfirmation(null)
    } catch {
      setConfirmation(value => value ? { ...value, busy: false, error: '删除失败，请重试。' } : value)
    }
  }

  return <div className="flex h-full min-h-0 overflow-hidden bg-surface">
    <AssetDirectoryRail
      activeDirectory={directory}
      count={count}
      directories={directories}
      onAddDirectory={openNewDirectory}
      onDeleteDirectory={requestDirectoryDelete}
      onDirectoryChange={setDirectory}
      onRenameDirectory={item => setDirectoryDialog({ busy: false, error: '', id: ++formId.current, item, name: item.name })}
      onTypeChange={changeType}
      type={type}
    />
    <div className="flex min-w-0 flex-1 flex-col">
      <WorkspaceToolbar
        actions={type === 'article' ? <Button onClick={openNewArticle} size="sm">新增素材</Button> : undefined}
        count={`${visibleAssets.length} 项`}
        title={directory || '全部资产'}
      >
        {type === 'media' ? <div aria-label="媒体筛选" className="flex gap-1" role="group">
          {(['all', 'image', 'video', 'audio'] as MediaFilter[]).map(filter => <Button aria-pressed={mediaFilter === filter} key={filter} onClick={() => setMediaFilter(filter)} size="xs" variant={mediaFilter === filter ? 'secondary' : 'ghost'}>{mediaFilterLabel(filter)}</Button>)}
        </div> : null}
      </WorkspaceToolbar>
      {directoryLoadError ? <p className="px-7 pt-3 text-sm text-destructive" role="alert">{directoryLoadError}</p> : null}
      {operationError && operationError.assetId === selected?.id ? <p className="px-7 pt-3 text-sm text-destructive" role="alert">{operationError.message}</p> : null}
      {type === 'article'
        ? <ArticleAssetWorkspace assets={visibleAssets} isSaving={savingAssetId !== null} onChange={changeSelectedArticle} onDelete={requestArticleDelete} onSave={saveSelectedArticle} onSelect={selectArticle} selected={selected} />
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

    <Dialog open={articleDialog !== null} onOpenChange={open => { if (!open && !articleDialog?.busy) setArticleDialog(null) }}>
      <DialogContent showCloseButton={!articleDialog?.busy} size="md">
        <DialogHeader><DialogTitle>新增文章素材</DialogTitle><DialogDescription>填写标题和原始内容，来源 URL 可留空。</DialogDescription></DialogHeader>
        <div className="space-y-3">
          <div className="grid gap-1.5"><Label htmlFor="asset-title">文章标题</Label><Input aria-describedby={articleDialog?.error ? 'article-form-error' : undefined} aria-invalid={Boolean(articleDialog?.error) || undefined} autoFocus disabled={articleDialog?.busy} id="asset-title" onChange={event => setArticleDialog(value => value ? { ...value, error: '', title: event.target.value } : value)} placeholder="文章标题" value={articleDialog?.title ?? ''} /></div>
          <div className="grid gap-1.5"><Label htmlFor="asset-content">原始内容</Label><Textarea aria-describedby={articleDialog?.error ? 'article-form-error' : undefined} aria-invalid={Boolean(articleDialog?.error) || undefined} disabled={articleDialog?.busy} id="asset-content" onChange={event => setArticleDialog(value => value ? { ...value, content: event.target.value, error: '' } : value)} placeholder="粘贴原始文章内容" value={articleDialog?.content ?? ''} /></div>
          <div className="grid gap-1.5"><Label htmlFor="asset-url">来源 URL（可留空）</Label><Input aria-describedby={articleDialog?.error ? 'article-form-error' : undefined} aria-invalid={Boolean(articleDialog?.error) || undefined} disabled={articleDialog?.busy} id="asset-url" onChange={event => setArticleDialog(value => value ? { ...value, error: '', url: event.target.value } : value)} placeholder="来源 URL（可留空）" value={articleDialog?.url ?? ''} /></div>
          {articleDialog?.error ? <p className="text-xs text-destructive" id="article-form-error" role="alert">{articleDialog.error}</p> : null}
        </div>
        <DialogFooter><Button disabled={articleDialog?.busy} onClick={() => setArticleDialog(null)} variant="outline">取消</Button><Button disabled={articleDialog?.busy} onClick={() => void saveNewArticle()}>{articleDialog?.busy ? '保存中…' : '保存'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={directoryDialog !== null} onOpenChange={open => { if (!open && !directoryDialog?.busy) setDirectoryDialog(null) }}>
      <DialogContent showCloseButton={!directoryDialog?.busy} size="sm">
        <DialogHeader><DialogTitle>{directoryDialog?.item ? '重命名目录' : '新增目录'}</DialogTitle></DialogHeader>
        <div className="grid gap-1.5"><Label htmlFor="asset-directory-name">目录名称</Label><Input aria-describedby={directoryDialog?.error ? 'directory-form-error' : undefined} aria-invalid={Boolean(directoryDialog?.error) || undefined} autoFocus disabled={directoryDialog?.busy} id="asset-directory-name" onChange={event => setDirectoryDialog(value => value ? { ...value, error: '', name: event.target.value } : value)} placeholder="目录名称" value={directoryDialog?.name ?? ''} /></div>
        {directoryDialog?.error ? <p className="text-xs text-destructive" id="directory-form-error" role="alert">{directoryDialog.error}</p> : null}
        <DialogFooter><Button disabled={directoryDialog?.busy} onClick={() => setDirectoryDialog(null)} variant="outline">取消</Button><Button disabled={directoryDialog?.busy} onClick={() => void saveDirectory()}>{directoryDialog?.busy ? '保存中…' : '保存'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>

    <AlertDialog open={confirmation !== null} onOpenChange={open => { if (!open && !confirmation?.busy) setConfirmation(null) }}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>确认操作</AlertDialogTitle><AlertDialogDescription>{confirmation?.message}</AlertDialogDescription>{confirmation?.error ? <p className="text-sm text-destructive" role="alert">{confirmation.error}</p> : null}</AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel disabled={confirmation?.busy}>取消</AlertDialogCancel><AlertDialogAction disabled={confirmation?.busy} onClick={event => { event.preventDefault(); void confirmDeletion() }} variant="destructive">确认</AlertDialogAction></AlertDialogFooter>
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

function getDirectorySubtree(directories: CreativeAssetDirectory[], id: number) {
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
  return directories.filter(directory => removed.has(directory.id))
}
