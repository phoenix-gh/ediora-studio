# YouTube Transcript Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an on-demand transcript dialog to ready YouTube video cards without changing transcript extraction or analysis behavior.

**Architecture:** Keep full transcript bodies out of the video-list response. Add a typed frontend API reader for the existing transcript endpoint, then encapsulate the ready-only trigger, loading state, timestamp rendering, text fallback, retry-view action, and clipboard behavior in a focused `YoutubeTranscriptDialog` component that `VideoCard` consumes.

**Tech Stack:** Next.js 16, React 19, TypeScript, shadcn Dialog/Button, Sonner, Vitest, Testing Library, existing `apiFetch` client.

## Global Constraints

- Reuse `GET /api/youtube/videos/{video_id}/transcript`; do not modify backend routes, persistence, extraction, Whisper fallback, Cookie, proxy, or transcription settings.
- Show the “逐字稿” entry only when `transcript_status === "ready"`.
- Load the full transcript only after the dialog opens; do not add transcript text or segments to the list DTO.
- Render timestamped segments when available and plain `text` when segments are absent.
- Preserve existing YouTube query parameters when adding `t=<floor(non-negative seconds)>`.
- Do not add transcript retry jobs, polling, translation, search, editing, or file downloads.
- Preserve all unrelated existing working-tree changes and run only focused frontend verification plus necessary scoped regressions.

---

### Task 1: Add the typed transcript API contract

**Files:**
- Create: `web/lib/api/youtube.test.ts`
- Modify: `web/lib/api/youtube.ts`

**Interfaces:**
- Consumes: existing `apiFetch<T>(path, init?)` from `web/lib/api/client.ts`.
- Produces: `YoutubeTranscriptSegment`, `YoutubeTranscript`, and `getYoutubeTranscript(videoId: string): Promise<YoutubeTranscript>`.

- [ ] **Step 1: Write the failing API test**

Create `web/lib/api/youtube.test.ts` with a fetch-backed contract test:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getYoutubeTranscript } from './youtube'

describe('getYoutubeTranscript', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('loads the complete transcript only from the selected video endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'ready',
      source: 'manual',
      language: 'zh-Hans',
      text: '第一段 第二段',
      segments: [
        { start: 0.4, end: 2.1, text: '第一段' },
        { start: 2.1, end: 4.8, text: '第二段' },
      ],
      content_hash: 'hash-1',
      fetched_at: '2026-08-11T02:00:00Z',
      error_code: '',
      error: '',
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const transcript = await getYoutubeTranscript('video/id')

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/api/youtube/videos/video%2Fid/transcript',
      expect.objectContaining({
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    expect(transcript.segments[1]).toEqual({ start: 2.1, end: 4.8, text: '第二段' })
  })
})
```

- [ ] **Step 2: Run the API test and verify RED**

Run:

```bash
cd web
pnpm test -- lib/api/youtube.test.ts
```

Expected: FAIL because `getYoutubeTranscript` is not exported.

- [ ] **Step 3: Add the minimal response types and reader**

Append to `web/lib/api/youtube.ts`:

```ts
export interface YoutubeTranscriptSegment {
  start: number
  end: number
  text: string
}

export interface YoutubeTranscript {
  status: string
  source: string
  language: string
  text: string
  segments: YoutubeTranscriptSegment[]
  content_hash: string
  fetched_at: string | null
  error_code: string
  error: string
}

