'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import { Loader2, Copy, Send, ImageOff } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { DraftImage, publishDraftToWechat } from '@/lib/api/drafts'
import { PublishAccount, listPublishAccounts } from '@/lib/api/publish-accounts'
import {
  isCoverImage, pickDefaultCoverImage, mdToPlainExcerpt,
  resolveCopyImageUrl, imageCopyApiUrl,
} from './publish-helpers'

type WenyanModule = typeof import('@wenyan-md/core')
type WenyanInstance = Awaited<ReturnType<WenyanModule['createWenyanCore']>>

const THEME_STORAGE_KEY = 'wms-wechat-theme'
const HL_THEME_ID = 'solarized-light'

interface ThemeOption {
  id: string
  name: string
  description: string
}

interface PreviewImage {
  src: string
  copySrc: string
  alt: string
}

function extractPreviewImages(html: string): PreviewImage[] {
  if (!html || typeof window === 'undefined') return []
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const seen = new Set<string>()
  return Array.from(doc.querySelectorAll('img'))
    .map((img, index) => {
      const src = img.getAttribute('src')?.trim() ?? ''
      return {
        src,
        copySrc: resolveCopyImageUrl(src),
        alt: img.getAttribute('alt')?.trim() || `图片 ${index + 1}`,
      }
    })
    .filter(img => {
      if (!img.src || seen.has(img.copySrc)) return false
      seen.add(img.copySrc)
      return true
    })
}

async function imageBlobToPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob
  const objectUrl = URL.createObjectURL(blob)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('image decode failed'))
      el.src = objectUrl
    })
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth || img.width
    canvas.height = img.naturalHeight || img.height
    const ctx = canvas.getContext('2d')
    if (!ctx || canvas.width === 0 || canvas.height === 0) {
      throw new Error('canvas unavailable')
    }
    ctx.drawImage(img, 0, 0)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(out => {
        if (out) resolve(out)
        else reject(new Error('png encode failed'))
      }, 'image/png')
    })
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

