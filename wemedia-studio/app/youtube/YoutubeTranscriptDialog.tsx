'use client'

import { useCallback, useRef, useState } from 'react'
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
  type YoutubeVideo,
} from '@/lib/api/youtube'

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
  const [selectedVersion, setSelectedVersion] = useState<'original' | 'chinese'>('original')
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
    if (!currentTranscript?.text.trim()) return
    try {
      await navigator.clipboard.writeText(currentTranscript.text)
      toast.success('逐字稿已复制')
    } catch {
      toast.error('逐字稿复制失败')
    }
  }

  const currentTranscript = selectedVersion === 'chinese' && transcript?.chinese
    ? transcript.chinese
    : transcript
  const segments = currentTranscript?.segments ?? []
  const empty = currentTranscript !== null && !currentTranscript?.text.trim() && segments.length === 0
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
            {currentTranscript?.language || '未知语言'} · {currentTranscript?.source || '未知来源'}
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
            disabled={!currentTranscript?.text.trim()}
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
