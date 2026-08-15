'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { Captions, Copy, LoaderCircle, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import {
  getYoutubeTranscript,
  type YoutubeTranscript,
  type YoutubeTranscriptSegment,
  type YoutubeVideo,
} from '@/lib/api/youtube'

export interface BilingualTranscriptGroup {
  original: YoutubeTranscriptSegment | null
  chinese: YoutubeTranscriptSegment[]
}

const BILINGUAL_ALIGNMENT_TOLERANCE_SECONDS = 1.5

function hasValidTimeRange(segment: YoutubeTranscriptSegment): boolean {
  return Number.isFinite(segment.start)
    && Number.isFinite(segment.end)
    && segment.start >= 0
    && segment.end >= segment.start
}

function segmentOverlap(
  first: YoutubeTranscriptSegment,
  second: YoutubeTranscriptSegment,
): number {
  return Math.max(0, Math.min(first.end, second.end) - Math.max(first.start, second.start))
}

function segmentDistance(
  first: YoutubeTranscriptSegment,
  second: YoutubeTranscriptSegment,
): number {
  if (segmentOverlap(first, second) > 0) return 0
  if (first.end <= second.start) return second.start - first.end
  return first.start - second.end
}

export function alignBilingualSegments(
  original: YoutubeTranscriptSegment[],
  chinese: YoutubeTranscriptSegment[],
  toleranceSeconds = BILINGUAL_ALIGNMENT_TOLERANCE_SECONDS,
): BilingualTranscriptGroup[] {
  const originalGroups: BilingualTranscriptGroup[] = original.map(segment => ({
    original: segment,
    chinese: [],
  }))
  const unmatched: Array<{ segment: YoutubeTranscriptSegment; order: number }> = []

  chinese.forEach((chineseSegment, order) => {
    if (!hasValidTimeRange(chineseSegment)) {
      unmatched.push({ segment: chineseSegment, order })
      return
    }

    let targetIndex = -1
    let largestOverlap = 0
    original.forEach((originalSegment, index) => {
      if (!hasValidTimeRange(originalSegment)) return
      const overlap = segmentOverlap(originalSegment, chineseSegment)
      if (overlap > largestOverlap) {
        largestOverlap = overlap
        targetIndex = index
      }
    })

    if (targetIndex < 0) {
      let shortestDistance = Number.POSITIVE_INFINITY
      original.forEach((originalSegment, index) => {
        if (!hasValidTimeRange(originalSegment)) return
        const distance = segmentDistance(originalSegment, chineseSegment)
        if (distance < shortestDistance) {
          shortestDistance = distance
          targetIndex = index
        }
      })
      if (shortestDistance > toleranceSeconds) targetIndex = -1
    }

    if (targetIndex >= 0) {
      originalGroups[targetIndex].chinese.push(chineseSegment)
    } else {
      unmatched.push({ segment: chineseSegment, order })
    }
  })

  return [
    ...originalGroups.map((group, order) => {
      const originalSegment = group.original
      return {
        group,
        time: originalSegment && hasValidTimeRange(originalSegment)
          ? originalSegment.start
          : Number.POSITIVE_INFINITY,
        order,
      }
    }),
    ...unmatched.map(({ segment, order }) => ({
      group: { original: null, chinese: [segment] },
      time: hasValidTimeRange(segment) ? segment.start : Number.POSITIVE_INFINITY,
      order: original.length + order,
    })),
  ]
    .sort((first, second) => first.time - second.time || first.order - second.order)
    .map(item => item.group)
}

export function formatBilingualTranscript(groups: BilingualTranscriptGroup[]): string {
  return groups
    .map(group => [
      group.original?.text.trim(),
      ...group.chinese.map(segment => segment.text.trim()),
    ].filter(Boolean).join('\n'))
    .filter(Boolean)
    .join('\n\n')
}

export function formatTranscriptTime(seconds: number): string {
  const wholeSeconds = Math.floor(Math.max(0, seconds))
  const minutes = Math.floor(wholeSeconds / 60)
  return `${String(minutes).padStart(2, '0')}:${String(wholeSeconds % 60).padStart(2, '0')}`
}

