'use client'

import type { ReactNode } from 'react'

import { ChevronDown, Lightbulb, ShieldAlert, Target } from 'lucide-react'

import type { ContentType, ResponseDetail } from '@/lib/api/responses'
import { contentTypeLabels, dispositionLabels } from '@/lib/api/responses'

const allContentTypes: ContentType[] = ['tool', 'industry_update', 'case', 'tutorial', 'research']

export function ResponseEvaluationPane({
  detail,
  onClassification,
  classificationBusy = false,
  history = [],
}: {
  detail: ResponseDetail
  onClassification?: (contentTypes: ContentType[]) => void
  classificationBusy?: boolean
  history?: Array<{ id: number; event_type: string; created_at: string }>
}) {
  const analysis = detail.analysis
  if (!analysis) {
    return (
      <section className="rounded-2xl border border-border bg-card p-6">
        <h2 className="text-base font-semibold">AI 评价</h2>
        <p className="mt-3 text-sm text-muted-foreground">分析任务状态：{detail.workflow_status}</p>
      </section>
    )
  }

  const toggleType = (type: ContentType) => {
    if (!onClassification || classificationBusy) return
    const next = detail.content_types.includes(type)
      ? detail.content_types.filter(item => item !== type)
      : [...detail.content_types, type]
    onClassification(next)
  }

  return (
    <section className="space-y-4">
      <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
        <div className="flex items-start gap-4">
          <div className="grid size-20 shrink-0 place-items-center rounded-2xl bg-primary text-primary-foreground">
            <span className="text-3xl font-semibold leading-none">{analysis.content_value_score}</span>
            <span className="text-[10px] opacity-80">内容价值</span>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">AI 评价</p>
            <h2 className="mt-1 text-lg font-semibold">{dispositionLabels[analysis.recommended_disposition]}</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{analysis.recommendation_reason}</p>
          </div>
        </div>
        <div className="mt-5 border-t border-border pt-4">
          <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Target className="size-3.5" /> 内容分类（可调整）
          </div>
          <div className="flex flex-wrap gap-2">
            {allContentTypes.map(type => {
              const active = detail.content_types.includes(type)
              return (
                <button
                  key={type}
                  type="button"
                  disabled={!onClassification || classificationBusy}
                  aria-pressed={active}
                  onClick={() => toggleType(type)}
                  className={`rounded-full border px-3 py-1 text-xs transition-colors ${active ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted'}`}
                >
                  {contentTypeLabels[type]}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <InsightCard icon={<Lightbulb className="size-4" />} title="为什么值得关注" items={analysis.value_points} />
        <InsightCard icon={<ShieldAlert className="size-4" />} title="风险与待核验" items={[...analysis.risks, ...analysis.verification_items]} tone="warning" />
      </div>

      <div className="rounded-2xl border border-border bg-card p-5">
        <p className="text-xs font-medium text-muted-foreground">建议切入角度</p>
        <p className="mt-2 text-sm leading-6">{analysis.suggested_angle}</p>
        <p className="mt-4 text-xs font-medium text-muted-foreground">核心判断</p>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{analysis.core_thesis}</p>
      </div>

      <details className="group rounded-2xl border border-border bg-card">
        <summary className="flex cursor-pointer list-none items-center gap-2 p-5 text-sm font-medium">
          <ChevronDown className="size-4 transition-transform group-open:rotate-180" /> 价值维度与建议结构
        </summary>
        <div className="grid gap-4 border-t border-border p-5 sm:grid-cols-2">
          <div className="space-y-3">
            {Object.entries(analysis.value_dimensions).map(([name, dimension]) => (
              <div key={name}>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">{name}</span>
                  <span className="font-medium">{dimension.score}</span>
                </div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{dimension.reason}</p>
              </div>
            ))}
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">目标读者：{analysis.target_reader}</p>
            <ol className="mt-3 list-inside list-decimal space-y-2 text-sm">
              {analysis.suggested_structure.map(section => <li key={section}>{section}</li>)}
            </ol>
          </div>
        </div>
      </details>

      <details className="group rounded-2xl border border-border bg-card">
        <summary className="flex cursor-pointer list-none items-center gap-2 p-5 text-sm font-medium">
          <ChevronDown className="size-4 transition-transform group-open:rotate-180" /> 证据与分析历史
        </summary>
        <div className="space-y-4 border-t border-border p-5">
          <div className="space-y-2">
            {analysis.evidence.map((evidence, index) => (
              <div key={`${evidence.text}-${index}`} className="rounded-lg bg-muted/40 p-3 text-sm">
                <p>{evidence.text}</p>
                <p className="mt-1 text-xs text-muted-foreground">{evidence.type}{evidence.source ? ` · ${evidence.source}` : ''}</p>
              </div>
            ))}
          </div>
          {!!history.length && <p className="text-xs text-muted-foreground">已有 {history.length} 条处理记录</p>}
        </div>
      </details>
    </section>
  )
}

function InsightCard({
  icon,
  title,
  items,
  tone = 'default',
}: {
  icon: ReactNode
  title: string
  items: string[]
  tone?: 'default' | 'warning'
}) {
  return (
    <div className={`rounded-2xl border p-5 ${tone === 'warning' ? 'border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/20' : 'border-border bg-card'}`}>
      <div className="flex items-center gap-2 text-sm font-medium">{icon}{title}</div>
      <ul className="mt-3 space-y-2 text-sm leading-6 text-muted-foreground">
        {(items.length ? items : ['暂无']).map((item, index) => <li key={`${item}-${index}`}>· {item}</li>)}
      </ul>
    </div>
  )
}
