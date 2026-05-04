'use client'

import { useState, useEffect, useCallback } from 'react'
import { Plus, Pencil, Trash2, Loader2, Sparkles, ChevronRight, ToggleLeft, ToggleRight, Check, X } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Direction, Strategy,
  getDirections, createDirection, updateDirection, deleteDirection,
  getStrategies, createStrategy, updateStrategy, deleteStrategy, generateTopics,
} from '@/lib/api/directions'

// ── Inline editable text ──────────────────────────────────────────────────────
function InlineEdit({
  value, onSave, className, placeholder,
}: { value: string; onSave: (v: string) => void; className?: string; placeholder?: string }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  if (!editing) return (
    <span
      className={cn('cursor-pointer hover:opacity-70 transition-opacity', className)}
      onClick={() => { setDraft(value); setEditing(true) }}
    >
      {value || <span className="text-zinc-400 italic">{placeholder}</span>}
    </span>
  )
  return (
    <span className="inline-flex items-center gap-1">
      <input
        autoFocus
        className="bg-zinc-100 dark:bg-zinc-800 rounded px-1.5 py-0.5 text-sm outline-none border border-indigo-300 dark:border-indigo-600 min-w-[120px]"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') { onSave(draft); setEditing(false) }
          if (e.key === 'Escape') setEditing(false)
        }}
      />
      <button onClick={() => { onSave(draft); setEditing(false) }} className="text-emerald-500 hover:text-emerald-600"><Check className="w-3.5 h-3.5" /></button>
      <button onClick={() => setEditing(false)} className="text-zinc-400 hover:text-zinc-600"><X className="w-3.5 h-3.5" /></button>
    </span>
  )
}