export async function getYoutubeTranscript(id: string): Promise<YoutubeTranscript> {
  return apiFetch<YoutubeTranscript>(`/youtube/videos/${encodeURIComponent(id)}/transcript`)
}
```

- [ ] **Step 4: Run the API test and verify GREEN**

Run:

```bash
cd web
pnpm test -- lib/api/youtube.test.ts
```

Expected: PASS with one test and no warnings.

- [ ] **Step 5: Commit the API contract**

```bash
git add web/lib/api/youtube.ts web/lib/api/youtube.test.ts
git commit -m "feat: add youtube transcript client"
```

---

### Task 2: Build the ready-only transcript dialog

**Files:**
- Create: `web/app/youtube/YoutubeTranscriptDialog.tsx`
- Create: `web/app/youtube/YoutubeTranscriptDialog.test.tsx`

**Interfaces:**
- Consumes: `YoutubeVideo`, `YoutubeTranscript`, and `getYoutubeTranscript(videoId)` from `@/lib/api/youtube`.
- Produces: `YoutubeTranscriptDialog({ video }: { video: YoutubeVideo })`, `formatTranscriptTime(seconds: number): string`, and `buildYoutubeTimestampUrl(videoUrl: string, seconds: number): string | null`.

- [ ] **Step 1: Write failing helper and component tests**

Create `YoutubeTranscriptDialog.test.tsx` with literal fixtures and mocked network boundary:

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getYoutubeTranscript, type YoutubeVideo } from '@/lib/api/youtube'
import {
  buildYoutubeTimestampUrl,
  formatTranscriptTime,
  YoutubeTranscriptDialog,
} from './YoutubeTranscriptDialog'

vi.mock('@/lib/api/youtube', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api/youtube')>()
  return { ...actual, getYoutubeTranscript: vi.fn() }
})

const video: YoutubeVideo = {
  id: 'video-1', channel_id: 'channel-1', channel_name: '频道', title: '测试视频',
  url: 'https://www.youtube.com/watch?v=video-1&list=abc', thumbnail_url: '',
  description: '', views: 1, published_at: '2026-08-10T00:00:00Z',
  updated_at: '2026-08-10T00:00:00Z', collected_at: '2026-08-10T00:00:00Z',
  transcript_status: 'ready', transcript_source: 'manual', transcript_language: 'zh-Hans',
  transcript_error_code: '', transcript_error: '', response_item_id: null, analysis_status: null,
}

describe('YoutubeTranscriptDialog', () => {
  beforeEach(() => vi.clearAllMocks())

  it('formats timestamps and preserves existing YouTube query parameters', () => {
    expect(formatTranscriptTime(65.9)).toBe('01:05')
    expect(buildYoutubeTimestampUrl(video.url, 65.9)).toBe(
      'https://www.youtube.com/watch?v=video-1&list=abc&t=65',
    )
    expect(buildYoutubeTimestampUrl(video.url, -1)).toBeNull()
  })

  it('loads on open, renders timestamped segments, and copies the full text', async () => {
    vi.mocked(getYoutubeTranscript).mockResolvedValue({
      status: 'ready', source: 'manual', language: 'zh-Hans', text: '第一段\n第二段',
      segments: [{ start: 0, end: 2, text: '第一段' }, { start: 65.9, end: 70, text: '第二段' }],
      content_hash: 'hash', fetched_at: '2026-08-11T02:00:00Z', error_code: '', error: '',
    })
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const user = userEvent.setup()
    render(<YoutubeTranscriptDialog video={video} />)

    expect(getYoutubeTranscript).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '逐字稿' }))
    expect(await screen.findByRole('dialog')).toHaveTextContent('测试视频')
    expect(screen.getByRole('link', { name: '01:05' })).toHaveAttribute(
      'href', 'https://www.youtube.com/watch?v=video-1&list=abc&t=65',
    )
    await user.click(screen.getByRole('button', { name: '复制全文' }))
    expect(writeText).toHaveBeenCalledWith('第一段\n第二段')
  })

  it('falls back to the complete plain text when segments are absent', async () => {
    vi.mocked(getYoutubeTranscript).mockResolvedValue({
      status: 'ready', source: '', language: '', text: '纯文本逐字稿', segments: [],
      content_hash: '', fetched_at: null, error_code: '', error: '',
    })
    const user = userEvent.setup()
    render(<YoutubeTranscriptDialog video={video} />)
    await user.click(screen.getByRole('button', { name: '逐字稿' }))
    expect(await screen.findByText('纯文本逐字稿')).toBeInTheDocument()
  })

  it('reports failed loads and retries the same video', async () => {
    vi.mocked(getYoutubeTranscript)
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({
        status: 'ready', source: 'manual', language: 'zh-Hans', text: '重试成功', segments: [],
        content_hash: '', fetched_at: null, error_code: '', error: '',
      })
    const user = userEvent.setup()
    render(<YoutubeTranscriptDialog video={{ ...video, id: 'video-2' }} />)
    await user.click(screen.getByRole('button', { name: '逐字稿' }))
    expect(await screen.findByText('逐字稿加载失败')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '重新加载' }))
    expect(await screen.findByText('重试成功')).toBeInTheDocument()
    expect(getYoutubeTranscript).toHaveBeenNthCalledWith(2, 'video-2')
  })

  it('does not expose the viewer before a transcript is ready', () => {
    render(<YoutubeTranscriptDialog video={{ ...video, transcript_status: 'failed' }} />)
    expect(screen.queryByRole('button', { name: '逐字稿' })).not.toBeInTheDocument()
  })

  it('shows an explicit empty state for a ready transcript without content', async () => {
    vi.mocked(getYoutubeTranscript).mockResolvedValue({
      status: 'ready', source: '', language: '', text: '', segments: [],
      content_hash: '', fetched_at: null, error_code: '', error: '',
    })
    const user = userEvent.setup()
    render(<YoutubeTranscriptDialog video={video} />)
    await user.click(screen.getByRole('button', { name: '逐字稿' }))
    expect(await screen.findByText('逐字稿内容为空')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the component test and verify RED**

Run:

```bash
cd web
pnpm test -- app/youtube/YoutubeTranscriptDialog.test.tsx
```

Expected: FAIL because `YoutubeTranscriptDialog.tsx` does not exist.

- [ ] **Step 3: Implement timestamp helpers and the dialog**

Create `YoutubeTranscriptDialog.tsx` with these implementation boundaries:

```tsx
'use client'

