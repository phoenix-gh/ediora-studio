'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Upload } from 'lucide-react'

import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { WorkspaceToolbar } from '@/components/layout/WorkspaceToolbar'
import { AssetDirectoryRail } from './AssetDirectoryRail'
import { ArticleAssetWorkspace } from './ArticleAssetWorkspace'
import { MediaAssetGrid } from './MediaAssetGrid'
import { MediaUploadDialog } from './MediaUploadDialog'
import { PromptAssetWorkspace } from './PromptAssetWorkspace'
import {
  createCreativeAsset,
  createCreativeAssetDirectory,
  creativeAssetUrl,
  deleteCreativeAsset,
  deleteCreativeAssetDirectory,
  listCreativeAssetDirectories,
  renameCreativeAssetDirectory,
  updateCreativeAssetDirectoryIngestionRule,
  updateCreativeAsset,
  type CreativeAsset,
  type CreativeAssetDirectory,
  type CreativeAssetType,
  type PromptKind,
} from '@/lib/api/assets'

type AssetType = CreativeAssetType
type MediaFilter = 'all' | 'image' | 'video' | 'audio'
type ArticleDialogState = { busy: boolean; content: string; error: string; id: number; title: string; url: string }
type PromptDialogState = { busy: boolean; content: string; error: string; id: number; kind: PromptKind; title: string }
type MediaRenameDialogState = { asset: CreativeAsset; busy: boolean; error: string; name: string }
type DirectoryDialogState = {
  aiIngestionEnabled: boolean
  aiIngestionKeywords: string
  aiIngestionPrompt: string
  busy: boolean
  error: string
  id: number
  item: CreativeAssetDirectory | null
  name: string
}
type ConfirmationState = { action: () => Promise<void>; busy: boolean; error: string; message: string }

