'use client'

import { useState, useMemo } from 'react'
import {
  Quote as QuoteIcon, Plus, Search, Trash2, Pencil, Check, Copy, ExternalLink,
  RefreshCw, Loader2, Heart, Repeat2, Eye, Settings2, Play, Zap,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Material, MaterialCreate, CollectRule,
  SCENE_TAGS, sceneTagInfo,
  getMaterials, createMaterial, updateMaterial, deleteMaterial,
  getRules, createRule, updateRule, deleteRule, collectRule, collectAll,
} from '@/lib/api/materials'
import { WritingPlan, flattenTopics } from '@/lib/api/writing-plans'

type SourceFilter = 'all' | 'manual' | 'x'
type SortKey = 'time' | 'score' | 'views'

const isManual = (m: Material) => m.platform !== 'x'

// ── Scene tag badge ───────────────────────────────────────────────────────────
function SceneTag({ value }: { value: string }) {
  const info = sceneTagInfo(value)
  return <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full font-medium', info.color)}>{info.label}</span>
}

// ── Material card ───────────────────────────────────────────────────────────
function MaterialCard({ m, planMap, onEdit, onDelete }: {
  m: Material; planMap: Record<number, string>
  onEdit: (m: Material) => void; onDelete: (m: Material) => void
}) {
  const body = m.text_clean || m.text
  const isX = m.platform === 'x'
  function handleCopy() {
    navigator.clipboard.writeText(body)
    toast.success('已复制')
  }
  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4 group hover:border-indigo-200 dark:hover:border-indigo-800 transition-colors">
      {isX && m.cover_image && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={m.cover_image} alt="" className="w-full h-32 object-cover rounded-lg mb-3" />
      )}
      <blockquote className="text-sm text-zinc-800 dark:text-zinc-200 leading-relaxed mb-3 whitespace-pre-wrap">
        {body}
      </blockquote>

      {(m.author || m.source) && (
        <div className="flex items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400 mb-2">
          {m.author && <span>—— {m.author}{isX && m.handle ? ` @${m.handle}` : ''}</span>}
          {m.source && <span>· {m.source}</span>}
        </div>
      )}

      {isX && (
        <div className="flex items-center gap-3 text-[11px] text-zinc-400 mb-2">
          <span className="flex items-center gap-0.5"><Heart className="w-3 h-3" />{m.likes}</span>
          <span className="flex items-center gap-0.5"><Repeat2 className="w-3 h-3" />{m.reposts}</span>
          <span className="flex items-center gap-0.5"><Eye className="w-3 h-3" />{m.views}</span>
          {m.score > 0 && (
            <span className="ml-auto px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400 font-medium">
              段子分 {m.score}
            </span>
          )}
        </div>
      )}

      {(m.category || m.scene_tags.length > 0) && (
        <div className="flex flex-wrap gap-1 mb-2">
          {m.category && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
              {m.category}
            </span>
          )}
          {m.scene_tags.map(t => <SceneTag key={t} value={t} />)}
        </div>
      )}

      {m.writing_plan_id && planMap[m.writing_plan_id] && (
        <p className="text-[10px] text-zinc-400 mb-2"># {planMap[m.writing_plan_id]}</p>
      )}

      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button onClick={handleCopy} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 p-1 rounded" title="复制"><Copy className="w-3.5 h-3.5" /></button>
        {isX && m.source_url && (
          <a href={m.source_url} target="_blank" rel="noopener noreferrer" className="text-zinc-400 hover:text-indigo-500 p-1 rounded" title="查看原推"><ExternalLink className="w-3.5 h-3.5" /></a>
        )}
        <button onClick={() => onEdit(m)} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 p-1 rounded" title="编辑"><Pencil className="w-3.5 h-3.5" /></button>
        <button onClick={() => onDelete(m)} className="text-zinc-400 hover:text-red-500 p-1 rounded" title="删除"><Trash2 className="w-3.5 h-3.5" /></button>
      </div>
    </div>
  )
}

