import type { CSSProperties, ReactNode } from 'react'
import { Lexer, type Token, type Tokens } from 'marked'

function safeHref(href: string) {
  try {
    const url = new URL(href, 'https://ediora.local')
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) || href.startsWith('/') || href.startsWith('#')
      ? href
      : null
  } catch {
    return null
  }
}

function inline(tokens: Token[]): ReactNode[] {
  return tokens.map((token, index) => <span key={`${token.type}-${index}`}>{renderInline(token)}</span>)
}

function nestedTokens(token: Token) {
  return 'tokens' in token && Array.isArray(token.tokens) ? token.tokens : []
}

function renderInline(token: Token): ReactNode {
  switch (token.type) {
    case 'strong':
      return <strong className="font-semibold">{inline(nestedTokens(token))}</strong>
    case 'em':
      return <em>{inline(nestedTokens(token))}</em>
    case 'del':
      return <del>{inline(nestedTokens(token))}</del>
    case 'codespan':
      return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground">{token.text}</code>
    case 'link': {
      const href = safeHref(token.href)
      return href
        ? <a className="text-indigo-600 underline underline-offset-2 hover:text-indigo-500 dark:text-indigo-400" href={href} target="_blank" rel="noreferrer">{inline(nestedTokens(token))}</a>
        : <>{inline(nestedTokens(token))}</>
    }
    case 'image':
      return <span>{token.text}</span>
    case 'br':
      return <br />
    case 'html':
      return <>{token.raw}</>
    case 'text':
      return nestedTokens(token).length > 0 ? <>{inline(nestedTokens(token))}</> : token.text
    default:
      return 'text' in token ? String(token.text) : token.raw
  }
}

function renderListItem(item: Tokens.ListItem, index: number) {
  return <li key={`${item.raw}-${index}`} className="pl-1">{blocks(item.tokens)}</li>
}

function textAlign(align: Tokens.TableCell['align']): CSSProperties['textAlign'] {
  return align ?? undefined
}

function renderBlock(token: Token, index: number): ReactNode {
  switch (token.type) {
    case 'space':
      return null
    case 'heading': {
      const Tag = `h${Math.min((token as Tokens.Heading).depth, 6)}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
      return <Tag key={`${token.raw}-${index}`} className="mt-4 mb-2 font-semibold first:mt-0 [&:is(h1)]:text-xl [&:is(h2)]:text-lg [&:is(h3)]:text-base">{inline(nestedTokens(token))}</Tag>
    }
    case 'paragraph':
      return <p key={`${token.raw}-${index}`} className="my-2 first:mt-0 last:mb-0">{inline(nestedTokens(token))}</p>
    case 'blockquote':
      return <blockquote key={`${token.raw}-${index}`} className="my-3 border-l-2 border-indigo-300 pl-3 text-muted-foreground dark:border-indigo-700">{blocks(nestedTokens(token))}</blockquote>
    case 'code':
      return <pre key={`${token.raw}-${index}`} className="my-3 overflow-x-auto rounded-lg bg-zinc-950 p-3 text-xs leading-5 text-zinc-100"><code>{token.text}</code></pre>
    case 'list': {
      const List = token.ordered ? 'ol' : 'ul'
      return <List key={`${token.raw}-${index}`} className={token.ordered ? 'my-2 list-decimal space-y-1 pl-5' : 'my-2 list-disc space-y-1 pl-5'} start={token.ordered && typeof token.start === 'number' ? token.start : undefined}>{token.items.map(renderListItem)}</List>
    }
    case 'table': {
      const table = token as Tokens.Table
      return <div key={`${token.raw}-${index}`} className="my-3 overflow-x-auto"><table className="w-full border-collapse text-left text-xs"><thead><tr>{table.header.map((cell, cellIndex) => <th key={cellIndex} className="border border-border bg-surface-muted px-2 py-1.5 font-semibold" style={{ textAlign: textAlign(cell.align) }}>{inline(cell.tokens)}</th>)}</tr></thead><tbody>{table.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} className="border border-border px-2 py-1.5 align-top" style={{ textAlign: textAlign(cell.align) }}>{inline(cell.tokens)}</td>)}</tr>)}</tbody></table></div>
    }
    case 'hr':
      return <hr key={`${token.raw}-${index}`} className="my-4 border-border" />
    case 'html':
      return <p key={`${token.raw}-${index}`} className="my-2 whitespace-pre-wrap">{token.raw}</p>
    default:
      return <p key={`${token.raw}-${index}`} className="my-2">{renderInline(token)}</p>
  }
}

function blocks(tokens: Token[]) {
  return tokens.map(renderBlock)
}

export function ChatMarkdown({ content }: { content: string }) {
  return <div className="chat-markdown break-words">{blocks(Lexer.lex(content, { gfm: true, breaks: true }))}</div>
}
