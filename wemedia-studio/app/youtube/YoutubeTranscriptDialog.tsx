'use client'

import { useCallback, useState } from 'react'
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
import { ScrollArea } from '@/components/ui/scroll-area'
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

  const load = useCallback(async () => {
    setLoading(true)
    setFailed(false)
    try {
      setTranscript(await getYoutubeTranscript(video.id))
    } catch {
      setTranscript(null)
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [video.id])

  if (video.transcript_status !== 'ready') return null

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen)
    if (nextOpen) void load()
  }

  async function copyTranscript() {
    if (!transcript?.text) return
    try {
      await navigator.clipboard.writeText(transcript.text)
      toast.success('逐字稿已复制')
    } catch {
      toast.error('逐字稿复制失败')
    }
  }

  const segments = transcript?.segments ?? []
  const empty = transcript !== null && !transcript.text.trim() && segments.length === 0

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
            {transcript?.language || '未知语言'} · {transcript?.source || '未知来源'}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="min-h-0 flex-1 rounded-lg border border-border">
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
            ) : transcript?.text ? (
              <p className="whitespace-pre-wrap leading-7">{transcript.text}</p>
            ) : null}
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button
            variant="outline"
            disabled={!transcript?.text}
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
