'use client'

import { useMemo, useState } from 'react'
import { ChevronDown, FileOutput, Loader2, RefreshCw, RotateCcw, X } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { confirmPipeline, cancelPipeline, rerunPipelineStage, revisePipeline, retryPipelineStage, type ContentJob, type PipelinePlanStage, type PipelineStage } from '@/lib/api/jobs'
import { cn } from '@/lib/utils'

type Props = {
  initialJob: ContentJob
  onJobChange: (job: ContentJob) => void
  onTerminal?: () => void
}

const terminalStatuses = new Set(['succeeded', 'failed', 'cancelled', 'superseded'])

function newRequestId() {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `pipeline-command-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function isTerminal(status: string) {
  return terminalStatuses.has(status)
}

function stageStatusLabel(status: string, uncertain: boolean) {
  if (uncertain) return '结果待确认'
  if (status === 'awaiting_confirmation') return '等待确认'
  if (status === 'queued') return '待执行'
  if (status === 'running') return '执行中'
  if (status === 'succeeded') return '已完成'
  if (status === 'failed') return '失败'
  if (status === 'cancelled') return '已取消'
  if (status === 'superseded') return '已替代'
  return status
}

function isUncertain(stage: PipelineStage) {
  const output = stage.output ?? {}
  return output.uncertain === true || /uncertain|不确定|无法确认|acknowledg/i.test(stage.error || '')
}

function latestStage(stages: PipelineStage[], key: string) {
  const matching = stages.filter(stage => stage.key === key)
  return matching.filter(stage => stage.status !== 'superseded').at(-1) ?? matching.at(-1)
}

function stageActionLabel(stage: PipelineStage | undefined) {
  if (!stage) return '待执行'
  return stageStatusLabel(stage.status, isUncertain(stage))
}

export function ChatPipelineCard({ initialJob, onJobChange, onTerminal }: Props) {
  const [expandedStages, setExpandedStages] = useState<Record<string, boolean>>({})
  const [revisionOpen, setRevisionOpen] = useState(false)
  const [revisionInstructions, setRevisionInstructions] = useState('')
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const pipeline = initialJob.pipeline
  const plan = pipeline?.plan
  const stageRows = useMemo(() => pipeline?.stages ?? [], [pipeline?.stages])

  const currentPosition = useMemo(() => {
    const position = plan?.stages.findIndex(planStage => {
      const stage = latestStage(stageRows, planStage.step_key)
      return stage?.status === 'running' || stage?.status === 'failed' || stage?.status === 'queued'
    }) ?? -1
    return position >= 0 ? position : 0
  }, [plan?.stages, stageRows])

  if (!plan) {
    return <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">Pipeline 任务数据不完整，暂时无法显示。</div>
  }
  const resolvedPlan = plan

  async function runCommand(action: string, command: () => Promise<ContentJob>) {
    if (pendingAction) return
    setPendingAction(action)
    try {
      const updated = await command()
      onJobChange(updated)
      if (isTerminal(updated.status)) onTerminal?.()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Pipeline 操作失败')
    } finally {
      setPendingAction(null)
    }
  }

  function openRevision() {
    setRevisionInstructions('')
    setRevisionOpen(true)
  }

  function submitRevision() {
    const instruction = revisionInstructions.trim()
    if (!instruction) return
    const stageKey = resolvedPlan.stages[currentPosition]?.step_key
    if (!stageKey) return
    setRevisionOpen(false)
    void runCommand('revise', () => revisePipeline(initialJob.id, initialJob.plan_version ?? resolvedPlan.version, newRequestId(), { [stageKey]: instruction }))
  }

  function confirmRerun(stage: PipelineStage) {
    if (!window.confirm(`重新运行“${stage.key}”会产生新的执行尝试，是否继续？`)) return
    void runCommand(`rerun:${stage.key}`, () => rerunPipelineStage(initialJob.id, stage.key, newRequestId()))
  }

  return (
    <section className="rounded-xl border border-indigo-100 bg-indigo-50/40 p-3 text-sm dark:border-indigo-900/60 dark:bg-indigo-950/20" aria-label="Skill Pipeline">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-indigo-600 dark:text-indigo-300">Skill Pipeline · {stageStatusLabel(initialJob.status, false)}</p>
          <h3 className="mt-1 font-medium text-foreground">{plan.objective}</h3>
          <p className="mt-1 text-xs text-muted-foreground">按顺序执行 {plan.stages.length} 个 Skill · 计划 V{initialJob.plan_version ?? plan.version}</p>
        </div>
        {initialJob.status === 'awaiting_confirmation' && <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" disabled={pendingAction !== null} onClick={() => void runCommand('confirm', () => confirmPipeline(initialJob.id, initialJob.plan_version ?? plan.version, newRequestId()))}>
            {pendingAction === 'confirm' && <Loader2 className="animate-spin" />}开始执行
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={pendingAction !== null} onClick={openRevision}>调整计划</Button>
          <Button type="button" size="sm" variant="ghost" disabled={pendingAction !== null} onClick={() => void runCommand('cancel', () => cancelPipeline(initialJob.id, newRequestId()))}><X />取消</Button>
        </div>}
      </div>

      <div className="mt-3 space-y-2">
        {plan.stages.map((planStage, index) => {
          const stage = latestStage(stageRows, planStage.step_key)
          const uncertain = stage ? isUncertain(stage) : false
          const open = expandedStages[planStage.step_key] ?? (index === currentPosition || stage?.status === 'running' || stage?.status === 'failed' || uncertain)
          const pending = !stage || (stage.status === 'queued' && index !== currentPosition)
          return <PipelineStageCard
            key={planStage.step_key}
            planStage={planStage}
            stage={stage}
            open={open}
            pending={pending}
            uncertain={uncertain}
            pendingAction={pendingAction}
            onToggle={value => setExpandedStages(current => ({ ...current, [planStage.step_key]: value }))}
            onRetry={() => stage && void runCommand(`retry:${stage.key}`, () => retryPipelineStage(initialJob.id, stage.key, newRequestId()))}
            onRerun={() => stage && confirmRerun(stage)}
            canRerun={initialJob.status === 'succeeded' && stage?.status === 'succeeded'}
          />
        })}
      </div>

      <Dialog open={revisionOpen} onOpenChange={setRevisionOpen}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>调整计划</DialogTitle>
            <DialogDescription>只填写对当前阶段的执行要求；服务端会生成新的计划版本。</DialogDescription>
          </DialogHeader>
          <label className="space-y-2 text-sm">
            <span className="font-medium">阶段调整说明</span>
            <textarea autoFocus value={revisionInstructions} onChange={event => setRevisionInstructions(event.target.value)} rows={5} className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50" placeholder="例如：先列出三条可核验的一手资料，再开始写作。" />
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRevisionOpen(false)}>返回</Button>
            <Button type="button" disabled={!revisionInstructions.trim() || pendingAction !== null} onClick={submitRevision}>保存调整</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

function PipelineStageCard({
  planStage,
  stage,
  open,
  pending,
  uncertain,
  pendingAction,
  onToggle,
  onRetry,
  onRerun,
  canRerun,
}: {
  planStage: PipelinePlanStage
  stage?: PipelineStage
  open: boolean
  pending: boolean
  uncertain: boolean
  pendingAction: string | null
  onToggle: (open: boolean) => void
  onRetry: () => void
  onRerun: () => void
  canRerun: boolean
}) {
  const status = stageActionLabel(stage)
  return (
    <div data-testid="pipeline-stage" data-stage-key={planStage.step_key} className={cn('rounded-lg border border-indigo-100/80 bg-background/80 dark:border-indigo-900/60', pending && 'bg-background/50')}>
      <details open={open} onToggle={event => onToggle(event.currentTarget.open)}>
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 [&::-webkit-details-marker]:hidden">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-[11px] font-medium text-indigo-700 dark:bg-indigo-900/60 dark:text-indigo-200">{planStage.position}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{planStage.display_name}</span>
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">{planStage.parameter_display_name ? `${planStage.parameter_display_name} · ` : ''}预期：{planStage.expected_output}</span>
          </span>
          <span className={cn('shrink-0 text-xs', uncertain ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground')}>{status}</span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform [[open]_&]:rotate-180" />
        </summary>
        <div className="border-t border-indigo-100/80 px-3 pb-3 pt-2 dark:border-indigo-900/60">
          {uncertain && <p className="mb-2 rounded-md bg-amber-50 px-2.5 py-2 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">不确定结果：请根据下面的执行证据决定是否重试。</p>}
          {stage?.error && <p className="mb-2 rounded-md bg-red-50 px-2.5 py-2 text-xs text-red-800 dark:bg-red-950/30 dark:text-red-200">{stage.error}</p>}
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>输出类型：{planStage.expected_output}</span>
            <span>尝试 {stage?.attempt ?? 1}</span>
          </div>
          {stage?.artifacts && stage.artifacts.length > 0 && <div className="mt-3 space-y-1.5">
            {stage.artifacts.map(artifact => <details key={artifact.id} className="rounded-md border border-border bg-surface">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-2 text-xs font-medium [&::-webkit-details-marker]:hidden"><FileOutput className="h-3.5 w-3.5 text-indigo-500" />产物：{artifact.title}<span className="ml-auto text-muted-foreground">{artifact.role === 'primary' ? '主产物' : '辅助'}</span></summary>
              <div className="border-t border-border px-2.5 py-2 text-xs leading-5 text-muted-foreground">{artifact.text_content || (artifact.structured_content ? JSON.stringify(artifact.structured_content) : '无可显示内容')}</div>
            </details>)}
          </div>}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {stage?.status === 'failed' && stage.retryable && <Button type="button" size="xs" variant="outline" disabled={pendingAction !== null} onClick={onRetry}>{pendingAction?.startsWith('retry:') && <Loader2 className="animate-spin" />}<RotateCcw />重试本 Stage</Button>}
            {canRerun && <Button type="button" size="xs" variant="outline" disabled={pendingAction !== null} onClick={onRerun}>{pendingAction?.startsWith('rerun:') && <Loader2 className="animate-spin" />}<RefreshCw />重新运行</Button>}
          </div>
        </div>
      </details>
    </div>
  )
}