export function buildYoutubeTimestampUrl(videoUrl: string, seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds < 0) return null
  try {
    const url = new URL(videoUrl)
    const hostname = url.hostname.toLowerCase()
    const isYoutubeHost = ['youtu.be', 'youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(hostname)
    if (!['http:', 'https:'].includes(url.protocol) || !isYoutubeHost) return null
    url.searchParams.set('t', String(Math.floor(seconds)))
    return url.toString()
  } catch {
    return null
  }
}

export function YoutubeTranscriptDialog({ video }: { video: YoutubeVideo }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [transcript, setTranscript] = useState<YoutubeTranscript | null>(null)
  const [failed, setFailed] = useState(false)
  const [selectedVersion, setSelectedVersion] = useState<'original' | 'chinese' | 'bilingual'>('original')
  const requestIdRef = useRef(0)

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current
    setLoading(true)
    setFailed(false)
    try {
      const nextTranscript = await getYoutubeTranscript(video.id)
      if (requestId !== requestIdRef.current) return
      setTranscript(nextTranscript)
      setSelectedVersion('original')
    } catch {
      if (requestId !== requestIdRef.current) return
      setTranscript(null)
      setFailed(true)
    } finally {
      if (requestId === requestIdRef.current) setLoading(false)
    }
  }, [video.id])

  const bilingualGroups = useMemo(() => {
    if (!transcript?.chinese) return []
    return alignBilingualSegments(transcript.segments, transcript.chinese.segments)
  }, [transcript])
  const bilingualText = useMemo(
    () => formatBilingualTranscript(bilingualGroups),
    [bilingualGroups],
  )

  if (video.transcript_status !== 'ready') return null

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen)
    if (nextOpen) {
      void load()
    } else {
      requestIdRef.current += 1
      setLoading(false)
    }
  }

  async function copyTranscript() {
    if (!copyText.trim()) return
    try {
      await navigator.clipboard.writeText(copyText)
      toast.success('逐字稿已复制')
    } catch {
      toast.error('逐字稿复制失败')
    }
  }

  const currentTranscript = selectedVersion === 'chinese' && transcript?.chinese
    ? transcript.chinese
    : transcript
  const segments = selectedVersion === 'bilingual' ? [] : currentTranscript?.segments ?? []
  const copyText = selectedVersion === 'bilingual' ? bilingualText : currentTranscript?.text ?? ''
  const empty = currentTranscript !== null && !copyText.trim()
    && segments.length === 0
    && (selectedVersion !== 'bilingual' || bilingualGroups.length === 0)
  const transcriptDescription = selectedVersion === 'bilingual' && transcript?.chinese
    ? `${transcript.language || '未知语言'} / ${transcript.chinese.language || '未知语言'} · ${transcript.source || '未知来源'} / ${transcript.chinese.source || '未知来源'}`
    : `${currentTranscript?.language || '未知语言'} · ${currentTranscript?.source || '未知来源'}`
  const accessibilityStatus = loading
    ? '正在加载逐字稿'
    : failed
      ? '逐字稿加载失败'
      : transcript
        ? '逐字稿加载完成'
        : ''

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button variant="ghost" size="xs">
            <Captions data-icon="inline-start" />
            逐字稿
          </Button>
        }
      />
      <DialogContent
        size="lg"
        className="flex max-h-[min(86vh,820px)] min-h-[min(70vh,620px)] flex-col overflow-hidden"
      >
        <DialogHeader>
          <DialogTitle>{video.title}</DialogTitle>
          <DialogDescription>
            {transcriptDescription}
          </DialogDescription>
        </DialogHeader>

        {transcript?.chinese ? (
          <div className="flex w-fit rounded-lg bg-muted p-1" aria-label="逐字稿版本">
            <Button
              size="sm"
              variant={selectedVersion === 'original' ? 'default' : 'ghost'}
              aria-pressed={selectedVersion === 'original'}
              onClick={() => setSelectedVersion('original')}
            >
              原文
            </Button>
            <Button
              size="sm"
              variant={selectedVersion === 'chinese' ? 'default' : 'ghost'}
              aria-pressed={selectedVersion === 'chinese'}
              onClick={() => setSelectedVersion('chinese')}
            >
              中文
            </Button>
            <Button
              size="sm"
              variant={selectedVersion === 'bilingual' ? 'default' : 'ghost'}
              aria-pressed={selectedVersion === 'bilingual'}
              onClick={() => setSelectedVersion('bilingual')}
            >
              中英
            </Button>
          </div>
        ) : null}

        <p className="sr-only" role="status" aria-live="polite">
          {accessibilityStatus}
        </p>

        <div
          data-testid="transcript-scroll-region"
          className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border"
        >
          <div className="p-4">
            {loading ? (
              <Empty className="min-h-64 border-0">
                <EmptyMedia variant="icon">
                  <LoaderCircle className="animate-spin" />
                </EmptyMedia>
                <EmptyHeader>
                  <EmptyTitle>正在加载逐字稿</EmptyTitle>
                </EmptyHeader>
              </Empty>
            ) : failed ? (
              <Empty className="min-h-64 border-0">
                <EmptyMedia variant="icon"><RotateCcw /></EmptyMedia>
                <EmptyHeader>
                  <EmptyTitle>逐字稿加载失败</EmptyTitle>
                </EmptyHeader>
                <EmptyContent>
                  <Button variant="outline" onClick={() => void load()}>
                    <RotateCcw data-icon="inline-start" />
                    重新加载
                  </Button>
                </EmptyContent>
              </Empty>
            ) : empty ? (
              <Empty className="min-h-64 border-0">
                <EmptyMedia variant="icon"><Captions /></EmptyMedia>
                <EmptyHeader>
                  <EmptyTitle>逐字稿内容为空</EmptyTitle>
                </EmptyHeader>
              </Empty>
            ) : selectedVersion === 'bilingual' && bilingualGroups.length > 0 ? (
              <div className="flex flex-col gap-4">
                {bilingualGroups.map((group, index) => {
                  const primarySegment = group.original ?? group.chinese[0]
                  const href = buildYoutubeTimestampUrl(video.url, primarySegment.start)
                  const label = Number.isFinite(primarySegment.start) && primarySegment.start >= 0
                    ? formatTranscriptTime(primarySegment.start)
                    : '--:--'
                  return (
                    <div
                      key={`${primarySegment.start}-${index}`}
                      className="grid grid-cols-[3.5rem_1fr] gap-3"
                    >
                      {href ? (
                        <a
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs font-medium text-primary hover:underline"
                        >
                          {label}
                        </a>
                      ) : (
                        <span className="text-xs text-muted-foreground">{label}</span>
                      )}
                      <div className="min-w-0 space-y-1.5">
                        {group.original ? (
                          <p className="whitespace-pre-wrap leading-6">{group.original.text}</p>
                        ) : (
                          <span className="inline-flex rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                            仅中文
                          </span>
                        )}
                        {group.chinese.map((segment, chineseIndex) => (
                          <p
                            key={`${segment.start}-${chineseIndex}`}
                            className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground"
                          >
                            {segment.text}
                          </p>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : segments.length > 0 ? (
              <div className="flex flex-col gap-3">
                {segments.map((segment, index) => {
                  const href = buildYoutubeTimestampUrl(video.url, segment.start)
                  const label = Number.isFinite(segment.start) && segment.start >= 0
                    ? formatTranscriptTime(segment.start)
                    : '--:--'
                  return (
                    <div key={`${segment.start}-${index}`} className="grid grid-cols-[3.5rem_1fr] gap-3">
                      {href ? (
                        <a
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs font-medium text-primary hover:underline"
                        >
                          {label}
                        </a>
                      ) : (
                        <span className="text-xs text-muted-foreground">{label}</span>
                      )}
                      <p className="whitespace-pre-wrap leading-6">{segment.text}</p>
                    </div>
                  )
                })}
              </div>
            ) : currentTranscript?.text ? (
              <p className="whitespace-pre-wrap leading-7">{currentTranscript.text}</p>
            ) : null}
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            disabled={!copyText.trim()}
            onClick={() => void copyTranscript()}
          >
            <Copy data-icon="inline-start" />
            复制全文
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