// ── Manual add / edit form ────────────────────────────────────────────────────
function MaterialForm({ initial, plans, categories, onSave, onCancel, saving }: {
  initial?: Material; plans: WritingPlan[]; categories: string[]
  onSave: (data: MaterialCreate) => Promise<void>; onCancel: () => void; saving: boolean
}) {
  const [text, setText] = useState(initial?.text ?? '')
  const [author, setAuthor] = useState(initial?.author ?? '')
  const [source, setSource] = useState(initial?.source ?? '')
  const [sourceUrl, setSourceUrl] = useState(initial?.source_url ?? '')
  const [category, setCategory] = useState(initial?.category ?? '')
  const [selectedTags, setSelectedTags] = useState<string[]>(initial?.scene_tags ?? [])
  const [planId, setPlanId] = useState<number | null>(initial?.writing_plan_id ?? null)

  const toggleTag = (v: string) =>
    setSelectedTags(prev => prev.includes(v) ? prev.filter(t => t !== v) : [...prev, v])

  const flat = flattenTopics(plans)

  async function handleSubmit() {
    if (!text.trim()) return
    await onSave({
      text: text.trim(), author, source, source_url: sourceUrl,
      category, scene_tags: selectedTags, writing_plan_id: planId,
    })
  }

  return (
    <div className="space-y-3">
      <textarea value={text} onChange={e => setText(e.target.value)} placeholder="参考文案 / 金句原文…"
        rows={3} autoFocus
        className="w-full px-3 py-2 border border-zinc-200 dark:border-zinc-700 rounded-lg bg-transparent outline-none focus:border-indigo-400 text-sm resize-none" />
      <div className="grid grid-cols-2 gap-2">
        <input value={author} onChange={e => setAuthor(e.target.value)} placeholder="作者（可选）"
          className="px-3 py-2 border border-zinc-200 dark:border-zinc-700 rounded-lg bg-transparent outline-none focus:border-indigo-400 text-xs" />
        <input value={source} onChange={e => setSource(e.target.value)} placeholder="出处（可选）"
          className="px-3 py-2 border border-zinc-200 dark:border-zinc-700 rounded-lg bg-transparent outline-none focus:border-indigo-400 text-xs" />
      </div>
      <input value={sourceUrl} onChange={e => setSourceUrl(e.target.value)} placeholder="链接（可选）"
        className="w-full px-3 py-2 border border-zinc-200 dark:border-zinc-700 rounded-lg bg-transparent outline-none focus:border-indigo-400 text-xs" />

      <div>
        <p className="text-xs text-zinc-500 mb-1.5">内容分类</p>
        <select value={category} onChange={e => setCategory(e.target.value)}
          className="w-full px-3 py-2 border border-zinc-200 dark:border-zinc-700 rounded-lg bg-transparent outline-none focus:border-indigo-400 text-xs text-zinc-600 dark:text-zinc-400">
          <option value="">未分类</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      <div>
        <p className="text-xs text-zinc-500 mb-1.5">使用场景</p>
        <div className="flex flex-wrap gap-1.5">
          {SCENE_TAGS.map(t => (
            <button key={t.value} onClick={() => toggleTag(t.value)}
              className={cn('text-xs px-2.5 py-1 rounded-full border transition-all',
                selectedTags.includes(t.value) ? cn(t.color, 'border-transparent')
                  : 'border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:border-zinc-300')}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {flat.length > 0 && (
        <select value={planId ?? ''} onChange={e => setPlanId(e.target.value ? Number(e.target.value) : null)}
          className="w-full px-3 py-2 border border-zinc-200 dark:border-zinc-700 rounded-lg bg-transparent outline-none focus:border-indigo-400 text-xs text-zinc-600 dark:text-zinc-400">
          <option value="">不关联写作方案</option>
          {flat.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
        </select>
      )}

      <div className="flex gap-2 pt-1">
        <Button onClick={handleSubmit} disabled={saving || !text.trim()} className="flex-1 gap-1">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
          {initial ? '保存修改' : '添加文案'}
        </Button>
        <Button variant="outline" onClick={onCancel}>取消</Button>
      </div>
    </div>
  )
}

// ── Collect-rules drawer ──────────────────────────────────────────────────────
function RulesDrawer({ rules, onClose, onChange, onAfterCollect }: {
  rules: CollectRule[]; onClose: () => void
  onChange: (rules: CollectRule[]) => void; onAfterCollect: () => void
}) {
  const [label, setLabel] = useState('')
  const [minFaves, setMinFaves] = useState(1500)
  const [lang, setLang] = useState('zh')
  const [days, setDays] = useState(2)
  const [rawQuery, setRawQuery] = useState('')
  const [busy, setBusy] = useState<number | 'all' | 'new' | null>(null)

  async function add() {
    if (busy) return
    setBusy('new')
    try {
      const r = await createRule({ label: label || '泛流量', min_faves: minFaves, lang, days, raw_query: rawQuery })
      onChange([r, ...rules]); setLabel(''); setRawQuery('')
      toast.success('已添加规则')
    } catch { toast.error('添加失败') } finally { setBusy(null) }
  }
  async function toggle(r: CollectRule) {
    try { const u = await updateRule(r.id, { enabled: !r.enabled }); onChange(rules.map(x => x.id === u.id ? u : x)) }
    catch { toast.error('更新失败') }
  }
  async function remove(r: CollectRule) {
    if (!confirm(`删除规则「${r.label}」？`)) return
    try { await deleteRule(r.id); onChange(rules.filter(x => x.id !== r.id)) }
    catch { toast.error('删除失败') }
  }
  async function runOne(r: CollectRule) {
    if (busy) return
    setBusy(r.id)
    try { const res = await collectRule(r.id); toast.success(`「${r.label}」新增 ${res.new_materials} 条`); onAfterCollect() }
    catch (e) { toast.error('采集失败：' + (e as Error).message) } finally { setBusy(null) }
  }
  async function runAll() {
    if (busy) return
    setBusy('all')
    try { const res = await collectAll(); toast.success(`全部采集：新增 ${res.new_materials} 条${res.failed.length ? `，${res.failed.length} 条规则失败` : ''}`); onAfterCollect() }
    catch (e) { toast.error('采集失败：' + (e as Error).message) } finally { setBusy(null) }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/20" />
      <div className="relative w-[420px] max-w-full h-full bg-white dark:bg-zinc-950 border-l border-zinc-200 dark:border-zinc-800 overflow-y-auto p-5 space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <Settings2 className="w-4 h-4 text-indigo-500" />
          <span className="font-semibold text-sm">采集规则（X 泛流量）</span>
          <Button size="sm" variant="outline" className="ml-auto gap-1" onClick={runAll} disabled={!!busy}>
            {busy === 'all' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />} 全部采集
          </Button>
        </div>

        {/* New rule */}
        <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg p-3 space-y-2">
          <input value={label} onChange={e => setLabel(e.target.value)} placeholder="规则名（如：中文泛流量·赞过1500）"
            className="w-full px-2 py-1.5 border border-zinc-200 dark:border-zinc-700 rounded bg-transparent text-xs outline-none focus:border-indigo-400" />
          <div className="grid grid-cols-3 gap-2">
            <label className="text-[10px] text-zinc-500">min_faves
              <input type="number" value={minFaves} onChange={e => setMinFaves(Number(e.target.value))}
                className="w-full px-2 py-1 border border-zinc-200 dark:border-zinc-700 rounded bg-transparent text-xs outline-none focus:border-indigo-400" />
            </label>
            <label className="text-[10px] text-zinc-500">lang
              <input value={lang} onChange={e => setLang(e.target.value)}
                className="w-full px-2 py-1 border border-zinc-200 dark:border-zinc-700 rounded bg-transparent text-xs outline-none focus:border-indigo-400" />
            </label>
            <label className="text-[10px] text-zinc-500">days
              <input type="number" value={days} onChange={e => setDays(Number(e.target.value))}
                className="w-full px-2 py-1 border border-zinc-200 dark:border-zinc-700 rounded bg-transparent text-xs outline-none focus:border-indigo-400" />
            </label>
          </div>
          <input value={rawQuery} onChange={e => setRawQuery(e.target.value)} placeholder="raw_query（可选，填了则覆盖上面）"
            className="w-full px-2 py-1.5 border border-zinc-200 dark:border-zinc-700 rounded bg-transparent text-xs outline-none focus:border-indigo-400" />
          <Button size="sm" className="w-full gap-1" onClick={add} disabled={!!busy}>
            {busy === 'new' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} 添加规则
          </Button>
        </div>

        {/* Rule list */}
        <div className="space-y-2">
          {rules.length === 0 && <p className="text-xs text-zinc-400 text-center py-4">还没有采集规则</p>}
          {rules.map(r => (
            <div key={r.id} className="border border-zinc-200 dark:border-zinc-800 rounded-lg p-3 text-xs space-y-1">
              <div className="flex items-center gap-2">
                <span className="font-medium text-zinc-700 dark:text-zinc-200">{r.label}</span>
                <button onClick={() => toggle(r)} className={cn('ml-auto px-1.5 py-0.5 rounded-full text-[10px]', r.enabled ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400' : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800')}>
                  {r.enabled ? '启用' : '停用'}
                </button>
              </div>
              <p className="text-zinc-400 break-all">{r.raw_query || `min_faves:${r.min_faves} lang:${r.lang} (近${r.days}天)`}</p>
              {r.last_error && <p className="text-red-500 break-all">err: {r.last_error}</p>}
              <div className="flex items-center gap-1 pt-1">
                <Button size="sm" variant="outline" className="h-6 gap-1 text-[11px]" onClick={() => runOne(r)} disabled={!!busy}>
                  {busy === r.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />} 立即采集
                </Button>
                <button onClick={() => remove(r)} className="ml-auto text-zinc-400 hover:text-red-500 p-1" title="删除"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────
export function MaterialsClient({ initialMaterials, categories, initialPlans }: {
  initialMaterials: Material[]; categories: string[]; initialPlans: WritingPlan[]
}) {
  const [materials, setMaterials] = useState<Material[]>(initialMaterials)
  const [plans] = useState<WritingPlan[]>(initialPlans)
  const [search, setSearch] = useState('')
  const [scene, setScene] = useState('')
  const [category, setCategory] = useState('')
  const [source, setSource] = useState<SourceFilter>('all')
  const [sort, setSort] = useState<SortKey>('time')
  const [refreshing, setRefreshing] = useState(false)

  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Material | null>(null)
  const [saving, setSaving] = useState(false)

  const [showRules, setShowRules] = useState(false)
  const [rules, setRules] = useState<CollectRule[]>([])

  const planMap = useMemo(
    () => Object.fromEntries(flattenTopics(plans).map(p => [p.id, p.title])),
    [plans],
  )

  const bySource = (m: Material) =>
    source === 'all' ? true : source === 'manual' ? isManual(m) : m.platform === 'x'

  const filtered = useMemo(() => {
    const out = materials.filter(m =>
      bySource(m) &&
      (!scene || m.scene_tags.includes(scene)) &&
      (!category || m.category === category) &&
      (!search || m.text.toLowerCase().includes(search.toLowerCase()) || (m.author || '').toLowerCase().includes(search.toLowerCase())),
    )
    const key = sort === 'score' ? (m: Material) => m.score
      : sort === 'views' ? (m: Material) => m.views
      : (m: Material) => Date.parse(m.created_at)
    return [...out].sort((a, b) => key(b) - key(a))
  }, [materials, source, scene, category, search, sort])

  async function refresh() {
    setRefreshing(true)
    try { setMaterials(await getMaterials({ limit: 500 })) }
    catch { toast.error('刷新失败') } finally { setRefreshing(false) }
  }

  async function handleCreate(data: MaterialCreate) {
    setSaving(true)
    try { const m = await createMaterial(data); setMaterials(prev => [m, ...prev]); setShowForm(false); toast.success('已添加') }
    catch { toast.error('添加失败') } finally { setSaving(false) }
  }
  async function handleUpdate(data: MaterialCreate) {
    if (!editing) return
    setSaving(true)
    try { const m = await updateMaterial(editing.id, data); setMaterials(prev => prev.map(x => x.id === m.id ? m : x)); setEditing(null); toast.success('已保存') }
    catch { toast.error('保存失败') } finally { setSaving(false) }
  }
  async function handleDelete(m: Material) {
    if (!confirm('确定删除这条参考文案？')) return
    try { await deleteMaterial(m.id); setMaterials(prev => prev.filter(x => x.id !== m.id)); toast.success('已删除') }
    catch { toast.error('删除失败') }
  }

  async function openRules() {
    setShowRules(true)
    try { setRules(await getRules()) } catch { toast.error('加载规则失败') }
  }

  const sceneCount = (v: string) => materials.filter(m => bySource(m) && m.scene_tags.includes(v)).length
  const catCount = (c: string) => materials.filter(m => bySource(m) && m.category === c).length

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Left filters */}
      <aside className="w-52 flex-shrink-0 border-r border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 flex flex-col overflow-y-auto">
        <div className="px-4 py-4 border-b border-zinc-100 dark:border-zinc-800 flex items-center gap-2">
          <QuoteIcon className="w-4 h-4 text-indigo-500" />
          <span className="font-semibold text-sm text-zinc-900 dark:text-zinc-100">参考文案库</span>
          <button onClick={refresh} disabled={refreshing} className="ml-auto text-zinc-400 hover:text-zinc-600 disabled:opacity-40">
            <RefreshCw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} />
          </button>
        </div>

        {/* Source */}
        <div className="px-3 py-3 border-b border-zinc-100 dark:border-zinc-800">
          <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider mb-2">来源</p>
          {([['all', '全部'], ['manual', '手工'], ['x', 'X 段子']] as [SourceFilter, string][]).map(([v, label]) => (
            <button key={v} onClick={() => setSource(v)}
              className={cn('w-full text-left text-xs px-2 py-1.5 rounded-md mb-0.5 transition-colors',
                source === v ? 'bg-indigo-50 dark:bg-indigo-950/30 text-indigo-700 dark:text-indigo-300 font-medium' : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-900')}>
              {label} <span className="text-zinc-400 ml-1">{v === 'all' ? materials.length : materials.filter(m => v === 'manual' ? isManual(m) : m.platform === 'x').length}</span>
            </button>
          ))}
        </div>

        {/* Scene tags */}
        <div className="px-3 py-3 border-b border-zinc-100 dark:border-zinc-800">
          <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider mb-2">使用场景</p>
          <button onClick={() => setScene('')}
            className={cn('w-full text-left text-xs px-2 py-1.5 rounded-md mb-0.5', !scene ? 'bg-indigo-50 dark:bg-indigo-950/30 text-indigo-700 dark:text-indigo-300 font-medium' : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-900')}>
            全部
          </button>
          {SCENE_TAGS.map(t => (
            <button key={t.value} onClick={() => setScene(scene === t.value ? '' : t.value)}
              className={cn('w-full text-left text-xs px-2 py-1.5 rounded-md mb-0.5 flex items-center gap-2',
                scene === t.value ? 'bg-indigo-50 dark:bg-indigo-950/30 text-indigo-700 dark:text-indigo-300 font-medium' : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-900')}>
              <span className={cn('w-2 h-2 rounded-full flex-shrink-0', t.color.split(' ')[0])} />
              {t.label}<span className="ml-auto text-zinc-400">{sceneCount(t.value)}</span>
            </button>
          ))}
        </div>

        {/* Categories */}
        <div className="px-3 py-3">
          <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider mb-2">内容分类</p>
          <button onClick={() => setCategory('')}
            className={cn('w-full text-left text-xs px-2 py-1.5 rounded-md mb-0.5', !category ? 'bg-indigo-50 dark:bg-indigo-950/30 text-indigo-700 dark:text-indigo-300 font-medium' : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-900')}>
            全部
          </button>
          {categories.map(c => (
            <button key={c} onClick={() => setCategory(category === c ? '' : c)}
              className={cn('w-full text-left text-xs px-2 py-1.5 rounded-md mb-0.5 flex items-center',
                category === c ? 'bg-indigo-50 dark:bg-indigo-950/30 text-indigo-700 dark:text-indigo-300 font-medium' : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-900')}>
              {c}<span className="ml-auto text-zinc-400">{catCount(c)}</span>
            </button>
          ))}
        </div>
      </aside>

      {/* Right content */}
      <div className="flex-1 flex flex-col overflow-hidden bg-zinc-50 dark:bg-zinc-950">
        <div className="flex items-center gap-3 px-6 py-3 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 flex-shrink-0">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-400" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索文案、作者…"
              className="w-full pl-8 pr-3 py-1.5 border border-zinc-200 dark:border-zinc-700 rounded-lg bg-transparent text-xs outline-none focus:border-indigo-400" />
          </div>
          <select value={sort} onChange={e => setSort(e.target.value as SortKey)}
            className="px-2 py-1.5 border border-zinc-200 dark:border-zinc-700 rounded-lg bg-transparent text-xs outline-none focus:border-indigo-400 text-zinc-600 dark:text-zinc-400">
            <option value="time">最新</option>
            <option value="score">段子分</option>
            <option value="views">流量</option>
          </select>
          <span className="text-xs text-zinc-400">{filtered.length} 条</span>
          <Button size="sm" variant="outline" className="gap-1 ml-auto" onClick={openRules}>
            <Settings2 className="w-3.5 h-3.5" /> 采集规则
          </Button>
          <Button size="sm" className="gap-1" onClick={() => { setShowForm(true); setEditing(null) }}>
            <Plus className="w-3.5 h-3.5" /> 添加文案
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {(showForm || editing) && (
            <div className="bg-white dark:bg-zinc-900 border border-indigo-200 dark:border-indigo-800 rounded-xl p-5 mb-6 shadow-sm">
              <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 mb-4">{editing ? '编辑文案' : '添加新文案'}</p>
              <MaterialForm initial={editing ?? undefined} plans={plans} categories={categories}
                onSave={editing ? handleUpdate : handleCreate}
                onCancel={() => { setShowForm(false); setEditing(null) }} saving={saving} />
            </div>
          )}

          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-zinc-400 gap-3">
              <QuoteIcon className="w-12 h-12 opacity-20" />
              <p className="text-sm">{search || scene || category ? '没有匹配的文案' : '还没有收录任何参考文案'}</p>
            </div>
          ) : (
            <div className="columns-1 sm:columns-2 lg:columns-3 gap-4 space-y-4">
              {filtered.map(m => (
                <div key={m.id} className="break-inside-avoid">
                  <MaterialCard m={m} planMap={planMap}
                    onEdit={x => { setEditing(x); setShowForm(false) }} onDelete={handleDelete} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {showRules && (
        <RulesDrawer rules={rules} onClose={() => setShowRules(false)} onChange={setRules} onAfterCollect={refresh} />
      )}
    </div>
  )
}
