'use client'

import { useState, useEffect } from 'react'
import { Plus, Trash2, Pencil, Check, X, Loader2, Power, PowerOff } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import {
  PublishAccount,
  PublishAccountInput,
  CoverStyle,
  listPublishAccounts,
  createPublishAccount,
  updatePublishAccount,
  deletePublishAccount,
} from '@/lib/api/publish-accounts'

const COVER_TYPE_OPTS      = ['', 'hero', 'conceptual', 'typography', 'metaphor', 'scene', 'minimal']
const COVER_PALETTE_OPTS   = ['', 'warm', 'elegant', 'cool', 'dark', 'earth', 'vivid', 'pastel', 'mono', 'retro', 'duotone', 'macaron']
const COVER_RENDERING_OPTS = ['', 'flat-vector', 'hand-drawn', 'painterly', 'digital', 'pixel', 'chalk', 'screen-print']
const COVER_TEXT_OPTS      = ['', 'none', 'title-only', 'title-subtitle', 'text-rich']
const COVER_MOOD_OPTS      = ['', 'subtle', 'balanced', 'bold']
const COVER_RATIO_OPTS     = ['', '16:9', '1:1', '2.35:1', '3:4', '4:3']

interface EditState {
  id: string
  name: string
  platform: string
  positioning: string
  audience: string
  tone: string
  topic_focus_text: string  // newline-separated
  taboo_text: string        // newline-separated
  word_range_json: string   // raw JSON
  image_style: string
  voice_samples_text: string  // blank-line-separated paragraphs
  style_rules_text: string    // newline-separated rules
  cover_style: CoverStyle
  cover_motifs_text: string   // newline-separated
  cover_negative_text: string // newline-separated
  is_active: boolean
}

const PLATFORM_OPTIONS = [
  { value: 'wechat',   label: '公众号' },
  { value: 'x',        label: 'X / Twitter' },
  { value: 'youtube',  label: 'YouTube' },
  { value: 'red_book', label: '小红书' },
  { value: 'douyin',   label: '抖音 / 视频号' },
  { value: 'other',    label: '其他' },
]

const PLATFORM_LABEL: Record<string, string> = Object.fromEntries(
  PLATFORM_OPTIONS.map(p => [p.value, p.label]),
)

const EMPTY_EDIT: EditState = {
  id: '',
  name: '',
  platform: 'wechat',
  positioning: '',
  audience: '',
  tone: '',
  topic_focus_text: '',
  taboo_text: '',
  word_range_json: '{"min": 1500, "max": 2200}',
  image_style: '',
  voice_samples_text: '',
  style_rules_text: '',
  cover_style: {},
  cover_motifs_text: '',
  cover_negative_text: '',
  is_active: true,
}

function accountToEdit(p: PublishAccount): EditState {
  return {
    id: p.id,
    name: p.name,
    platform: p.platform,
    positioning: p.positioning,
    audience: p.audience,
    tone: p.tone,
    topic_focus_text: (p.topic_focus ?? []).join('\n'),
    taboo_text: (p.taboo ?? []).join('\n'),
    word_range_json: JSON.stringify(p.word_range ?? {}, null, 0),
    image_style: p.image_style,
    voice_samples_text: (p.voice_samples ?? []).join('\n\n---\n\n'),
    style_rules_text: (p.style_rules ?? []).join('\n'),
    cover_style: p.cover_style ?? {},
    cover_motifs_text: (p.cover_style?.signature_motifs ?? []).join('\n'),
    cover_negative_text: (p.cover_style?.negative ?? []).join('\n'),
    is_active: p.is_active,
  }
}

function editToInput(form: EditState): PublishAccountInput | { error: string } {
  let word_range: Record<string, number> = {}
  if (form.word_range_json.trim()) {
    try {
      const parsed = JSON.parse(form.word_range_json)
      if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
        return { error: '字数范围必须是 JSON 对象（如 {"min":1500,"max":2200}）' }
      }
      word_range = parsed
    } catch {
      return { error: '字数范围 JSON 格式错误' }
    }
  }
  return {
    id: form.id.trim(),
    name: form.name.trim(),
    platform: form.platform,
    positioning: form.positioning,
    audience: form.audience,
    tone: form.tone,
    topic_focus: form.topic_focus_text.split('\n').map(s => s.trim()).filter(Boolean),
    taboo: form.taboo_text.split('\n').map(s => s.trim()).filter(Boolean),
    word_range,
    image_style: form.image_style,
    voice_samples: form.voice_samples_text.split(/\n\s*---\s*\n/).map(s => s.trim()).filter(Boolean),
    style_rules: form.style_rules_text.split('\n').map(s => s.trim()).filter(Boolean),
    cover_style: buildCoverStyle(form),
    is_active: form.is_active,
  }
}

