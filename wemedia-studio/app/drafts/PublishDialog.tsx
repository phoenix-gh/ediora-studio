'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import { DraftImage } from '@/lib/api/drafts'
import { WechatPublishPanel } from './WechatPublishPanel'
import { XArticlePanel } from './XArticlePanel'
import { BlogPublishPanel } from './BlogPublishPanel'

const TAB_STORAGE_KEY = 'wms-publish-tab'

type PublishTab = 'wechat' | 'x' | 'blog'

const TABS: { value: PublishTab; label: string }[] = [
  { value: 'wechat', label: '公众号' },
  { value: 'x', label: 'X 长文' },
  { value: 'blog', label: 'Blog' },
]

const TAB_DESCRIPTION: Record<PublishTab, string> = {
  wechat: '渲染排版后存入公众号草稿箱；群发请到公众号后台确认',
  x: 'X 没有长文发布接口：预览并复制内容，到 x.com 文章编辑器手动发布',
  blog: '提交到 MK Flow 博客，进入 review 状态，人工后台审核后发布',
}

/** 统一发布弹窗：壳 + 平台 tab，各平台面板独立组件。 */
export function PublishDialog({
  open, onClose, draftId, title, content, images,
}: {
  open: boolean
  onClose: () => void
  draftId: number
  title: string
  content: string
  images: DraftImage[]
}) {
  const [tab, setTab] = useState<PublishTab>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(TAB_STORAGE_KEY)
      if (saved === 'wechat' || saved === 'x' || saved === 'blog') return saved
    }
    return 'wechat'
  })
  // 面板懒挂载：切到过的 tab 保持挂载（hidden 隐藏），切回不丢状态、不重渲染
  const [activated, setActivated] = useState<Record<PublishTab, boolean>>(
    () => ({ wechat: tab === 'wechat', x: tab === 'x', blog: tab === 'blog' }),
  )

  function pickTab(t: PublishTab) {
    setTab(t)
    setActivated(a => (a[t] ? a : { ...a, [t]: true }))
    try { localStorage.setItem(TAB_STORAGE_KEY, t) } catch {}
  }

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-5xl h-[85vh] flex flex-col">
        <DialogHeader>
          <div className="flex items-center gap-4">
            <DialogTitle>发布</DialogTitle>
            <div className="flex items-center gap-1.5">
              {TABS.map(t => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => pickTab(t.value)}
                  className={cn(
                    'text-xs px-3 py-1 rounded-full font-medium transition-colors',
                    tab === t.value
                      ? 'bg-indigo-50 text-indigo-700 ring-1 ring-indigo-400 dark:bg-indigo-950/40 dark:text-indigo-300'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted',
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          <DialogDescription>{TAB_DESCRIPTION[tab]}</DialogDescription>
        </DialogHeader>

        {activated.wechat && (
          <div className={cn('flex-1 flex flex-col overflow-hidden min-h-0', tab !== 'wechat' && 'hidden')}>
            <WechatPublishPanel
              onClose={onClose}
              draftId={draftId}
              title={title}
              content={content}
              images={images}
            />
          </div>
        )}
        {activated.x && (
          <div className={cn('flex-1 flex flex-col overflow-hidden min-h-0', tab !== 'x' && 'hidden')}>
            <XArticlePanel title={title} content={content} images={images} />
          </div>
        )}
        {activated.blog && (
          <div className={cn('flex-1 flex flex-col overflow-hidden min-h-0', tab !== 'blog' && 'hidden')}>
            <BlogPublishPanel draftId={draftId} title={title} content={content} images={images} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