// ── Strategy form ─────────────────────────────────────────────────────────────
function StrategyForm({
  initial, onSave, onCancel,
}: {
  initial?: Partial<Strategy>
  onSave: (data: Omit<Strategy, 'id' | 'direction_id' | 'is_active' | 'created_at'>) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [hours, setHours] = useState(String(initial?.filter_hours ?? 48))
  const [minViews, setMinViews] = useState(String(initial?.filter_min_views ?? 0))
  const [viralOnly, setViralOnly] = useState(initial?.filter_viral_only ?? false)
  const [keywords, setKeywords] = useState((initial?.filter_keywords ?? []).join('、'))
  const [excludeKw, setExcludeKw] = useState((initial?.filter_exclude_keywords ?? []).join('、'))
  const [prompt, setPrompt] = useState(initial?.llm_prompt ?? '')
  const [count, setCount] = useState(String(initial?.output_count ?? 5))

  const splitKw = (s: string) => s.split(/[,，、\s]+/).map(k => k.trim()).filter(Boolean)

  return (
    <div className="space-y-4">
      <div>
        <label className="text-xs font-medium text-zinc-500 mb-1 block">策略名称</label>
        <Input value={name} onChange={e => setName(e.target.value)} placeholder="例：追热点策略" className="h-8 text-sm" />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-zinc-500 mb-1 block">时间窗口（小时）</label>
          <Input type="number" value={hours} onChange={e => setHours(e.target.value)} className="h-8 text-sm" />
        </div>
        <div>
          <label className="text-xs font-medium text-zinc-500 mb-1 block">最低阅读量</label>
          <Input type="number" value={minViews} onChange={e => setMinViews(e.target.value)} className="h-8 text-sm" />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={() => setViralOnly(v => !v)}
          className={cn('flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border transition-colors',
            viralOnly
              ? 'border-orange-300 bg-orange-50 text-orange-700 dark:border-orange-700 dark:bg-orange-950/50 dark:text-orange-400'
              : 'border-zinc-200 text-zinc-500 hover:border-zinc-300 dark:border-zinc-700'
          )}
        >
          {viralOnly ? <ToggleRight className="w-3.5 h-3.5" /> : <ToggleLeft className="w-3.5 h-3.5" />}
          仅抓 Viral 帖
        </button>
        <div className="flex-1">
          <label className="text-xs font-medium text-zinc-500 mb-1 block">输出选题数</label>
          <Input type="number" value={count} onChange={e => setCount(e.target.value)} className="h-8 text-sm" min={1} max={10} />
        </div>
      </div>

      <div>
        <label className="text-xs font-medium text-zinc-500 mb-1 block">关键词白名单（逗号/顿号分隔，留空不过滤）</label>
        <Input value={keywords} onChange={e => setKeywords(e.target.value)} placeholder="例：AI、大模型、教程" className="h-8 text-sm" />
      </div>

      <div>
        <label className="text-xs font-medium text-zinc-500 mb-1 block">关键词黑名单</label>
        <Input value={excludeKw} onChange={e => setExcludeKw(e.target.value)} placeholder="例：广告、推广" className="h-8 text-sm" />
      </div>

      <div>
        <label className="text-xs font-medium text-zinc-500 mb-1 block">
          LLM 提示词（留空使用默认，可描述选题角度和风格要求）
        </label>
        <textarea
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          rows={4}
          placeholder="例：你负责教程方向的内容策划，请重点关注有实操步骤的技术帖，提炼成适合零基础读者的教程选题，标题需包含「如何」或「教你」。"
          className="w-full rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-sm px-3 py-2 outline-none focus:ring-1 focus:ring-indigo-300 dark:focus:ring-indigo-700 resize-none placeholder:text-zinc-400"
        />
      </div>

      <div className="flex gap-2 pt-1">
        <Button
          size="sm"
          onClick={() => {
            if (!name.trim()) { toast.error('请填写策略名称'); return }
            onSave({
              name: name.trim(),
              filter_hours: parseInt(hours) || 48,
              filter_min_views: parseInt(minViews) || 0,
              filter_viral_only: viralOnly,
              filter_keywords: splitKw(keywords),
              filter_exclude_keywords: splitKw(excludeKw),
              llm_prompt: prompt.trim(),
              output_count: parseInt(count) || 5,
            })
          }}
          className="bg-indigo-600 hover:bg-indigo-700 text-white"
        >
          保存策略
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>取消</Button>
      </div>
    </div>
  )
}

// ── Strategy card ─────────────────────────────────────────────────────────────
function StrategyCard({
  strategy, directionId, onUpdated, onDeleted,
}: {
  strategy: Strategy
  directionId: number
  onUpdated: (s: Strategy) => void
  onDeleted: (id: number) => void
}) {
  const [editing, setEditing] = useState(false)
  const [generating, setGenerating] = useState(false)

  const handleGenerate = async () => {
    setGenerating(true)
    try {
      const topics = await generateTopics(directionId, strategy.id) as unknown[]
      toast.success(`生成了 ${topics.length} 个选题，已保存到选题决策流`)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`生成失败：${msg}`)
    } finally {
      setGenerating(false)
    }
  }

  const handleToggleActive = async () => {
    try {
      const updated = await updateStrategy(directionId, strategy.id, { is_active: !strategy.is_active })
      onUpdated(updated)
    } catch {
      toast.error('操作失败')
    }
  }

  if (editing) return (
    <div className="rounded-xl border border-indigo-200 dark:border-indigo-800 bg-indigo-50/50 dark:bg-indigo-950/20 p-4">
      <StrategyForm
        initial={strategy}
        onSave={async data => {
          try {
            const updated = await updateStrategy(directionId, strategy.id, data)
            onUpdated(updated)
            setEditing(false)
            toast.success('策略已更新')
          } catch { toast.error('更新失败') }
        }}
        onCancel={() => setEditing(false)}
      />
    </div>
  )

  return (
    <div className={cn(
      'rounded-xl border p-4 transition-colors',
      strategy.is_active
        ? 'border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950'
        : 'border-zinc-100 dark:border-zinc-900 bg-zinc-50 dark:bg-zinc-900/50 opacity-60'
    )}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <span className="font-medium text-sm text-zinc-900 dark:text-zinc-100">{strategy.name}</span>
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            <Tag>{strategy.filter_hours}h 窗口</Tag>
            {strategy.filter_min_views > 0 && <Tag>阅读 ≥ {fmtNum(strategy.filter_min_views)}</Tag>}
            {strategy.filter_viral_only && <Tag color="orange">仅 Viral</Tag>}
            {strategy.filter_keywords.length > 0 && <Tag color="indigo">白名单 {strategy.filter_keywords.length} 词</Tag>}
            {strategy.filter_exclude_keywords.length > 0 && <Tag color="red">黑名单 {strategy.filter_exclude_keywords.length} 词</Tag>}
            <Tag>输出 {strategy.output_count} 个选题</Tag>
          </div>
          {strategy.llm_prompt && (
            <p className="mt-2 text-xs text-zinc-400 line-clamp-2 leading-relaxed">{strategy.llm_prompt}</p>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button onClick={handleToggleActive} className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-400 hover:text-zinc-600 transition-colors" title={strategy.is_active ? '停用' : '启用'}>
            {strategy.is_active ? <ToggleRight className="w-4 h-4 text-emerald-500" /> : <ToggleLeft className="w-4 h-4" />}
          </button>
          <button onClick={() => setEditing(true)} className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-400 hover:text-zinc-600 transition-colors">
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={async () => {
              if (!confirm(`确认删除策略「${strategy.name}」？`)) return
              try { await deleteStrategy(directionId, strategy.id); onDeleted(strategy.id) }
              catch { toast.error('删除失败') }
            }}
            className="p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-950/30 text-zinc-400 hover:text-red-500 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <Button
        size="sm"
        disabled={!strategy.is_active || generating}
        onClick={handleGenerate}
        className="bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-50 gap-1.5"
      >
        {generating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
        {generating ? '生成中…' : '立即生成选题'}
      </Button>
    </div>
  )
}

function Tag({ children, color }: { children: React.ReactNode; color?: 'orange' | 'indigo' | 'red' }) {
  return (
    <span className={cn(
      'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border',
      !color && 'bg-zinc-100 text-zinc-500 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:border-zinc-700',
      color === 'orange' && 'bg-orange-50 text-orange-600 border-orange-200 dark:bg-orange-950/50 dark:text-orange-400 dark:border-orange-800',
      color === 'indigo' && 'bg-indigo-50 text-indigo-600 border-indigo-200 dark:bg-indigo-950/50 dark:text-indigo-400 dark:border-indigo-800',
      color === 'red' && 'bg-red-50 text-red-600 border-red-200 dark:bg-red-950/50 dark:text-red-400 dark:border-red-800',
    )}>
      {children}
    </span>
  )
}

function fmtNum(n: number) {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}w`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

// ── Main component ────────────────────────────────────────────────────────────
export function DirectionsClient() {
  const [directions, setDirections] = useState<Direction[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [strategies, setStrategies] = useState<Strategy[]>([])
  const [loading, setLoading] = useState(true)
  const [addingDirection, setAddingDirection] = useState(false)
  const [newDirName, setNewDirName] = useState('')
  const [newDirDesc, setNewDirDesc] = useState('')
  const [addingStrategy, setAddingStrategy] = useState(false)

  const selected = directions.find(d => d.id === selectedId) ?? null

  const loadDirections = useCallback(async () => {
    try {
      const dirs = await getDirections()
      setDirections(dirs)
      if (dirs.length > 0 && selectedId === null) setSelectedId(dirs[0].id)
    } catch { toast.error('加载方向失败') }
    finally { setLoading(false) }
  }, [selectedId])

  const loadStrategies = useCallback(async (dirId: number) => {
    try {
      setStrategies(await getStrategies(dirId))
    } catch { toast.error('加载策略失败') }
  }, [])

  useEffect(() => { loadDirections() }, [])
  useEffect(() => { if (selectedId !== null) loadStrategies(selectedId) }, [selectedId, loadStrategies])

  const handleCreateDirection = async () => {
    if (!newDirName.trim()) { toast.error('请输入方向名称'); return }
    try {
      const dir = await createDirection({ name: newDirName.trim(), description: newDirDesc.trim() })
      setDirections(prev => [...prev, dir])
      setSelectedId(dir.id)
      setNewDirName(''); setNewDirDesc(''); setAddingDirection(false)
      toast.success('内容方向已创建')
    } catch { toast.error('创建失败') }
  }

  const handleDeleteDirection = async (dir: Direction) => {
    if (!confirm(`确认删除方向「${dir.name}」及其所有策略？`)) return
    try {
      await deleteDirection(dir.id)
      const next = directions.filter(d => d.id !== dir.id)
      setDirections(next)
      if (selectedId === dir.id) setSelectedId(next[0]?.id ?? null)
      toast.success('已删除')
    } catch { toast.error('删除失败') }
  }

  if (loading) return (
    <div className="flex h-screen items-center justify-center text-zinc-400 text-sm">
      <Loader2 className="w-4 h-4 animate-spin mr-2" />加载中
    </div>
  )

  return (
    <div className="flex h-screen overflow-hidden">
      {/* ── Left: directions list ── */}
      <aside className="w-64 border-r border-zinc-200 dark:border-zinc-800 flex flex-col bg-white dark:bg-zinc-950 flex-shrink-0">
        <div className="px-4 py-4 border-b border-zinc-100 dark:border-zinc-800 flex items-center justify-between">
          <h2 className="font-semibold text-sm text-zinc-900 dark:text-zinc-100">内容方向</h2>
          <button
            onClick={() => setAddingDirection(true)}
            className="p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-400 hover:text-zinc-700 transition-colors"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          {directions.length === 0 && !addingDirection && (
            <p className="px-4 py-6 text-xs text-zinc-400 text-center">还没有内容方向<br />点击 + 新建</p>
          )}

          {directions.map(dir => (
            <div
              key={dir.id}
              onClick={() => setSelectedId(dir.id)}
              className={cn(
                'group flex items-center gap-2 px-4 py-2.5 cursor-pointer transition-colors',
                selectedId === dir.id
                  ? 'bg-indigo-50 dark:bg-indigo-950/30 text-indigo-700 dark:text-indigo-300'
                  : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-900',
                !dir.is_active && 'opacity-50'
              )}
            >
              <ChevronRight className={cn('w-3.5 h-3.5 flex-shrink-0 transition-transform', selectedId === dir.id && 'rotate-90')} />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{dir.name}</div>
                {dir.description && (
                  <div className="text-[11px] text-zinc-400 truncate mt-0.5">{dir.description}</div>
                )}
              </div>
              <button
                onClick={e => { e.stopPropagation(); handleDeleteDirection(dir) }}
                className="opacity-0 group-hover:opacity-100 p-1 rounded hover:text-red-500 transition-all"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>

        {addingDirection && (
          <div className="p-3 border-t border-zinc-100 dark:border-zinc-800 space-y-2">
            <Input
              autoFocus
              placeholder="方向名称，如：教程"
              value={newDirName}
              onChange={e => setNewDirName(e.target.value)}
              className="h-8 text-sm"
              onKeyDown={e => e.key === 'Enter' && handleCreateDirection()}
            />
            <Input
              placeholder="简短说明（可选）"
              value={newDirDesc}
              onChange={e => setNewDirDesc(e.target.value)}
              className="h-8 text-sm"
            />
            <div className="flex gap-1.5">
              <Button size="sm" onClick={handleCreateDirection} className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white">创建</Button>
              <Button size="sm" variant="ghost" onClick={() => { setAddingDirection(false); setNewDirName(''); setNewDirDesc('') }}>取消</Button>
            </div>
          </div>
        )}
      </aside>

      {/* ── Right: strategies panel ── */}
      <main className="flex-1 overflow-y-auto bg-zinc-50 dark:bg-zinc-900">
        {selected === null ? (
          <div className="flex h-full items-center justify-center text-zinc-400 text-sm">
            从左侧选择或创建内容方向
          </div>
        ) : (
          <div className="max-w-2xl mx-auto px-6 py-6">
            {/* Direction header */}
            <div className="mb-6">
              <div className="flex items-center gap-2 mb-1">
                <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
                  <InlineEdit
                    value={selected.name}
                    placeholder="点击编辑名称"
                    className="text-xl font-semibold"
                    onSave={async name => {
                      try {
                        const updated = await updateDirection(selected.id, { name })
                        setDirections(prev => prev.map(d => d.id === updated.id ? updated : d))
                      } catch { toast.error('更新失败') }
                    }}
                  />
                </h1>
                <button
                  onClick={async () => {
                    try {
                      const updated = await updateDirection(selected.id, { is_active: !selected.is_active })
                      setDirections(prev => prev.map(d => d.id === updated.id ? updated : d))
                    } catch { toast.error('操作失败') }
                  }}
                  className="text-xs px-2 py-0.5 rounded-full border transition-colors"
                  style={{ fontSize: '10px' }}
                >
                  {selected.is_active
                    ? <span className="text-emerald-600 border-emerald-200">启用中</span>
                    : <span className="text-zinc-400 border-zinc-300">已停用</span>}
                </button>
              </div>
              <p className="text-sm text-zinc-500">
                <InlineEdit
                  value={selected.description}
                  placeholder="添加方向说明…"
                  className="text-sm text-zinc-500"
                  onSave={async description => {
                    try {
                      const updated = await updateDirection(selected.id, { description })
                      setDirections(prev => prev.map(d => d.id === updated.id ? updated : d))
                    } catch { toast.error('更新失败') }
                  }}
                />
              </p>
            </div>

            {/* Strategies */}
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">选题策略</h2>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setAddingStrategy(true)}
                className="gap-1.5 h-7 text-xs"
              >
                <Plus className="w-3.5 h-3.5" />新建策略
              </Button>
            </div>

            {addingStrategy && (
              <div className="rounded-xl border border-indigo-200 dark:border-indigo-800 bg-indigo-50/50 dark:bg-indigo-950/20 p-4 mb-3">
                <p className="text-xs font-medium text-indigo-700 dark:text-indigo-300 mb-3">新建策略</p>
                <StrategyForm
                  onSave={async data => {
                    try {
                      const s = await createStrategy(selectedId!, data)
                      setStrategies(prev => [...prev, s])
                      setAddingStrategy(false)
                      toast.success('策略已创建')
                    } catch { toast.error('创建失败') }
                  }}
                  onCancel={() => setAddingStrategy(false)}
                />
              </div>
            )}

            {strategies.length === 0 && !addingStrategy ? (
              <div className="rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 p-8 text-center text-zinc-400 text-sm">
                还没有策略，点击「新建策略」添加第一个
              </div>
            ) : (
              <div className="space-y-3">
                {strategies.map(s => (
                  <StrategyCard
                    key={s.id}
                    strategy={s}
                    directionId={selected.id}
                    onUpdated={updated => setStrategies(prev => prev.map(x => x.id === updated.id ? updated : x))}
                    onDeleted={id => setStrategies(prev => prev.filter(x => x.id !== id))}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
