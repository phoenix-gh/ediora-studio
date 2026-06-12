/** 发布面板（公众号 / X 长文）共享的封面挑选与图片 URL 处理工具。 */

import { DraftImage } from '@/lib/api/drafts'
import { API_BASE } from '@/lib/api/client'

export function isCoverImage(img: DraftImage): boolean {
  const name = (img.original_name || img.filename || '').toLowerCase()
  return name.startsWith('cover')
}

export function pickDefaultCoverImage(images: DraftImage[]): DraftImage | null {
  return images.filter(isCoverImage).sort((a, b) => b.id - a.id)[0] ?? images[0] ?? null
}

/** markdown → 纯文本摘录，用作摘要默认值 */
export function mdToPlainExcerpt(md: string, limit: number): string {
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

/** 相对路径图片 src 转绝对 URL（剪贴板 HTML 里必须是绝对地址）。 */
export function resolveCopyImageUrl(src: string): string {
  if (!src || src.startsWith('data:') || /^https?:\/\//i.test(src)) return src
  if (src.startsWith('/api/')) return `${API_BASE.replace(/\/api\/?$/, '')}${src}`
  if (src.startsWith('/')) {
    return typeof window === 'undefined' ? src : new URL(src, window.location.origin).toString()
  }
  return typeof window === 'undefined' ? src : new URL(src, window.location.href).toString()
}

export function imageCopyApiUrl(src: string): string {
  return `${API_BASE}/write/image-copy-source?src=${encodeURIComponent(src)}`
}