function buildCoverStyle(form: EditState): CoverStyle {
  const cs: CoverStyle = {}
  const dims: (keyof CoverStyle)[] = ['type', 'palette', 'rendering', 'text', 'mood', 'aspect_ratio']
  for (const k of dims) {
    const v = form.cover_style[k]
    if (typeof v === 'string' && v.trim()) (cs as Record<string, unknown>)[k] = v.trim()
  }
  const motifs = form.cover_motifs_text.split('\n').map(s => s.trim()).filter(Boolean)
  if (motifs.length) cs.signature_motifs = motifs
  const neg = form.cover_negative_text.split('\n').map(s => s.trim()).filter(Boolean)
  if (neg.length) cs.negative = neg
  return cs
}

export function PublishAccountsSection() {
  const [accounts, setAccounts] = useState<PublishAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState<string | 'new' | null>(null)
  const [form, setForm] = useState<EditState>(EMPTY_EDIT)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    listPublishAccounts().then(setAccounts).finally(() => setLoading(false))
  }, [])

  function startNew() {
    setEditingId('new')
    setForm(EMPTY_EDIT)
  }

  function startEdit(p: PublishAccount) {
    setEditingId(p.id)
    setForm(accountToEdit(p))
  }

  function cancelEdit() {
    setEditingId(null)
    setForm(EMPTY_EDIT)
  }

  async function handleSave() {
    const result = editToInput(form)
    if ('error' in result) {
      toast.error(result.error)
      return
    }
    if (!result.id || !result.name) {
      toast.error('ID 和 名称 不能为空')
      return
    }
    if (editingId === 'new' && !/^[a-z0-9_-]+$/i.test(result.id)) {
      toast.error('ID 只能包含字母数字 - _')
      return
    }

    setSaving(true)
    try {
      if (editingId === 'new') {
        const created = await createPublishAccount(result)
        setAccounts(prev => [...prev, created])
        toast.success('账号已创建')
      } else if (editingId !== null) {
        // PATCH: 不传 id（不可改）
        const { id: _id, ...patch } = result
        const updated = await updatePublishAccount(editingId, patch)
        setAccounts(prev => prev.map(a => a.id === editingId ? updated : a))
        toast.success('账号已更新')
      }
      cancelEdit()
    } catch (e) {
      toast.error('保存失败：' + (e instanceof Error ? e.message : '未知错误'))
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(`删除账号 ${id}？此操作不可撤销。`)) return
    try {
      await deletePublishAccount(id)
      setAccounts(prev => prev.filter(a => a.id !== id))
      toast.success('已删除')
    } catch {
      toast.error('删除失败')
    }
  }

  async function toggleActive(p: PublishAccount) {
    try {
      const updated = await updatePublishAccount(p.id, { is_active: !p.is_active })
      setAccounts(prev => prev.map(a => a.id === p.id ? updated : a))
    } catch {
      toast.error('切换状态失败')
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-zinc-400">
        <Loader2 className="w-4 h-4 animate-spin" /> 加载中…
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-zinc-400 -mt-3">
        发布账号即你运营的对外内容账号（公众号/X 等）。Hermes agent 链路（scout→editor→writer→critic）
        会按任务 metadata 的 <code className="font-mono text-zinc-500">account_id</code> 读取该账号画像，
        所有产出都贴合此处填写的定位/调性/受众/禁区。
      </p>

      <div className="space-y-2">
        {accounts.map(p => (
          <div key={p.id} className="border border-zinc-200 dark:border-zinc-800 rounded-xl overflow-hidden">
            {editingId === p.id ? (
              <AccountForm form={form} setForm={setForm} onSave={handleSave} onCancel={cancelEdit} saving={saving} isNew={false} />
            ) : (
              <div className="px-4 py-3 flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                    <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{p.name}</span>
                    <span className="text-[10px] text-zinc-500 bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded-full font-mono">
                      {p.id}
                    </span>
                    <span className="text-[10px] text-indigo-600 bg-indigo-50 dark:bg-indigo-950 dark:text-indigo-400 px-1.5 py-0.5 rounded-full">
                      {PLATFORM_LABEL[p.platform] ?? p.platform}
                    </span>
                    {p.is_active ? (
                      <span className="text-[10px] text-emerald-600 bg-emerald-50 dark:bg-emerald-950 dark:text-emerald-400 px-1.5 py-0.5 rounded-full">
                        启用
                      </span>
                    ) : (
                      <span className="text-[10px] text-zinc-400 bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded-full">
                        停用
                      </span>
                    )}
                  </div>
                  {p.positioning && (
                    <p className="text-[11px] text-zinc-500 mb-1.5 line-clamp-2">{p.positioning}</p>
                  )}
                  <div className="flex flex-wrap gap-1">
                    {(p.topic_focus ?? []).map(t => (
                      <span key={t} className="text-[10px] text-zinc-600 dark:text-zinc-300 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 px-1.5 py-0.5 rounded">
                        {t}
                      </span>
                    ))}
                    {(p.taboo ?? []).map(t => (
                      <span key={'tb-' + t} className="text-[10px] text-red-500 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 px-1.5 py-0.5 rounded">
                        ⛔ {t}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    onClick={() => toggleActive(p)}
                    title={p.is_active ? '停用' : '启用'}
                    className="p-1.5 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors"
                  >
                    {p.is_active ? <Power className="w-3.5 h-3.5" /> : <PowerOff className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    onClick={() => startEdit(p)}
                    className="p-1.5 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => handleDelete(p.id)}
                    className="p-1.5 rounded-md hover:bg-red-50 dark:hover:bg-red-950 text-zinc-400 hover:text-red-500 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {editingId === 'new' && (
        <div className="border border-indigo-200 dark:border-indigo-800 rounded-xl overflow-hidden">
          <AccountForm form={form} setForm={setForm} onSave={handleSave} onCancel={cancelEdit} saving={saving} isNew />
        </div>
      )}

      {editingId === null && (
        <Button variant="outline" size="sm" className="gap-1.5" onClick={startNew}>
          <Plus className="w-3.5 h-3.5" /> 新增发布账号
        </Button>
      )}
    </div>
  )
}

function AccountForm({
  form, setForm, onSave, onCancel, saving, isNew,
}: {
  form: EditState
  setForm: (f: EditState) => void
  onSave: () => void
  onCancel: () => void
  saving: boolean
  isNew: boolean
}) {
  return (
    <div className="px-4 py-3 space-y-3 bg-zinc-50 dark:bg-zinc-900">
      <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{isNew ? '新增发布账号' : '编辑发布账号'}</p>

      <div className="grid grid-cols-3 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">ID {isNew ? '*' : '（不可改）'}</Label>
          <Input
            value={form.id}
            disabled={!isNew}
            onChange={e => setForm({ ...form, id: e.target.value })}
            placeholder="pub_tech_gzh"
            className="h-8 text-sm font-mono"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">名称 *</Label>
          <Input
            value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })}
            placeholder="硬核技术派"
            className="h-8 text-sm"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">平台</Label>
          <select
            value={form.platform}
            onChange={e => setForm({ ...form, platform: e.target.value })}
            className="h-8 w-full rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 text-sm"
          >
            {PLATFORM_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">定位（positioning）</Label>
        <p className="text-[11px] text-zinc-400">一句话说清这个号是什么、面向谁、提供什么价值</p>
        <textarea
          value={form.positioning}
          onChange={e => setForm({ ...form, positioning: e.target.value })}
          placeholder="面向资深工程师的深度技术分析号"
          rows={2}
          className={cn(
            'w-full resize-none rounded-lg border border-zinc-200 dark:border-zinc-700',
            'bg-white dark:bg-zinc-800 px-3 py-2 text-sm',
            'focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400',
          )}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">受众（audience）</Label>
          <Input
            value={form.audience}
            onChange={e => setForm({ ...form, audience: e.target.value })}
            placeholder="5年以上工龄的后端工程师"
            className="h-8 text-sm"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">调性（tone）</Label>
          <Input
            value={form.tone}
            onChange={e => setForm({ ...form, tone: e.target.value })}
            placeholder="克制、有结构、不堆砌术语"
            className="h-8 text-sm"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">选题方向（topic_focus，一行一个）</Label>
          <textarea
            value={form.topic_focus_text}
            onChange={e => setForm({ ...form, topic_focus_text: e.target.value })}
            placeholder={'分布式系统\n数据库内核\n开源项目剖析'}
            rows={4}
            className={cn(
              'w-full resize-none rounded-lg border border-zinc-200 dark:border-zinc-700',
              'bg-white dark:bg-zinc-800 px-3 py-2 text-sm',
              'focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400',
            )}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">禁区（taboo，一行一个）</Label>
          <textarea
            value={form.taboo_text}
            onChange={e => setForm({ ...form, taboo_text: e.target.value })}
            placeholder={'职场鸡汤\n面试技巧\n培训广告'}
            rows={4}
            className={cn(
              'w-full resize-none rounded-lg border border-zinc-200 dark:border-zinc-700',
              'bg-white dark:bg-zinc-800 px-3 py-2 text-sm',
              'focus:outline-none focus:ring-2 focus:ring-red-500/20 focus:border-red-400',
            )}
          />
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">字数范围（word_range，JSON 对象）</Label>
        <p className="text-[11px] text-zinc-400">
          公众号通常：<code className="font-mono">{`{"min":1500,"max":2200}`}</code>；
          X 短串：<code className="font-mono">{`{"posts_min":8,"posts_max":12,"per_post_max_chars":270}`}</code>
        </p>
        <Input
          value={form.word_range_json}
          onChange={e => setForm({ ...form, word_range_json: e.target.value })}
          placeholder='{"min":1500,"max":2200}'
          className="h-8 text-sm font-mono"
        />
      </div>

      <div className="space-y-1">
        <Label className="text-xs">配图风格（image_style）</Label>
        <textarea
          value={form.image_style}
          onChange={e => setForm({ ...form, image_style: e.target.value })}
          placeholder="极简示意图，纯文字示意优先，不要 stock photo"
          rows={2}
          className={cn(
            'w-full resize-none rounded-lg border border-zinc-200 dark:border-zinc-700',
            'bg-white dark:bg-zinc-800 px-3 py-2 text-sm',
            'focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400',
          )}
        />
      </div>

      <details className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800">
        <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-900">
          封面风格（cover_style）── 锁死封面的 5 维与签名元素
        </summary>
        <div className="px-3 py-3 space-y-3 border-t border-zinc-200 dark:border-zinc-700">
          <p className="text-[11px] text-zinc-400">
            填了之后 illustrator 直接照搬这套参数，不再凭 image_style 现场推断 —— 这是让同账号封面"看起来是一套的"关键。
            留空则回退到旧逻辑（按 image_style 翻译）。
          </p>

          <div className="grid grid-cols-3 gap-3">
            {([
              ['type',         '类型 type'],
              ['palette',      '配色 palette'],
              ['rendering',    '渲染 rendering'],
              ['text',         '文字 text'],
              ['mood',         '气氛 mood'],
              ['aspect_ratio', '长宽比 aspect'],
            ] as const).map(([key, label]) => {
              const opts = key === 'type' ? COVER_TYPE_OPTS
                : key === 'palette' ? COVER_PALETTE_OPTS
                : key === 'rendering' ? COVER_RENDERING_OPTS
                : key === 'text' ? COVER_TEXT_OPTS
                : key === 'mood' ? COVER_MOOD_OPTS
                : COVER_RATIO_OPTS
              return (
                <div key={key} className="space-y-1">
                  <Label className="text-xs">{label}</Label>
                  <select
                    value={form.cover_style[key] ?? ''}
                    onChange={e => setForm({ ...form, cover_style: { ...form.cover_style, [key]: e.target.value } })}
                    className="h-8 w-full rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 text-sm"
                  >
                    {opts.map(o => (
                      <option key={o} value={o}>{o || '(未设)'}</option>
                    ))}
                  </select>
                </div>
              )
            })}
          </div>

          <div className="space-y-1">
            <Label className="text-xs">视觉签名（signature_motifs，一行一个）</Label>
            <p className="text-[11px] text-zinc-400">
              每张封面都要出现的元素 ── 让 X 张封面有共同的"长相"。例：固定 mascot、固定背景肌理、固定角落构件
            </p>
            <textarea
              value={form.cover_motifs_text}
              onChange={e => setForm({ ...form, cover_motifs_text: e.target.value })}
              placeholder={'always include a small purple chunky lobster icon in lower-right corner\nthin 1px grid background, very subtle\ncream off-white base background #F5F0E6'}
              rows={4}
              className={cn(
                'w-full resize-none rounded-lg border border-zinc-200 dark:border-zinc-700',
                'bg-white dark:bg-zinc-800 px-3 py-2 text-sm',
                'focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400',
              )}
            />
          </div>

          <div className="space-y-1">
            <Label className="text-xs">禁止元素（negative，一行一个）</Label>
            <textarea
              value={form.cover_negative_text}
              onChange={e => setForm({ ...form, cover_negative_text: e.target.value })}
              placeholder={'no realistic humans\nno stock photo feel\nno dark/moody atmosphere'}
              rows={3}
              className={cn(
                'w-full resize-none rounded-lg border border-zinc-200 dark:border-zinc-700',
                'bg-white dark:bg-zinc-800 px-3 py-2 text-sm',
                'focus:outline-none focus:ring-2 focus:ring-red-500/20 focus:border-red-400',
              )}
            />
          </div>
        </div>
      </details>

      <div className="space-y-1">
        <Label className="text-xs">声音范文（voice_samples，多段用一行 <code className="font-mono">---</code> 分隔）</Label>
        <p className="text-[11px] text-zinc-400">
          贴 2-3 段你认可的、能代表此账号"该有的样子"的真实文字（自己写的、或目标作者的）。
          writer 会把它当 few-shot 模仿对象，比 tone 字段管用得多。
        </p>
        <textarea
          value={form.voice_samples_text}
          onChange={e => setForm({ ...form, voice_samples_text: e.target.value })}
          placeholder={'范文 1 的段落……\n\n---\n\n范文 2 的段落……'}
          rows={8}
          className={cn(
            'w-full resize-y rounded-lg border border-zinc-200 dark:border-zinc-700',
            'bg-white dark:bg-zinc-800 px-3 py-2 text-sm',
            'focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400',
          )}
        />
      </div>

      <div className="space-y-1">
        <Label className="text-xs">账号专属硬规则（style_rules，一行一条）</Label>
        <p className="text-[11px] text-zinc-400">
          覆盖在 SOUL 通用反 AI 规则之上的账号级约束。比如"用第一人称""禁问句开头""每段 ≤ 3 行"。
          writer 把它当硬约束，critic 把它当扣分依据。
        </p>
        <textarea
          value={form.style_rules_text}
          onChange={e => setForm({ ...form, style_rules_text: e.target.value })}
          placeholder={'用第一人称叙述\n禁用感叹号\n段落不超过 3 行\n允许使用「赛道」「估值」等行业词'}
          rows={4}
          className={cn(
            'w-full resize-none rounded-lg border border-zinc-200 dark:border-zinc-700',
            'bg-white dark:bg-zinc-800 px-3 py-2 text-sm',
            'focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400',
          )}
        />
      </div>

      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="pa_is_active"
          checked={form.is_active}
          onChange={e => setForm({ ...form, is_active: e.target.checked })}
          className="rounded"
        />
        <label htmlFor="pa_is_active" className="text-xs text-zinc-600 dark:text-zinc-400 cursor-pointer">
          启用（停用后不会出现在派单下拉里）
        </label>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" className="gap-1.5" onClick={onSave} disabled={saving}>
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
          保存
        </Button>
        <Button size="sm" variant="ghost" className="gap-1.5" onClick={onCancel}>
          <X className="w-3.5 h-3.5" /> 取消
        </Button>
      </div>
    </div>
  )
}
