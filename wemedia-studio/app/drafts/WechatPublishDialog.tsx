'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import { Loader2, Copy, Send, ImageOff } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { DraftImage, publishDraftToWechat } from '@/lib/api/drafts'
import { PublishAccount, listPublishAccounts } from '@/lib/api/publish-accounts'

type WenyanModule = typeof import('@wenyan-md/core')
type WenyanInstance = Awaited<ReturnType<WenyanModule['createWenyanCore']>>

const THEME_STORAGE_KEY = 'wms-wechat-theme'
const HL_THEME_ID = 'solarized-light'

interface ThemeOption {
  id: string
  name: string
  description: string
}

/** markdown → 纯文本摘录，用作摘要默认值 */
function mdToPlainExcerpt(md: string, limit: number): string {
  return md
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[#>\-*+\s]+/gm, '')
    .replace(/[*`~_]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}

export function WechatPublishDialog({
  open, onClose, draftId, title, content, images,
}: {
  open: boolean
  onClose: () => void
  draftId: number
  title: string
  content: string
  images: DraftImage[]
}) {
  const [accounts, setAccounts] = useState<PublishAccount[]>([])
  const [accountId, setAccountId] = useState('')
  const [themes, setThemes] = useState<ThemeOption[]>([])
  const [themeId, setThemeId] = useState('default')
  const [coverId, setCoverId] = useState<number | null>(null)
  const [pubTitle, setPubTitle] = useState('')
  const [digest, setDigest] = useState('')
  const [html, setHtml] = useState('')   // 空串 = 渲染中
  const [publishing, setPublishing] = useState(false)
  const wenyanRef = useRef<WenyanInstance | null>(null)

  // 打开瞬间重置表单默认值（render 期间调整状态，避免 effect 内同步 setState）
  const [lastOpen, setLastOpen] = useState(false)
  if (open !== lastOpen) {
    setLastOpen(open)
    if (open) {
      setPubTitle(title)
      setDigest(mdToPlainExcerpt(content, 120))
      setCoverId(images[0]?.id ?? null)
      setHtml('')
      const saved = typeof window !== 'undefined' ? localStorage.getItem(THEME_STORAGE_KEY) : null
      if (saved) setThemeId(saved)
    }
  }

  // 打开时：加载账号 + 懒加载渲染引擎
  useEffect(() => {
    if (!open) return
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
  }, [open])

  // 渲染：引擎就绪（themes 注册完成）或主题切换时重渲染
  useEffect(() => {
    if (!open || !wenyanRef.current) return
    let cancelled = false
    ;(async () => {
      try {
        const wenyan = wenyanRef.current!
        const inner = await wenyan.renderMarkdown(content)
        if (cancelled) return
        // applyStylesWithTheme 需要挂在真实 DOM 上的元素来解析样式
        const el = document.createElement('div')
        el.style.position = 'fixed'
        el.style.left = '-99999px'
        el.innerHTML = inner
        document.body.appendChild(el)
        try {
          const styled = await wenyan.applyStylesWithTheme(el, {
            themeId,
            hlThemeId: HL_THEME_ID,
            isMacStyle: true,
            isAddFootnote: true,
          })
          if (!cancelled) setHtml(styled)
        } finally {
          el.remove()
        }
      } catch {
        if (!cancelled) toast.error('渲染失败')
      }
    })()
    return () => { cancelled = true }
  }, [open, themeId, content, themes.length])

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

  async function handlePublish() {
    if (!accountId) { toast.error('请选择发布账号'); return }
    if (!coverId) { toast.error('请先在素材库上传封面图'); return }
    if (!pubTitle.trim()) { toast.error('标题不能为空'); return }
    if (!html) return
    setPublishing(true)
    try {
      await publishDraftToWechat(draftId, {
        account_id: accountId,
        title: pubTitle.trim(),
        digest,
        html,
        cover_image_id: coverId,
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

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-5xl h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>发布到公众号</DialogTitle>
          <DialogDescription>
            渲染排版后存入公众号草稿箱；群发请到公众号后台确认
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 flex gap-4 overflow-hidden min-h-0">
          {/* ── 预览 ── */}
          <div className="flex-1 min-w-0 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-100 dark:bg-zinc-900 flex justify-center overflow-hidden">
            {!html ? (
              <div className="flex items-center gap-2 text-zinc-400 text-sm">
                <Loader2 className="w-4 h-4 animate-spin" /> 渲染中…
              </div>
            ) : (
              <iframe
                srcDoc={srcDoc}
                sandbox=""
                title="公众号预览"
                className="w-[390px] h-full bg-white border-x border-zinc-200 dark:border-zinc-700"
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
                <select
                  value={accountId}
                  onChange={e => setAccountId(e.target.value)}
                  className="h-8 w-full rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 text-sm"
                >
                  {accounts.map(a => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
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
                        : 'border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:border-zinc-300 dark:hover:border-zinc-600',
                    )}
                  >
                    <span className="font-medium">{t.name}</span>
                    {t.description && (
                      <span className="block text-[10px] text-zinc-400 truncate">{t.description}</span>
                    )}
                  </button>
                ))}
                {themes.length === 0 && (
                  <p className="text-[11px] text-zinc-400">主题加载中…</p>
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
                className="w-full resize-none rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
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
                  {images.map(img => (
                    <button
                      key={img.id}
                      onClick={() => setCoverId(img.id)}
                      title={img.original_name}
                      className={cn(
                        'aspect-square rounded-md overflow-hidden border-2 transition-colors',
                        coverId === img.id ? 'border-indigo-400' : 'border-transparent hover:border-zinc-300',
                      )}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={img.hosted_url} alt={img.original_name} className="w-full h-full object-cover" />
                    </button>
                  ))}
                </div>
              )}
            </div>

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
                disabled={publishing || !html || !accountId || !coverId}
                className="w-full gap-1.5"
              >
                {publishing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                存入公众号草稿箱
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
