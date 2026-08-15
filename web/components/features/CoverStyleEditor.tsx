'use client'

import { Field, FieldLabel } from '@/components/ui/field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import type { CoverStyle } from '@/lib/api/publish-accounts'

export const COVER_TYPE_OPTS      = ['', 'hero', 'conceptual', 'typography', 'metaphor', 'scene', 'minimal']
export const COVER_PALETTE_OPTS   = ['', 'warm', 'elegant', 'cool', 'dark', 'earth', 'vivid', 'pastel', 'mono', 'retro', 'duotone', 'macaron']
export const COVER_RENDERING_OPTS = ['', 'flat-vector', 'hand-drawn', 'painterly', 'digital', 'pixel', 'chalk', 'screen-print']
export const COVER_TEXT_OPTS      = ['', 'none', 'title-only', 'title-subtitle', 'text-rich']
export const COVER_MOOD_OPTS      = ['', 'subtle', 'balanced', 'bold']
export const COVER_RATIO_OPTS     = ['', '16:9', '5:2', '1:1', '2.35:1', '3:4', '4:3', '9:16']

const UNSET_COVER_STYLE_VALUE = '__cover_style_unset__'

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
  { id: 'cover-style-type', key: 'type', label: '类型 type', opts: COVER_TYPE_OPTS },
  { id: 'cover-style-palette', key: 'palette', label: '配色 palette', opts: COVER_PALETTE_OPTS },
  { id: 'cover-style-rendering', key: 'rendering', label: '渲染 rendering', opts: COVER_RENDERING_OPTS },
  { id: 'cover-style-text', key: 'text', label: '文字 text', opts: COVER_TEXT_OPTS },
  { id: 'cover-style-mood', key: 'mood', label: '气氛 mood', opts: COVER_MOOD_OPTS },
  { id: 'cover-style-aspect-ratio', key: 'aspect_ratio', label: '长宽比 aspect', opts: COVER_RATIO_OPTS },
] as const

export function CoverStyleEditor({
  coverStyle, onCoverStyleChange,
  motifsText, onMotifsTextChange,
  negativeText, onNegativeTextChange,
}: CoverStyleEditorProps) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        {DIMS.map(({ id, key, label, opts }) => (
          <Field key={key}>
            <FieldLabel htmlFor={id}>{label}</FieldLabel>
            <Select
              value={coverStyle[key] || UNSET_COVER_STYLE_VALUE}
              onValueChange={value => onCoverStyleChange({
                ...coverStyle,
                [key]: value === UNSET_COVER_STYLE_VALUE ? '' : value ?? '',
              })}
            >
              <SelectTrigger id={id} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {opts.map(option => (
                    <SelectItem
                      key={option || UNSET_COVER_STYLE_VALUE}
                      value={option || UNSET_COVER_STYLE_VALUE}
                    >
                      {option || '(未设)'}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        ))}
      </div>

      <Field>
        <FieldLabel htmlFor="cover-style-signature-motifs">视觉签名（signature_motifs，一行一个）</FieldLabel>
        <Textarea
          id="cover-style-signature-motifs"
          value={motifsText}
          onChange={e => onMotifsTextChange(e.target.value)}
          placeholder={'always include a small purple chunky lobster icon in lower-right corner\nthin 1px grid background, very subtle'}
          rows={3}
          className="resize-none"
        />
      </Field>

      <Field>
        <FieldLabel htmlFor="cover-style-negative">禁止元素（negative，一行一个）</FieldLabel>
        <Textarea
          id="cover-style-negative"
          value={negativeText}
          onChange={e => onNegativeTextChange(e.target.value)}
          placeholder={'no realistic humans\nno stock photo feel'}
          rows={2}
          className="resize-none"
        />
      </Field>
    </div>
  )
}
