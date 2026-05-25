'use client'

import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { CoverStyle } from '@/lib/api/publish-accounts'

export const COVER_TYPE_OPTS      = ['', 'hero', 'conceptual', 'typography', 'metaphor', 'scene', 'minimal']
export const COVER_PALETTE_OPTS   = ['', 'warm', 'elegant', 'cool', 'dark', 'earth', 'vivid', 'pastel', 'mono', 'retro', 'duotone', 'macaron']
export const COVER_RENDERING_OPTS = ['', 'flat-vector', 'hand-drawn', 'painterly', 'digital', 'pixel', 'chalk', 'screen-print']
export const COVER_TEXT_OPTS      = ['', 'none', 'title-only', 'title-subtitle', 'text-rich']
export const COVER_MOOD_OPTS      = ['', 'subtle', 'balanced', 'bold']
export const COVER_RATIO_OPTS     = ['', '16:9', '5:2', '1:1', '2.35:1', '3:4', '4:3', '9:16']

export interface CoverStyleEditorProps {
  coverStyle: CoverStyle
  onCoverStyleChange: (cs: CoverStyle) => void
  motifsText: string
  onMotifsTextChange: (t: string) => void
  negativeText: string
  onNegativeTextChange: (t: string) => void
}

export function buildCoverStyleFromEditor(
  coverStyle: CoverStyle,
  motifsText: string,
  negativeText: string,
): CoverStyle {
  const cs: CoverStyle = {}
  const dims: (keyof CoverStyle)[] = ['type', 'palette', 'rendering', 'text', 'mood', 'aspect_ratio']
  for (const k of dims) {
    const v = coverStyle[k]
    if (typeof v === 'string' && v.trim()) (cs as Record<string, unknown>)[k] = v.trim()
  }
  const motifs = motifsText.split('\n').map(s => s.trim()).filter(Boolean)
  if (motifs.length) cs.signature_motifs = motifs
  const neg = negativeText.split('\n').map(s => s.trim()).filter(Boolean)
  if (neg.length) cs.negative = neg
  return cs
}

const DIMS = [
  { key: 'type',         label: '类型 type',       opts: COVER_TYPE_OPTS      },
  { key: 'palette',      label: '配色 palette',     opts: COVER_PALETTE_OPTS   },
  { key: 'rendering',    label: '渲染 rendering',   opts: COVER_RENDERING_OPTS },
  { key: 'text',         label: '文字 text',        opts: COVER_TEXT_OPTS      },
  { key: 'mood',         label: '气氛 mood',        opts: COVER_MOOD_OPTS      },
  { key: 'aspect_ratio', label: '长宽比 aspect',    opts: COVER_RATIO_OPTS     },
] as const

export function CoverStyleEditor({
  coverStyle, onCoverStyleChange,
  motifsText, onMotifsTextChange,
  negativeText, onNegativeTextChange,
}: CoverStyleEditorProps) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        {DIMS.map(({ key, label, opts }) => (
          <div key={key} className="space-y-1">
            <Label className="text-xs">{label}</Label>
            <select
              value={coverStyle[key] ?? ''}
              onChange={e => onCoverStyleChange({ ...coverStyle, [key]: e.target.value })}
              className="h-8 w-full rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 text-sm"
            >
              {opts.map(o => (
                <option key={o} value={o}>{o || '(未设)'}</option>
              ))}
            </select>
          </div>
        ))}
      </div>

      <div className="space-y-1">
        <Label className="text-xs">视觉签名（signature_motifs，一行一个）</Label>
        <textarea
          value={motifsText}
          onChange={e => onMotifsTextChange(e.target.value)}
          placeholder={'always include a small purple chunky lobster icon in lower-right corner\nthin 1px grid background, very subtle'}
          rows={3}
          className={cn(
            'w-full resize-none rounded-lg border border-zinc-200 dark:border-zinc-700',
            'bg-white dark:bg-zinc-800 px-3 py-2 text-sm',
            'focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400',
          )}
        />
      </div>

      <div className="space-y-1">
        <Label className="text-xs">禁止元素（negative，一行一个）</Label>
        <textarea
          value={negativeText}
          onChange={e => onNegativeTextChange(e.target.value)}
          placeholder={'no realistic humans\nno stock photo feel'}
          rows={2}
          className={cn(
            'w-full resize-none rounded-lg border border-zinc-200 dark:border-zinc-700',
            'bg-white dark:bg-zinc-800 px-3 py-2 text-sm',
            'focus:outline-none focus:ring-2 focus:ring-red-500/20 focus:border-red-400',
          )}
        />
      </div>
    </div>
  )
}
