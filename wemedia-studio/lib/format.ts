/**
 * Shared formatting helpers used across feed/article pages.
 * Keep these pure — no React or DOM dependencies.
 */

const LOCALE = 'zh-CN'

/** "刚刚" / "X 分钟前" / "X 小时前" / "X 天前" / "Mon d" — used by KR/Juejin/V2EX/Drafts/Wechat. */
export function fmtRelTime(iso: string): string {
  const ts = new Date(iso).getTime()
  const diff = (Date.now() - ts) / 1000
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`
  return new Date(iso).toLocaleDateString(LOCALE, { month: 'short', day: 'numeric' })
}

/** Compact number with Chinese "w" (万) and "k" suffixes. KR/Juejin/Wechat style. */
export function fmtNum(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}w`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

/** Compact number with English K/M suffixes. YouTube/X style. */
export function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

/** Short calendar date — "Mon d" in zh-CN. */
export function fmtShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(LOCALE, { month: 'short', day: 'numeric' })
}

/** Full date with year — "2026 5月 3日" — for wechat-style feeds whose articles span years. */
export function fmtFullDate(iso: string): string {
  return new Date(iso).toLocaleDateString(LOCALE, { year: 'numeric', month: 'short', day: 'numeric' })
}