export function WechatPublishPanel({
  onClose, draftId, title, content, images,
}: {
  onClose: () => void
  draftId: number
  title: string
  content: string
  images: DraftImage[]
}) {
  const [accounts, setAccounts] = useState<PublishAccount[]>([])
  const [accountId, setAccountId] = useState('')
  const [themes, setThemes] = useState<ThemeOption[]>([])
  const [themeId, setThemeId] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(THEME_STORAGE_KEY)
      if (saved) return saved
    }
    return 'default'
  })
  const [coverId, setCoverId] = useState<number | null>(() => pickDefaultCoverImage(images)?.id ?? null)
  const [pubTitle, setPubTitle] = useState(title)
  const [digest, setDigest] = useState(() => mdToPlainExcerpt(content, 120))
  const [html, setHtml] = useState('')   // 空串 = 渲染中
  const [publishing, setPublishing] = useState(false)
  const [copyingImageSrc, setCopyingImageSrc] = useState('')
  const wenyanRef = useRef<WenyanInstance | null>(null)

  // 挂载时：加载账号 + 懒加载渲染引擎（面板随弹窗打开而挂载，关闭即卸载）
  useEffect(() => {
    listPublishAccounts()
      .then(list => {
        const usable = list.filter(a => a.platform === 'wechat' && a.app_id && a.app_secret)
        setAccounts(usable)
        setAccountId(prev => (usable.some(a => a.id === prev) ? prev : (usable[0]?.id ?? '')))
      })
      .catch(() => toast.error('加载发布账号失败'))
    ;(async () => {
      if (wenyanRef.current) return
      const mod = await import('@wenyan-md/core')
      mod.registerAllBuiltInThemes()
      mod.registerBuiltInHlThemes()
      wenyanRef.current = await mod.createWenyanCore({ isWechat: true })
      setThemes(mod.getAllGzhThemes().map(t => ({
        id: t.meta.id, name: t.meta.name, description: t.meta.description,
      })))
    })().catch(() => toast.error('加载渲染引擎失败'))
  }, [])

  // 渲染：引擎就绪（themes 注册完成）或主题切换时重渲染
  useEffect(() => {
    if (!wenyanRef.current) return
    let cancelled = false
    ;(async () => {
      try {
        const wenyan = wenyanRef.current!
        const inner = await wenyan.renderMarkdown(content)
        if (cancelled) return
        // 主题 CSS 全部以 #wenyan 选择器为前缀，容器必须是 section#wenyan，
        // 否则样式静默不内联；返回值是该元素的 outerHTML，所以容器上不能带
        // 任何额外样式（曾因藏屏幕外的 position:fixed 把预览整体推出可视区）。
        // 样式内联不依赖 layout，元素无需挂载到 document。
        const el = document.createElement('section')
        el.id = 'wenyan'
        el.innerHTML = inner
        const styled = await wenyan.applyStylesWithTheme(el, {
          themeId,
          hlThemeId: HL_THEME_ID,
          isMacStyle: true,
          isAddFootnote: true,
        })
        if (!cancelled) setHtml(styled)
      } catch {
        if (!cancelled) toast.error('渲染失败')
      }
    })()
    return () => { cancelled = true }
  }, [themeId, content, themes.length])

  function pickTheme(id: string) {
    setThemeId(id)
    setHtml('')   // 进入"渲染中"占位，渲染 effect 完成后回填
    try { localStorage.setItem(THEME_STORAGE_KEY, id) } catch {}
  }

  async function handleCopy() {
    if (!html) return
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([html], { type: 'text/plain' }),
        }),
      ])
      toast.success('已复制带样式内容，可直接粘贴到公众号编辑器')
    } catch {
      try {
        await navigator.clipboard.writeText(html)
        toast.success('已复制 HTML 源码')
      } catch {
        toast.error('复制失败')
      }
    }
  }

  async function handleCopyImage(img: PreviewImage) {
    if (!('ClipboardItem' in window) || !navigator.clipboard?.write) {
      toast.error('当前浏览器不支持复制图片到剪贴板')
      return
    }
    setCopyingImageSrc(img.copySrc)
    try {
      const res = await fetch(img.src.startsWith('data:') ? img.src : imageCopyApiUrl(img.src))
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const png = await imageBlobToPng(await res.blob())
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': png }),
      ])
      toast.success('已复制图片，可直接粘贴到编辑器')
    } catch {
      toast.error('复制图片失败，可能是图片跨域或浏览器权限限制')
    } finally {
      setCopyingImageSrc('')
    }
  }

  async function handlePublish() {
    if (!accountId) { toast.error('请选择发布账号'); return }
    if (!effectiveCoverId) { toast.error('请先在素材库上传封面图'); return }
    if (!pubTitle.trim()) { toast.error('标题不能为空'); return }
    if (!html) return
    setPublishing(true)
    try {
      await publishDraftToWechat(draftId, {
        account_id: accountId,
        title: pubTitle.trim(),
        digest,
        html,
        cover_image_id: effectiveCoverId,
      })
      toast.success('已存入公众号草稿箱，请到公众号后台确认发布')
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '发布失败')
    } finally {
      setPublishing(false)
    }
  }

  const srcDoc = useMemo(
    () => `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:16px;background:#fff;}</style></head><body>${html}</body></html>`,
    [html],
  )
  const previewImages = useMemo(() => extractPreviewImages(html), [html])
  const coverChoices = useMemo(
    () => [...images].sort((a, b) => {
      const aCover = isCoverImage(a)
      const bCover = isCoverImage(b)
      if (aCover !== bCover) return aCover ? -1 : 1
      return b.id - a.id
    }),
    [images],
  )
  const defaultCoverId = useMemo(() => pickDefaultCoverImage(images)?.id ?? null, [images])
  const effectiveCoverId = coverId && images.some(img => img.id === coverId) ? coverId : defaultCoverId

  return (
    <div className="flex-1 flex gap-4 overflow-hidden min-h-0">
      {/* ── 预览 ── */}
      <div className="flex-1 min-w-0 rounded-lg border border-border bg-surface-muted flex justify-center overflow-hidden">
        {!html ? (
          <div className="flex items-center gap-2 text-foreground-subtle text-sm">
            <Loader2 className="w-4 h-4 animate-spin" /> 渲染中…
          </div>
        ) : (
          <iframe
            srcDoc={srcDoc}
            sandbox=""
            title="公众号预览"
            className="w-full h-full bg-white"
          />
        )}
      </div>

      {/* ── 配置面板 ── */}
      <div className="w-72 flex-shrink-0 overflow-y-auto space-y-4 pr-1">
        <div className="space-y-1">
          <Label className="text-xs">发布账号</Label>
          {accounts.length === 0 ? (
            <p className="text-[11px] text-amber-500">
              没有可用的公众号账号。请到「设置 → 发布账号」给 wechat 平台账号配置 AppID/AppSecret。
            </p>
          ) : (
            <NativeSelect
              value={accountId}
              onChange={e => setAccountId(e.target.value)}
              className="h-8 rounded-md px-2 text-sm"
            >
              {accounts.map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </NativeSelect>
          )}
        </div>

        <div className="space-y-1">
          <Label className="text-xs">排版主题</Label>
          <div className="space-y-1">
            {themes.map(t => (
              <button
                key={t.id}
                onClick={() => pickTheme(t.id)}
                className={cn(
                  'w-full text-left px-2.5 py-1.5 rounded-md border text-xs transition-colors',
                  themeId === t.id
                    ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-950/30 text-indigo-700 dark:text-indigo-300'
                    : 'border-input text-muted-foreground hover:border-border-strong',
                )}
              >
                <span className="font-medium">{t.name}</span>
                {t.description && (
                  <span className="block text-[10px] text-foreground-subtle truncate">{t.description}</span>
                )}
              </button>
            ))}
            {themes.length === 0 && (
              <p className="text-[11px] text-foreground-subtle">主题加载中…</p>
            )}
          </div>
        </div>

        <div className="space-y-1">
          <Label className="text-xs">标题（≤64 字）</Label>
          <Input
            value={pubTitle}
            maxLength={64}
            onChange={e => setPubTitle(e.target.value)}
            className="h-8 text-sm"
          />
        </div>

        <div className="space-y-1">
          <Label className="text-xs">摘要（≤120 字）</Label>
          <textarea
            value={digest}
            maxLength={120}
            onChange={e => setDigest(e.target.value)}
            rows={3}
            className="w-full resize-none rounded-lg border border-input bg-control px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
          />
        </div>

        <div className="space-y-1">
          <Label className="text-xs">封面（必选）</Label>
          {images.length === 0 ? (
            <div className="flex items-center gap-2 text-[11px] text-amber-500 border border-amber-200 dark:border-amber-900 rounded-md px-2.5 py-2">
              <ImageOff className="w-3.5 h-3.5 flex-shrink-0" />
              素材库没有图片，请先在「素材」里上传封面图
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-1.5">
              {coverChoices.map(img => (
                <button
                  key={img.id}
                  onClick={() => setCoverId(img.id)}
                  title={img.original_name}
                  className={cn(
                    'aspect-square rounded-md overflow-hidden border-2 transition-colors',
                    effectiveCoverId === img.id ? 'border-indigo-400' : 'border-transparent hover:border-border-strong',
                  )}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={img.hosted_url} alt={img.original_name} className="w-full h-full object-cover" />
                </button>
              ))}
            </div>
          )}
        </div>

        {previewImages.length > 0 && (
          <div className="space-y-1">
            <Label className="text-xs">预览图片</Label>
            <div className="space-y-1.5">
              {previewImages.map((img, index) => {
                const copying = copyingImageSrc === img.copySrc
                return (
                  <div key={img.copySrc} className="flex items-center gap-2 rounded-md border border-border p-1.5 bg-surface">
                    <div className="h-10 w-10 flex-shrink-0 overflow-hidden rounded bg-muted">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={img.copySrc} alt={img.alt} className="h-full w-full object-cover" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs text-foreground">{img.alt}</div>
                      <div className="text-[10px] text-foreground-subtle">第 {index + 1} 张</div>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => handleCopyImage(img)}
                      disabled={copyingImageSrc !== ''}
                      className="h-7 flex-shrink-0 gap-1 px-2 text-xs"
                    >
                      {copying ? <Loader2 className="w-3 h-3 animate-spin" /> : <Copy className="w-3 h-3" />}
                      复制图片
                    </Button>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <div className="space-y-2 pt-1">
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopy}
            disabled={!html}
            className="w-full gap-1.5"
          >
            <Copy className="w-3.5 h-3.5" /> 复制 HTML
          </Button>
          <Button
            size="sm"
            onClick={handlePublish}
            disabled={publishing || !html || !accountId || !effectiveCoverId}
            className="w-full gap-1.5"
          >
            {publishing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
            存入公众号草稿箱
          </Button>
        </div>
      </div>
    </div>
  )
}
