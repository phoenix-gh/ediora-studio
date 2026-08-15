'use client'
import Link from 'next/link'
import type { DailyCreationRun } from '@/lib/api/creation-rules'
import { summarizeDirectories } from './directory-summary'

export function CreationRunsPanel({ runs }: { runs: DailyCreationRun[] }) {
  return <section className="space-y-3">
    <div>
      <h2 className="font-semibold">今日创作任务</h2>
      <p className="text-xs text-muted-foreground">查看 AI 选材、去重依据和产出进度。</p>
    </div>
    <div className="grid gap-2">
      {runs.length === 0 && <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">今天还没有规则任务</div>}
      {runs.map(run => {
        const excluded = Array.isArray(run.detail.excluded)
          ? run.detail.excluded as Array<{ reason?: string }>
          : []
        const outputs = Array.isArray(run.detail.outputs)
          ? run.detail.outputs as Array<{ draft_id?: number }>
          : []
        const agent = run.agent_execution
        const validationSummary = typeof agent?.self_validation.summary === 'string'
          ? agent.self_validation.summary
          : agent?.self_validation.passed === true ? 'Agent 自检通过' : ''
        return <details
          key={run.id}
          open={run.status === 'partial' || run.status === 'failed'}
          className="rounded-xl border bg-card p-4"
        >
          <summary className="cursor-pointer list-none">
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <h3 className="font-medium">{String(run.rule.name ?? `规则 #${run.rule_id}`)}</h3>
                <p className="text-xs text-muted-foreground">{summarizeDirectories(run.rule.directories ?? [], String(run.rule.directory ?? ''))}</p>
              </div>
              <span className="text-sm font-medium">{run.created_count} / {run.requested_count}</span>
              <span className="rounded-full bg-muted px-2 py-1 text-xs">{run.status}</span>
            </div>
          </summary>
          <div className="mt-3 space-y-3 border-t pt-3 text-xs">
            {agent && <div className="space-y-3 rounded-lg bg-muted/40 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">Agent · {agent.phase}</span>
                {agent.skill_name && <span className="rounded-md border bg-background px-2 py-1">{agent.skill_name}</span>}
                {agent.skill_activation && <span className="rounded-full bg-ai-subtle px-2 py-1 text-ai-foreground">
                  {agent.skill_activation === 'automatic' ? '自动触发' : '手动指定'}
                </span>}
              </div>
              {agent.loaded_references.length > 0 && <div>
                <p className="mb-1 font-medium">已读取 references</p>
                <div className="flex flex-wrap gap-1.5">
                  {agent.loaded_references.map(reference => <code key={reference.path} className="rounded bg-background px-2 py-1">{reference.path}</code>)}
                </div>
              </div>}
              {agent.tools.length > 0 && <div>
                <p className="mb-1 font-medium">工具调用</p>
                <div className="space-y-1.5">
                  {agent.tools.map((item, index) => <div key={`${item.tool_name}-${item.occurred_at}-${index}`} className="rounded border bg-background p-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <code>{item.tool_name}</code>
                      <span className="text-muted-foreground">{item.status}</span>
                      {item.auto_approved && <span className="rounded-full bg-success/10 px-2 py-0.5 text-success">自动批准</span>}
                    </div>
                    {item.error && <p className="mt-1 text-danger">{item.error}</p>}
                  </div>)}
                </div>
              </div>}
              {validationSummary && <p>自检：{validationSummary}</p>}
              {agent.completion?.createdCount !== undefined && <p className="font-medium text-success">已落库 {agent.completion.createdCount} 条</p>}
            </div>}
            {excluded.map((item, index) => <p key={index} className="text-muted-foreground">{item.reason}</p>)}
            <div className="flex flex-wrap gap-3">
              {outputs.map((item, index) => item.draft_id
                ? <Link key={index} href="/drafts" className="text-primary">草稿 #{item.draft_id}</Link>
                : null)}
            </div>
          </div>
        </details>
      })}
    </div>
  </section>
}