import { useCallback, useState } from 'react'
import { Captions, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { getYoutubeTranscript, type YoutubeTranscript, type YoutubeVideo } from '@/lib/api/youtube'

export function formatTranscriptTime(seconds: number): string {
  const whole = Math.floor(Math.max(0, seconds))
  const minutes = Math.floor(whole / 60)
  return `${String(minutes).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`
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
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-[11px]"
        onClick={() => handleOpenChange(true)}
      >
        <Captions className="size-3" />
        逐字稿
      </Button>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent size="lg" className="flex max-h-[min(86vh,820px)] flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>{video.title}</DialogTitle>
            <DialogDescription>
              {transcript?.language || '未知语言'} · {transcript?.source || '未知来源'}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border p-4">
            {loading && <div className="flex justify-center py-12"><Loader2 className="animate-spin" /></div>}
            {!loading && failed && (
              <div className="flex flex-col items-center gap-3 py-12">
                <p>逐字稿加载失败</p>
                <Button variant="outline" onClick={() => void load()}>重新加载</Button>
              </div>
            )}
            {!loading && !failed && empty && <p className="py-12 text-center text-muted-foreground">逐字稿内容为空</p>}
            {!loading && !failed && segments.length > 0 && (
              <div className="space-y-3">
                {segments.map((segment, index) => {
                  const href = buildYoutubeTimestampUrl(video.url, segment.start)
                  const label = Number.isFinite(segment.start) && segment.start >= 0
                    ? formatTranscriptTime(segment.start)
                    : '--:--'
                  return (
                    <div key={`${segment.start}-${index}`} className="grid grid-cols-[3.5rem_1fr] gap-3">
                      {href ? <a href={href} target="_blank" rel="noopener noreferrer">{label}</a> : <span>{label}</span>}
                      <p className="whitespace-pre-wrap">{segment.text}</p>
                    </div>
                  )
                })}
              </div>
            )}
            {!loading && !failed && segments.length === 0 && transcript?.text && (
              <p className="whitespace-pre-wrap leading-7">{transcript.text}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={!transcript?.text} onClick={() => void copyTranscript()}>
              复制全文
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
```

Segment links use `target="_blank"` and `rel="noopener noreferrer"`; invalid timestamps render a non-link time label so segment text is never dropped.

- [ ] **Step 4: Run the component test and verify GREEN**

Run:

```bash
cd web
pnpm test -- app/youtube/YoutubeTranscriptDialog.test.tsx
```

Expected: PASS for ready-only visibility, lazy loading, timestamp links, plain-text fallback, empty state, failed load/reload, and clipboard behavior.

- [ ] **Step 5: Run mutation checks for the dialog contract**

Temporarily remove the `ready` guard and confirm the failed-status test fails; restore it. Temporarily remove the `t` parameter assignment and confirm the timestamp URL test fails; restore it. Re-run the focused test and confirm GREEN.

- [ ] **Step 6: Commit the transcript dialog**

```bash
git add web/app/youtube/YoutubeTranscriptDialog.tsx web/app/youtube/YoutubeTranscriptDialog.test.tsx
git commit -m "feat: add youtube transcript dialog"
```

---

### Task 3: Wire the dialog into video cards and verify the feature

**Files:**
- Modify: `web/app/youtube/YoutubeClient.tsx:1-18`
- Modify: `web/app/youtube/YoutubeClient.tsx:358-463`
- Create: `web/app/youtube/YoutubeClient.test.tsx`

**Interfaces:**
- Consumes: `YoutubeTranscriptDialog({ video })` from Task 2.
- Produces: a ready-only “逐字稿” action in every `VideoCard` without changing existing analysis and topic actions.

- [ ] **Step 1: Write the failing integration assertion**

Create `YoutubeClient.test.tsx`. Mock only the focused transcript child and infinite-scroll browser boundary, then render the real parent and card:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { YoutubeVideo } from '@/lib/api/youtube'
import { YoutubeClient } from './YoutubeClient'

vi.mock('./YoutubeTranscriptDialog', () => ({
  YoutubeTranscriptDialog: ({ video }: { video: YoutubeVideo }) => (
    <button type="button">逐字稿:{video.id}</button>
  ),
}))

vi.mock('@/lib/use-infinite-scroll', () => ({
  useInfiniteScroll: ({ totalCount }: { totalCount: number }) => ({
    visibleCount: totalCount,
    sentinelRef: { current: null },
    hasMore: false,
    reset: vi.fn(),
  }),
}))

const video: YoutubeVideo = {
  id: 'ready-video', channel_id: 'channel-1', channel_name: '频道', title: '测试视频',
  url: 'https://www.youtube.com/watch?v=ready-video', thumbnail_url: '', description: '',
  views: 0, published_at: '2026-08-10T00:00:00Z', updated_at: '2026-08-10T00:00:00Z',
  collected_at: '2026-08-10T00:00:00Z', transcript_status: 'ready', transcript_source: 'manual',
  transcript_language: 'zh-Hans', transcript_error_code: '', transcript_error: '',
  response_item_id: null, analysis_status: null,
}

describe('YoutubeClient transcript integration', () => {
  it('keeps the transcript trigger beside the existing analysis action', () => {
    render(<YoutubeClient initialChannels={[]} initialVideos={[video]} />)

    expect(screen.getByRole('button', { name: '逐字稿:ready-video' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '提取字幕并分析' })).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the integration test and verify RED**

Run the exact test file selected in Step 1:

```bash
cd web
pnpm test -- app/youtube/YoutubeClient.test.tsx
```

Expected: FAIL because `VideoCard` does not render the transcript dialog trigger.

- [ ] **Step 3: Add the card integration**

Import the focused component:

```tsx
import { YoutubeTranscriptDialog } from './YoutubeTranscriptDialog'
```

Inside the existing video-card action container, render it before `AddToTopicPopover`:

```tsx
<YoutubeTranscriptDialog video={video} />
```

Do not alter the existing `查看分析`, `重新分析`, `提取字幕并分析`, or topic-popover branches.

- [ ] **Step 4: Run focused YouTube tests and verify GREEN**

Run:

```bash
cd web
pnpm test -- lib/api/youtube.test.ts app/youtube/YoutubeTranscriptDialog.test.tsx app/youtube/YoutubeClient.test.tsx
```

Expected: all selected files PASS with zero failed tests.

- [ ] **Step 5: Run scoped static verification**

Run:

```bash
cd web
pnpm exec eslint lib/api/youtube.ts lib/api/youtube.test.ts app/youtube/YoutubeClient.tsx app/youtube/YoutubeTranscriptDialog.tsx app/youtube/YoutubeTranscriptDialog.test.tsx app/youtube/YoutubeClient.test.tsx
cd ..
git diff --check -- web/lib/api/youtube.ts web/lib/api/youtube.test.ts web/app/youtube/YoutubeClient.tsx web/app/youtube/YoutubeTranscriptDialog.tsx web/app/youtube/YoutubeTranscriptDialog.test.tsx web/app/youtube/YoutubeClient.test.tsx
```

Expected: ESLint exits 0 with no new errors; `git diff --check` prints nothing.

- [ ] **Step 6: Perform browser acceptance**

Start the existing frontend/backend development environment, open `/youtube`, and verify:

1. A video with `transcript_status=ready` shows “逐字稿”; a failed or unrequested video does not.
2. Opening the dialog issues the transcript request only then.
3. A segment timestamp opens the same YouTube video with the existing query parameters plus `t`.
4. Short text remains readable without stretching the card; long text scrolls inside the dialog.
5. “复制全文” copies the exact API `text` value.
6. Closing the dialog preserves selected channel, search, date range, and loaded video list.

If no stored ready video is available, use the component tests as the controlled transcript fixture and explicitly report that live browser data was unavailable rather than claiming live acceptance.

- [ ] **Step 7: Commit the integration**

```bash
git add web/app/youtube/YoutubeClient.tsx web/app/youtube/YoutubeClient.test.tsx
git commit -m "feat: show transcripts on youtube videos"
```
