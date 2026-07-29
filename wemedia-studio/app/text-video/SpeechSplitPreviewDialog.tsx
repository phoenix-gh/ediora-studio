'use client'

import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { getJob, type ContentJob } from '@/lib/api/jobs'
import { createSpeechSplitPreview, type SpeechSplitPreviewResponse, type SpeechSplitProposal, type TextVideoProject } from '@/lib/api/text-videos'
import { applySpeechSplitProposal } from '@/lib/text-video/speech-segments'


type PreviewCreator = (projectId: number, input: { revision: number; direction: string }) => Promise<SpeechSplitPreviewResponse>
type JobReader = (jobId: number) => Promise<ContentJob>

function readProposal(job: ContentJob): SpeechSplitProposal | null {
  const step = job.steps
    .filter(item => item.key === 'propose_boundaries' && item.status === 'succeeded')
    .sort((left, right) => right.attempt - left.attempt)[0]
  if (!step) return null
  const output = step.output as Partial<SpeechSplitProposal>
  return output.speech_split_mode === 'auto' && Array.isArray(output.segments)
    ? output as SpeechSplitProposal
    : null
}

function failedJobMessage(job: ContentJob): string {
  const failed = job.steps
    .filter(step => step.status === 'failed')
    .sort((left, right) => (
      right.attempt - left.attempt || right.id - left.id
    ))[0]
  if (failed?.error) return failed.error
  return job.status === 'cancelled'
    ? '分段预览已取消'
    : '分段预览生成失败'
}

function SpeechSplitPreviewSession({
  project,
  direction,
  onApply,
  onCancel,
  createPreview = createSpeechSplitPreview,
  readJob = getJob,
}: {
  project: TextVideoProject
  direction: string
  onApply(project: TextVideoProject): void
  onCancel(): void
  createPreview?: PreviewCreator
  readJob?: JobReader
}) {
  const [jobId, setJobId] = useState<number | null>(null)
  const [proposal, setProposal] = useState<SpeechSplitProposal | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    const poll = async (id: number) => {
      try {
        const job = await readJob(id)
        if (cancelled) return
        const result = readProposal(job)
        if (result) {
          setProposal(result)
        } else if (job.status === 'failed' || job.status === 'cancelled') {
          setError(failedJobMessage(job))
        } else if (job.status === 'succeeded') {
          setError('分段预览任务已完成，但未返回有效分段建议')
        } else {
          timer = window.setTimeout(() => {
            void poll(id)
          }, 1_500)
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : '分段预览读取失败')
      }
    }
    void createPreview(project.id, { revision: project.revision, direction }).then(result => {
      if (cancelled) return
      const nextJobId = result.jobs[0]?.id
      if (!nextJobId) {
        setError('分段预览任务未创建')
        return
      }
      setJobId(nextJobId)
      void poll(nextJobId)
    }).catch(cause => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : '分段预览创建失败')
    })
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [createPreview, direction, project.id, project.revision, readJob])

  function apply() {
    if (!proposal) return
    onApply(applySpeechSplitProposal(project, proposal))
  }

  return (
    <>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {!error && !proposal ? <p className="text-sm text-muted-foreground">{jobId ? '正在生成分段建议…' : '正在创建分段预览…'}</p> : null}
      {proposal ? (
        <ol className="flex max-h-[52vh] flex-col gap-3 overflow-y-auto pr-1">
          {proposal.segments.map((segment, index) => (
            <li key={segment.id} className="rounded-lg border bg-muted/30 p-3">
              <div className="mb-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                <span>段落 {index + 1}</span><span>约 {segment.estimated_duration.toFixed(1)} 秒</span>
              </div>
              <p className="whitespace-pre-wrap text-sm leading-6">{segment.text}</p>
              <p className="mt-2 text-xs text-muted-foreground">{segment.reason}</p>
            </li>
          ))}
        </ol>
      ) : null}
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>取消</Button>
        <Button disabled={!proposal} onClick={apply}>应用分段</Button>
      </DialogFooter>
    </>
  )
}

export function SpeechSplitPreviewDialog({
  open,
  project,
  direction,
  onOpenChange,
  onApply,
  createPreview = createSpeechSplitPreview,
  getJob: readJob = getJob,
}: {
  open: boolean
  project: TextVideoProject
  direction: string
  onOpenChange(open: boolean): void
  onApply(project: TextVideoProject): void
  createPreview?: PreviewCreator
  getJob?: JobReader
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>AI 口播分段预览</DialogTitle>
          <DialogDescription>预览不会生成配音。确认应用后才会保存新的口播分段。</DialogDescription>
        </DialogHeader>
        {open ? (
          <SpeechSplitPreviewSession
            project={project}
            direction={direction}
            createPreview={createPreview}
            readJob={readJob}
            onCancel={() => onOpenChange(false)}
            onApply={next => {
              onApply(next)
              onOpenChange(false)
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
