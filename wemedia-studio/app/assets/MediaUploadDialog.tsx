'use client'

import type { ClipboardEvent, DragEvent } from 'react'
import { useEffect, useRef, useState } from 'react'
import { FileAudio, FileVideo, Trash2, Upload } from 'lucide-react'
import { toast } from 'sonner'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { uploadCreativeAsset, type CreativeAsset } from '@/lib/api/assets'

type MediaKind = 'image' | 'video' | 'audio'
type UploadStatus = 'pending' | 'uploading' | 'failed'
type UploadItem = {
  error: string
  file: File
  id: string
  kind: MediaKind
  previewUrl: string
  status: UploadStatus
}

type MediaUploadDialogProps = {
  directory: string
  onAssetUploaded: (asset: CreativeAsset) => void
  onClose: () => void
  open: boolean
}

function mediaKind(file: File): MediaKind | null {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('video/')) return 'video'
  if (file.type.startsWith('audio/')) return 'audio'
  return null
}

function fileIdentity(file: File) {
  return `${file.name}\u0000${file.size}\u0000${file.type}\u0000${file.lastModified}`
}

function formatSize(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function kindLabel(kind: MediaKind) {
  if (kind === 'image') return '图片'
  if (kind === 'video') return '视频'
  return '音频'
}

export function MediaUploadDialog({
  directory,
  onAssetUploaded,
  onClose,
  open,
}: MediaUploadDialogProps) {
  const [items, setItems] = useState<UploadItem[]>([])
  const [notices, setNotices] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const itemsRef = useRef<UploadItem[]>([])
  const sessionRef = useRef(0)

  function replaceItems(update: (current: UploadItem[]) => UploadItem[]) {
    const next = update(itemsRef.current)
    itemsRef.current = next
    setItems(next)
  }

  useEffect(() => {
    if (open) sessionRef.current += 1
    return () => {
      sessionRef.current += 1
      for (const item of itemsRef.current) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
      }
      itemsRef.current = []
    }
  }, [open])

  function addNotice(message: string) {
    setNotices(current => current.includes(message) ? current : [...current, message])
  }

  function addFiles(files: Iterable<File>) {
    const incoming = Array.from(files)
    let rejected = 0
    let duplicates = 0
    replaceItems(current => {
      const known = new Set(current.map(item => item.id))
      const accepted = [...current]
      for (const file of incoming) {
        const kind = mediaKind(file)
        if (!kind) {
          rejected += 1
          continue
        }
        const id = fileIdentity(file)
        if (known.has(id)) {
          duplicates += 1
          continue
        }
        known.add(id)
        accepted.push({
          error: '',
          file,
          id,
          kind,
          previewUrl: kind === 'image' ? URL.createObjectURL(file) : '',
          status: 'pending',
        })
      }
      return accepted
    })
    if (rejected) addNotice('仅支持图片、视频和音频文件')
    if (duplicates) addNotice(`已忽略 ${duplicates} 个重复文件`)
  }

  function removeItem(id: string) {
    replaceItems(current => current.filter(item => {
      if (item.id !== id) return true
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
      return false
    }))
  }

  function clearQueue() {
    for (const item of itemsRef.current) {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
    }
    replaceItems(() => [])
    setNotices([])
  }

  async function uploadOne(id: string, session: number) {
    const item = itemsRef.current.find(candidate => candidate.id === id)
    if (!item) return false
    replaceItems(current => current.map(candidate => candidate.id === id
      ? { ...candidate, error: '', status: 'uploading' }
      : candidate))
    try {
      const asset = await uploadCreativeAsset(item.kind, item.file, directory)
      if (sessionRef.current !== session) return true
      onAssetUploaded(asset)
      removeItem(id)
      return true
    } catch (error) {
      if (sessionRef.current === session) {
        replaceItems(current => current.map(candidate => candidate.id === id
          ? {
            ...candidate,
            error: error instanceof Error ? error.message : '上传失败，请重试。',
            status: 'failed',
          }
          : candidate))
      }
      return false
    }
  }

  async function uploadIds(ids: string[]) {
    if (!ids.length || running) return
    setRunning(true)
    const session = sessionRef.current
    let nextIndex = 0
    let successCount = 0
    async function worker() {
      while (nextIndex < ids.length) {
        const id = ids[nextIndex]
        nextIndex += 1
        if (await uploadOne(id, session)) successCount += 1
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, ids.length) }, worker))
    if (sessionRef.current !== session) return
    setRunning(false)
    if (itemsRef.current.length === 0) {
      toast.success(`已上传 ${successCount} 个文件`)
      onClose()
    }
  }

  function startPendingUploads() {
    void uploadIds(itemsRef.current
      .filter(item => item.status === 'pending' || item.status === 'failed')
      .map(item => item.id))
  }

  function requestClose() {
    if (itemsRef.current.length === 0) {
      sessionRef.current += 1
      onClose()
      return
    }
    setConfirmClose(true)
  }

  function closeConfirmed() {
    sessionRef.current += 1
    setConfirmClose(false)
    onClose()
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    addFiles(event.dataTransfer.files)
  }

  function handlePaste(event: ClipboardEvent<HTMLDivElement>) {
    const files = Array.from(event.clipboardData.files)
    if (files.length) {
      event.preventDefault()
      addFiles(files)
      return
    }
    if (event.clipboardData.getData('text/plain')) {
      event.preventDefault()
      addNotice('仅支持图片、视频和音频文件')
    }
  }

  const uploadableCount = items.filter(item => item.status !== 'uploading').length

  return <>
    <Dialog open={open} onOpenChange={nextOpen => { if (!nextOpen) requestClose() }}>
      <DialogContent onPaste={handlePaste} showCloseButton={!running} size="md">
        <DialogHeader>
          <DialogTitle>上传多媒体</DialogTitle>
          <DialogDescription>上传到：{directory || '未分类'}</DialogDescription>
        </DialogHeader>

        <div
          className="grid min-h-36 cursor-pointer place-items-center rounded-xl border border-dashed border-border-strong bg-muted/35 p-6 text-center hover:bg-muted/60"
          data-testid="media-upload-dropzone"
          onClick={() => inputRef.current?.click()}
          onDragOver={event => event.preventDefault()}
          onDrop={handleDrop}
          role="button"
          tabIndex={0}
        >
          <div className="space-y-2">
            <Upload className="mx-auto size-7 text-muted-foreground" />
            <p className="font-medium">选择、拖拽或粘贴多个文件</p>
            <p className="text-xs text-muted-foreground">支持图片、视频和音频 · Ctrl/Cmd + V 直接粘贴</p>
          </div>
        </div>
        <input
          accept="image/*,video/*,audio/*"
          aria-label="选择多媒体文件"
          className="hidden"
          multiple
          onChange={event => {
            if (event.target.files) addFiles(event.target.files)
            event.target.value = ''
          }}
          ref={inputRef}
          type="file"
        />

        {notices.length ? <p className="text-xs text-muted-foreground" role="status">{notices.join('；')}</p> : null}

        {items.length ? <div className="max-h-72 space-y-2 overflow-y-auto">
          {items.map(item => <div className="flex items-center gap-3 rounded-lg border border-border p-2" key={item.id}>
            <MediaQueuePreview item={item} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{item.file.name}</p>
              <p className="text-xs text-muted-foreground">{kindLabel(item.kind)} · {formatSize(item.file.size)} · {item.status === 'uploading' ? '上传中…' : item.status === 'failed' ? '上传失败' : '待上传'}</p>
              {item.error ? <p className="text-xs text-destructive">{item.error}</p> : null}
            </div>
            {item.status === 'failed' ? <Button aria-label={`重试 ${item.file.name}`} disabled={running} onClick={() => void uploadIds([item.id])} size="xs" variant="outline">重试</Button> : null}
            <Button aria-label={`移除 ${item.file.name}`} disabled={item.status === 'uploading'} onClick={() => removeItem(item.id)} size="icon-sm" variant="ghost"><Trash2 /></Button>
          </div>)}
        </div> : null}

        <DialogFooter>
          <Button disabled={running} onClick={requestClose} variant="outline">取消</Button>
          <Button disabled={running || items.length === 0} onClick={clearQueue} variant="ghost">清空队列</Button>
          <Button disabled={running || uploadableCount === 0} onClick={startPendingUploads}>{running ? '上传中…' : `上传 ${uploadableCount} 个文件`}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <AlertDialog onOpenChange={setConfirmClose} open={confirmClose}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>关闭上传窗口？</AlertDialogTitle>
          <AlertDialogDescription>还有未完成的上传，确定关闭？</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>继续上传</AlertDialogCancel>
          <AlertDialogAction onClick={closeConfirmed}>确定关闭</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>
}

function MediaQueuePreview({ item }: { item: UploadItem }) {
  // Blob previews are local, short-lived URLs and cannot use Next image optimization.
  // eslint-disable-next-line @next/next/no-img-element
  if (item.kind === 'image') return <img alt="" className="size-12 rounded-md object-cover" src={item.previewUrl} />
  if (item.kind === 'video') return <div className="grid size-12 place-items-center rounded-md bg-muted"><FileVideo /></div>
  return <div className="grid size-12 place-items-center rounded-md bg-muted"><FileAudio /></div>
}