export function AssetsClient({
  initialAssets,
  initialSelectedId = null,
}: {
  initialAssets: CreativeAsset[]
  initialSelectedId?: number | null
}) {
  const [assets, setAssets] = useState(initialAssets)
  const [type, setType] = useState<AssetType>('article')
  const [directory, setDirectory] = useState('')
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>('all')
  const [selectedId, setSelectedId] = useState<number | null>(
    initialSelectedId && initialAssets.some(asset => asset.id === initialSelectedId)
      ? initialSelectedId
      : initialAssets[0]?.id ?? null,
  )
  const [previewAsset, setPreviewAsset] = useState<CreativeAsset | null>(null)
  const [mediaUploadDirectory, setMediaUploadDirectory] = useState<string | null>(null)
  const [mediaRenameDialog, setMediaRenameDialog] = useState<MediaRenameDialogState | null>(null)
  const [directories, setDirectories] = useState<CreativeAssetDirectory[]>([])
  const [articleDialog, setArticleDialog] = useState<ArticleDialogState | null>(null)
  const [promptDialog, setPromptDialog] = useState<PromptDialogState | null>(null)
  const [directoryDialog, setDirectoryDialog] = useState<DirectoryDialogState | null>(null)
  const [confirmation, setConfirmation] = useState<ConfirmationState | null>(null)
  const [directoryLoadError, setDirectoryLoadError] = useState('')
  const [directoryLoadAttempt, setDirectoryLoadAttempt] = useState(0)
  const [operationErrors, setOperationErrors] = useState<Record<number, string>>({})
  const [savingAssetId, setSavingAssetId] = useState<number | null>(null)
  const formId = useRef(0)

  useEffect(() => {
    let current = true
    void listCreativeAssetDirectories(type)
      .then(items => {
        if (current) {
          setDirectories(items)
          setDirectoryLoadError('')
        }
      })
      .catch(() => { if (current) setDirectoryLoadError('加载目录失败，请重试。') })
    return () => { current = false }
  }, [directoryLoadAttempt, type])

  const visibleAssets = useMemo(() => assets.filter(asset => asset.asset_type === type
    && (!directory || asset.directory === directory)
    && (type !== 'media' || mediaFilter === 'all' || asset.media_kind === mediaFilter)), [assets, directory, mediaFilter, type])
  const selected = visibleAssets.find(asset => asset.id === selectedId) ?? visibleAssets[0]
  const count = (name: string) => assets.filter(asset => asset.asset_type === type && (!name || asset.directory === name)).length

  const clearOperationError = useCallback((assetId: number) => {
    setOperationErrors(errors => {
      if (!errors[assetId]) return errors
      const next = { ...errors }
      delete next[assetId]
      return next
    })
  }, [])

  function changeType(nextType: AssetType) {
    setType(nextType)
    setDirectory('')
    setMediaFilter('all')
    setDirectories([])
    setDirectoryLoadError('')
    setSelectedId(null)
    setOperationErrors({})
    setArticleDialog(null)
    setPromptDialog(null)
    setMediaRenameDialog(null)
    setDirectoryDialog(null)
  }

  function openNewDirectory() {
    if (directoryDialog?.busy) return
    setDirectoryDialog({
      aiIngestionEnabled: false,
      aiIngestionKeywords: '',
      aiIngestionPrompt: '',
      busy: false,
      error: '',
      id: ++formId.current,
      item: null,
      name: '',
    })
  }

  function openDirectoryEditor(item: CreativeAssetDirectory) {
    if (directoryDialog?.busy) return
    setDirectoryDialog({
      aiIngestionEnabled: item.ai_ingestion_enabled,
      aiIngestionKeywords: item.ai_ingestion_keywords.join('，'),
      aiIngestionPrompt: item.ai_ingestion_prompt,
      busy: false,
      error: '',
      id: ++formId.current,
      item,
      name: item.name,
    })
  }

  async function saveDirectory() {
    if (!directoryDialog || directoryDialog.busy) return
    const form = directoryDialog
    const name = form.name.trim()
    if (!name) {
      setDirectoryDialog(value => value ? { ...value, error: '请输入目录名称。' } : value)
      return
    }
    const aiIngestionPrompt = form.aiIngestionPrompt.trim()
    if ((type === 'article' || type === 'prompt') && form.aiIngestionEnabled && !aiIngestionPrompt) {
      setDirectoryDialog(value => value ? { ...value, error: '启用 AI 素材入库时必须填写规则。' } : value)
      return
    }
    setDirectoryDialog(value => value?.id === form.id ? { ...value, busy: true, error: '' } : value)
    try {
      let savedDirectory: CreativeAssetDirectory
      if (form.item) {
        const previous = form.item
        savedDirectory = await renameCreativeAssetDirectory(previous.id, name, previous.asset_type)
        setAssets(items => items.map(item => item.asset_type === previous.asset_type && item.directory === previous.name ? { ...item, directory: savedDirectory.name } : item))
        if (directory === previous.name) setDirectory(savedDirectory.name)
      } else {
        const parent = directories.find(item => item.name === directory)
        savedDirectory = await createCreativeAssetDirectory(name, type, parent?.id ?? null)
      }
      if (type === 'article' || type === 'prompt') {
        const rule = await updateCreativeAssetDirectoryIngestionRule(savedDirectory.id, {
          enabled: form.aiIngestionEnabled,
          keywords: form.aiIngestionKeywords.split(/[,，]/).map(value => value.trim()).filter(Boolean),
          prompt: aiIngestionPrompt,
        })
        savedDirectory = {
          ...savedDirectory,
          ai_ingestion_enabled: rule.enabled,
          ai_ingestion_keywords: rule.keywords,
          ai_ingestion_prompt: rule.prompt,
        }
      }
      setDirectories(items => form.item
        ? items.map(item => item.id === savedDirectory.id ? savedDirectory : item)
        : [...items, savedDirectory])
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

  function openNewPrompt() {
    if (promptDialog?.busy) return
    setPromptDialog({ busy: false, content: '', error: '', id: ++formId.current, kind: 'image', title: '' })
  }

  async function saveNewPrompt() {
    if (!promptDialog || promptDialog.busy) return
    const form = promptDialog
    const title = form.title.trim()
    const content = form.content.trim()
    if (!title || !content) {
      setPromptDialog(value => value ? { ...value, error: '请填写提示词标题和正文。' } : value)
      return
    }
    setPromptDialog(value => value?.id === form.id ? { ...value, busy: true, error: '' } : value)
    try {
      const created = await createCreativeAsset({
        asset_type: 'prompt',
        content,
        directory,
        filename: '',
        media_kind: null,
        media_type: '',
        prompt_kind: form.kind,
        tags: [],
        title,
        url: '',
      })
      setAssets(items => [created, ...items])
      setSelectedId(created.id)
      setPromptDialog(value => value?.id === form.id ? null : value)
    } catch {
      setPromptDialog(value => value?.id === form.id ? { ...value, busy: false, error: '保存提示词资产失败，请重试。' } : value)
    }
  }

  function changeSelectedArticle(asset: CreativeAsset) {
    setAssets(items => items.map(item => item.id === asset.id ? asset : item))
    clearOperationError(asset.id)
  }

  function changeSelectedPrompt(asset: CreativeAsset) {
    setAssets(items => items.map(item => item.id === asset.id ? asset : item))
    clearOperationError(asset.id)
  }

  const saveSelectedArticle = useCallback(async () => {
    if (!selected || savingAssetId !== null) return
    const assetId = selected.id
    const snapshot = { content: selected.content, directory: selected.directory, title: selected.title, url: selected.url }
    clearOperationError(assetId)
    setSavingAssetId(assetId)
    try {
      const updated = await updateCreativeAsset(assetId, snapshot)
      setAssets(items => items.map(item => item.id !== assetId ? item : {
        ...item,
        content: item.content === snapshot.content ? updated.content : item.content,
        directory: item.directory === snapshot.directory ? updated.directory : item.directory,
        title: item.title === snapshot.title ? updated.title : item.title,
        updated_at: updated.updated_at,
        url: item.url === snapshot.url ? updated.url : item.url,
      }))
    } catch {
      setOperationErrors(errors => ({ ...errors, [assetId]: '更新文章素材失败，请重试。' }))
    } finally {
      setSavingAssetId(value => value === assetId ? null : value)
    }
  }, [clearOperationError, savingAssetId, selected])

  const saveSelectedPrompt = useCallback(async () => {
    if (!selected || selected.asset_type !== 'prompt' || savingAssetId !== null) return
    const assetId = selected.id
    const snapshot = {
      content: selected.content,
      directory: selected.directory,
      prompt_kind: selected.prompt_kind === 'image' || selected.prompt_kind === 'video' || selected.prompt_kind === 'other'
        ? selected.prompt_kind
        : 'other' as const,
      title: selected.title,
      url: selected.url,
    }
    clearOperationError(assetId)
    setSavingAssetId(assetId)
    try {
      const updated = await updateCreativeAsset(assetId, snapshot)
      setAssets(items => items.map(item => item.id !== assetId ? item : {
        ...item,
        content: item.content === snapshot.content ? updated.content : item.content,
        directory: item.directory === snapshot.directory ? updated.directory : item.directory,
        prompt_kind: item.prompt_kind === snapshot.prompt_kind ? updated.prompt_kind : item.prompt_kind,
        title: item.title === snapshot.title ? updated.title : item.title,
        updated_at: updated.updated_at,
        url: item.url === snapshot.url ? updated.url : item.url,
      }))
    } catch {
      setOperationErrors(errors => ({ ...errors, [assetId]: '更新提示词资产失败，请重试。' }))
    } finally {
      setSavingAssetId(value => value === assetId ? null : value)
    }
  }, [clearOperationError, savingAssetId, selected])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return
      if (articleDialog || promptDialog || !selected) return
      event.preventDefault()
      if (savingAssetId !== null) return
      if (type === 'article') void saveSelectedArticle()
      if (type === 'prompt') void saveSelectedPrompt()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [articleDialog, promptDialog, saveSelectedArticle, saveSelectedPrompt, savingAssetId, selected, type])

  function selectArticle(id: number) {
    setSelectedId(id)
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
        clearOperationError(selected.id)
        setSelectedId(null)
      },
    })
  }

  function requestPromptDelete() {
    if (!selected || selected.asset_type !== 'prompt') return
    setConfirmation({
      busy: false,
      error: '',
      message: '删除这个提示词资产？生成历史关联会删除，但已生成的媒体资产会保留。',
      action: async () => {
        await deleteCreativeAsset(selected.id)
        setAssets(items => items.filter(item => item.id !== selected.id))
        clearOperationError(selected.id)
        setSelectedId(null)
      },
    })
  }

  const registerMediaAsset = useCallback((asset: CreativeAsset) => {
    setAssets(items => items.some(item => item.id === asset.id)
      ? items.map(item => item.id === asset.id ? asset : item)
      : [asset, ...items])
  }, [])

  function openMediaUpload() {
    setMediaUploadDirectory(directory)
  }

  function openMediaRename() {
    if (!selected || selected.asset_type !== 'media') return
    setMediaRenameDialog({ asset: selected, busy: false, error: '', name: selected.title })
  }

  async function saveMediaRename() {
    if (!mediaRenameDialog || mediaRenameDialog.busy) return
    const form = mediaRenameDialog
    const name = form.name.trim()
    if (!name) {
      setMediaRenameDialog(value => value?.asset.id === form.asset.id ? { ...value, error: '请输入名称。' } : value)
      return
    }
    setMediaRenameDialog(value => value?.asset.id === form.asset.id ? { ...value, busy: true, error: '' } : value)
    try {
      const updated = await updateCreativeAsset(form.asset.id, { title: name })
      setAssets(items => items.map(item => item.id === updated.id ? updated : item))
      setPreviewAsset(value => value?.id === updated.id ? updated : value)
      setMediaRenameDialog(value => value?.asset.id === form.asset.id ? null : value)
    } catch {
      setMediaRenameDialog(value => value?.asset.id === form.asset.id ? { ...value, busy: false, error: '重命名失败，请重试。' } : value)
    }
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
      onRenameDirectory={openDirectoryEditor}
      onTypeChange={changeType}
      type={type}
    />
    <div className="flex min-w-0 flex-1 flex-col">
      <WorkspaceToolbar
        actions={type === 'article'
          ? <Button onClick={openNewArticle} size="sm">新增素材</Button>
          : type === 'prompt'
            ? <Button onClick={openNewPrompt} size="sm">新增提示词</Button>
            : <div className="flex gap-2">
              {selected?.asset_type === 'media' ? <Button onClick={openMediaRename} size="sm" variant="outline">重命名</Button> : null}
              <Button onClick={openMediaUpload} size="sm"><Upload data-icon="inline-start" />上传</Button>
            </div>}
        count={`${visibleAssets.length} 项`}
        title={directory || '全部资产'}
      >
        {type === 'media' ? <div aria-label="媒体筛选" className="flex gap-1" role="group">
          {(['all', 'image', 'video', 'audio'] as MediaFilter[]).map(filter => <Button aria-pressed={mediaFilter === filter} key={filter} onClick={() => setMediaFilter(filter)} size="xs" variant={mediaFilter === filter ? 'secondary' : 'ghost'}>{mediaFilterLabel(filter)}</Button>)}
        </div> : null}
      </WorkspaceToolbar>
      {directoryLoadError ? <div className="flex items-center gap-2 px-7 pt-3">
        <p className="text-sm text-destructive" role="alert">{directoryLoadError}</p>
        <Button onClick={() => setDirectoryLoadAttempt(attempt => attempt + 1)} size="xs" variant="outline">重试加载目录</Button>
      </div> : null}
      {selected && operationErrors[selected.id] ? <p className="px-7 pt-3 text-sm text-destructive" role="alert">{operationErrors[selected.id]}</p> : null}
      {type === 'article'
        ? <ArticleAssetWorkspace assets={visibleAssets} directories={directories} isSaving={savingAssetId !== null} onChange={changeSelectedArticle} onDelete={requestArticleDelete} onSave={saveSelectedArticle} onSelect={selectArticle} selected={selected} />
        : type === 'prompt'
          ? <PromptAssetWorkspace assets={visibleAssets} directories={directories} isSaving={savingAssetId !== null} onChange={changeSelectedPrompt} onDelete={requestPromptDelete} onMediaAsset={registerMediaAsset} onSave={saveSelectedPrompt} onSelect={selectArticle} selected={selected} />
          : <MediaAssetGrid assets={visibleAssets} onPreview={setPreviewAsset} onSelect={setSelectedId} selectedId={selected?.id ?? null} />}
    </div>

    <MediaUploadDialog
      directory={mediaUploadDirectory ?? ''}
      onAssetUploaded={registerMediaAsset}
      onClose={() => setMediaUploadDirectory(null)}
      open={mediaUploadDirectory !== null}
    />

    <Dialog open={previewAsset !== null} onOpenChange={open => { if (!open) setPreviewAsset(null) }}>
      <DialogContent size="lg">
        <DialogHeader><DialogTitle>{previewAsset?.title}</DialogTitle><DialogDescription>双击多媒体资产打开预览。</DialogDescription></DialogHeader>
        {previewAsset?.media_kind === 'image' ? <img alt={previewAsset.title} className="max-h-[75vh] w-full object-contain" src={creativeAssetUrl(previewAsset.url)} /> : null}
        {previewAsset?.media_kind === 'video' ? <video autoPlay className="max-h-[75vh] w-full" controls src={creativeAssetUrl(previewAsset.url)} /> : null}
        {previewAsset?.media_kind === 'audio' ? <audio autoPlay className="w-full" controls src={creativeAssetUrl(previewAsset.url)} /> : null}
      </DialogContent>
    </Dialog>

    <Dialog open={mediaRenameDialog !== null} onOpenChange={open => { if (!open && !mediaRenameDialog?.busy) setMediaRenameDialog(null) }}>
      <DialogContent showCloseButton={!mediaRenameDialog?.busy} size="sm">
        <DialogHeader><DialogTitle>重命名多媒体</DialogTitle><DialogDescription>修改这个多媒体资产在创作资产中的显示名称。</DialogDescription></DialogHeader>
        <Field data-invalid={Boolean(mediaRenameDialog?.error) || undefined}>
          <FieldLabel htmlFor="media-asset-name">名称</FieldLabel>
          <Input aria-invalid={Boolean(mediaRenameDialog?.error) || undefined} autoFocus disabled={mediaRenameDialog?.busy} id="media-asset-name" onChange={event => setMediaRenameDialog(value => value ? { ...value, error: '', name: event.target.value } : value)} value={mediaRenameDialog?.name ?? ''} />
          <FieldError>{mediaRenameDialog?.error}</FieldError>
        </Field>
        <DialogFooter><Button disabled={mediaRenameDialog?.busy} onClick={() => setMediaRenameDialog(null)} variant="outline">取消</Button><Button disabled={mediaRenameDialog?.busy} onClick={() => void saveMediaRename()}>{mediaRenameDialog?.busy ? '保存中…' : '保存'}</Button></DialogFooter>
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

    <Dialog open={promptDialog !== null} onOpenChange={open => { if (!open && !promptDialog?.busy) setPromptDialog(null) }}>
      <DialogContent showCloseButton={!promptDialog?.busy} size="md">
        <DialogHeader><DialogTitle>新增提示词资产</DialogTitle><DialogDescription>保存提示词文本，并选择后续生成结果的类型。</DialogDescription></DialogHeader>
        <div className="space-y-3">
          <div className="grid gap-1.5"><Label htmlFor="prompt-asset-title">提示词标题</Label><Input aria-describedby={promptDialog?.error ? 'prompt-form-error' : undefined} aria-invalid={Boolean(promptDialog?.error) || undefined} autoFocus disabled={promptDialog?.busy} id="prompt-asset-title" onChange={event => setPromptDialog(value => value ? { ...value, error: '', title: event.target.value } : value)} placeholder="提示词标题" value={promptDialog?.title ?? ''} /></div>
          <div className="grid gap-1.5"><Label htmlFor="prompt-asset-kind">提示词类型</Label><NativeSelect aria-label="新提示词类型" className="rounded-md" disabled={promptDialog?.busy} id="prompt-asset-kind" onChange={event => setPromptDialog(value => value ? { ...value, error: '', kind: event.target.value as PromptKind } : value)} value={promptDialog?.kind ?? 'image'}><option value="image">图片提示词</option><option value="video">视频提示词</option><option value="other">其他提示词</option></NativeSelect></div>
          <div className="grid gap-1.5"><Label htmlFor="prompt-asset-content">提示词正文</Label><Textarea aria-describedby={promptDialog?.error ? 'prompt-form-error' : undefined} aria-invalid={Boolean(promptDialog?.error) || undefined} disabled={promptDialog?.busy} id="prompt-asset-content" onChange={event => setPromptDialog(value => value ? { ...value, content: event.target.value, error: '' } : value)} placeholder="输入完整提示词" value={promptDialog?.content ?? ''} /></div>
          {promptDialog?.error ? <p className="text-xs text-destructive" id="prompt-form-error" role="alert">{promptDialog.error}</p> : null}
        </div>
        <DialogFooter><Button disabled={promptDialog?.busy} onClick={() => setPromptDialog(null)} variant="outline">取消</Button><Button disabled={promptDialog?.busy} onClick={() => void saveNewPrompt()}>{promptDialog?.busy ? '保存中…' : '保存'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={directoryDialog !== null} onOpenChange={open => { if (!open && !directoryDialog?.busy) setDirectoryDialog(null) }}>
      <DialogContent showCloseButton={!directoryDialog?.busy} size="sm">
        <DialogHeader><DialogTitle>{directoryDialog?.item ? '重命名目录' : '新增目录'}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-1.5"><Label htmlFor="asset-directory-name">目录名称</Label><Input aria-describedby={directoryDialog?.error ? 'directory-form-error' : undefined} aria-invalid={Boolean(directoryDialog?.error) || undefined} autoFocus disabled={directoryDialog?.busy} id="asset-directory-name" onChange={event => setDirectoryDialog(value => value ? { ...value, error: '', name: event.target.value } : value)} placeholder="目录名称" value={directoryDialog?.name ?? ''} /></div>
          {type === 'article' || type === 'prompt' ? (
            <section className="space-y-3 rounded-lg border border-border p-3">
              <div>
                <p className="text-sm font-medium">AI 素材入库</p>
                <p className="text-xs text-muted-foreground">X 订阅选择这个文件夹后，AI 会按这条规则判断是否归入{type === 'prompt' ? '并提取提示词' : ''}。</p>
              </div>
              <label className="flex items-center justify-between gap-3 rounded-md bg-muted/40 px-3 py-2 text-xs" htmlFor="directory-ai-ingestion-enabled">
                <span>启用 AI 素材入库</span>
                <Switch checked={directoryDialog?.aiIngestionEnabled ?? false} disabled={directoryDialog?.busy} id="directory-ai-ingestion-enabled" onCheckedChange={checked => setDirectoryDialog(value => value ? { ...value, aiIngestionEnabled: checked, error: '' } : value)} />
              </label>
              <div className="grid gap-1.5"><Label htmlFor="directory-ai-ingestion-keywords">AI 入库关键词</Label><Input disabled={directoryDialog?.busy} id="directory-ai-ingestion-keywords" onChange={event => setDirectoryDialog(value => value ? { ...value, aiIngestionKeywords: event.target.value, error: '' } : value)} placeholder="关键词（逗号分隔，可留空）" value={directoryDialog?.aiIngestionKeywords ?? ''} /></div>
              <div className="grid gap-1.5"><Label htmlFor="directory-ai-ingestion-prompt">AI 入库规则</Label><Textarea disabled={directoryDialog?.busy} id="directory-ai-ingestion-prompt" maxLength={4000} onChange={event => setDirectoryDialog(value => value ? { ...value, aiIngestionPrompt: event.target.value, error: '' } : value)} placeholder={type === 'prompt' ? '例如：只接受帖子中完整、可直接复用的图片或视频提示词。' : '例如：只接受有具体案例、数据或可执行方法的内容。'} rows={4} value={directoryDialog?.aiIngestionPrompt ?? ''} /></div>
            </section>
          ) : null}
        </div>
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
