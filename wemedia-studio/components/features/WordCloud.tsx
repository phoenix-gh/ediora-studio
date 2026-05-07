'use client'

import { cn } from '@/lib/utils'

export interface WordCloudItem {
  term: string
  weight: number  // 0-100
}

interface WordCloudProps {
  words: WordCloudItem[]
  className?: string
}

const PALETTE = [
  'text-indigo-600 dark:text-indigo-400',
  'text-rose-500 dark:text-rose-400',
  'text-amber-500 dark:text-amber-400',
  'text-emerald-600 dark:text-emerald-400',
  'text-sky-500 dark:text-sky-400',
  'text-violet-500 dark:text-violet-400',
  'text-orange-500 dark:text-orange-400',
  'text-teal-500 dark:text-teal-400',
]

function wordFontSize(weight: number): string {
  if (weight >= 85) return 'text-lg font-bold'
  if (weight >= 70) return 'text-base font-semibold'
  if (weight >= 50) return 'text-sm font-medium'
  if (weight >= 30) return 'text-xs font-normal'
  return 'text-[11px] font-normal text-zinc-400 dark:text-zinc-600'
}

export function WordCloud({ words, className }: WordCloudProps) {
  if (!words.length) {
    return (
      <div className={cn('flex items-center justify-center text-xs text-zinc-400 py-6', className)}>
        暂无数据
      </div>
    )
  }

  return (
    <div className={cn('flex flex-wrap gap-x-3 gap-y-2 leading-relaxed', className)}>
      {words.map((w, i) => (
        <span
          key={w.term}
          className={cn(
            wordFontSize(w.weight),
            w.weight >= 30 ? PALETTE[i % PALETTE.length] : '',
            'cursor-default select-none transition-opacity hover:opacity-70',
          )}
          title={`${w.term} · 权重 ${w.weight}`}
        >
          {w.term}
        </span>
      ))}
    </div>
  )
}
