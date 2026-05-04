import { Star } from 'lucide-react'
import { cn } from '@/lib/utils'

export function ScoreStars({ score }: { score: number }) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map(i => (
        <Star
          key={i}
          className={cn(
            'w-3 h-3',
            i <= Math.round(score)
              ? 'fill-amber-400 text-amber-400'
              : 'fill-zinc-200 text-zinc-200 dark:fill-zinc-700 dark:text-zinc-700'
          )}
        />
      ))}
      <span className="ml-1 text-xs text-zinc-500 tabular-nums">{score.toFixed(1)}</span>
    </div>
  )
}
