/**
 * X 长文（X Articles）发布辅助：markdown → 纯文本、不支持语法扫描。
 * 与 UI 解耦的纯函数，便于将来补测试。
 */

/** 正文以 `# 标题` 开头且与标题字段一致时剥掉首行——X 文章标题单独填，
 * 不剥会在粘贴后和标题字段重复。仅在严格匹配时动手，避免误删正文标题。 */
export function stripLeadingTitleHeading(md: string, title: string): string {
  const t = title.trim()
  if (!t) return md
  const m = md.match(/^\s*#\s+(.+?)\s*\n+/)
  if (m && m[1].trim() === t) return md.slice(m[0].length)
  return md
}

/** markdown → 可直接粘贴的纯文本：去语法符号、保留段落结构。 */
export function mdToPlainText(md: string): string {
  let text = md
  // 系统自动插图的注释壳
  text = text.replace(/<!--\s*\/?wms-illus\s*-->/g, '')
  // 围栏代码块：去 ``` 行保留内容
  text = text.replace(/^```.*$/gm, '')
  // 图片整体移除
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  // 链接 → 文字 (url)
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '$1 ($2)')
  // 标题 / 引用前缀
  text = text.replace(/^#{1,6}\s+/gm, '')
  text = text.replace(/^>\s?/gm, '')
  // 粗体 / 斜体 / 删除线 / 行内代码符号
  text = text.replace(/(\*\*|__)([^*_]+)\1/g, '$2')
  text = text.replace(/\*([^*\n]+)\*/g, '$1')
  text = text.replace(/~~([^~\n]+)~~/g, '$1')
  text = text.replace(/`([^`\n]+)`/g, '$1')
  // 分隔线
  text = text.replace(/^[-*_]{3,}\s*$/gm, '')
  // 折叠 3+ 空行
  text = text.replace(/\n{3,}/g, '\n\n')
  return text.trim()
}

export interface UnsupportedFeature {
  kind: 'fenced_code' | 'inline_code' | 'table' | 'html_tag' | 'footnote'
  label: string
  count: number
}

/** 扫描 X 文章编辑器不支持的 markdown 语法（粘贴后会丢格式/变纯文本）。 */
export function scanUnsupported(md: string): UnsupportedFeature[] {
  // HTML 注释（wms-illus 壳等）不算 HTML 标签
  const src = md.replace(/<!--[\s\S]*?-->/g, '')
  const out: UnsupportedFeature[] = []

  const fenceLines = src.match(/^```/gm)
  const fencedCount = fenceLines ? Math.floor(fenceLines.length / 2) : 0
  if (fencedCount > 0) out.push({ kind: 'fenced_code', label: '代码块', count: fencedCount })

  // 行内代码 / 表格 / HTML 标签在围栏代码块内不重复计
  const noFence = src.replace(/^```[^\n]*\n[\s\S]*?^```[ \t]*$/gm, '')

  const inline = noFence.match(/`[^`\n]+`/g)
  if (inline && inline.length > 0) {
    out.push({ kind: 'inline_code', label: '行内代码', count: inline.length })
  }

  // 表格按分隔行计数（|---|---| 形态）
  const tableSeps = noFence.match(/^\s*\|?[\s:|-]*-{2,}[\s:|-]*\|[\s:|-]*$/gm)
  if (tableSeps && tableSeps.length > 0) {
    out.push({ kind: 'table', label: '表格', count: tableSeps.length })
  }

  const htmlTags = noFence.match(/<\/?[a-zA-Z][^<>]*>/g)
  if (htmlTags && htmlTags.length > 0) {
    out.push({ kind: 'html_tag', label: 'HTML 标签', count: htmlTags.length })
  }

  const footnotes = noFence.match(/\[\^[^\]]+\]/g)
  if (footnotes && footnotes.length > 0) {
    out.push({ kind: 'footnote', label: '脚注', count: footnotes.length })
  }

  return out
}
