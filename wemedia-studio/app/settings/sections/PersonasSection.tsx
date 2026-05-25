'use client'

import { useState, useEffect } from 'react'
import { Plus, Trash2, Pencil, Check, X, Loader2, Star } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import {
  WriterPersona,
  getPersonas,
  createPersona,
  updatePersona,
  deletePersona,
} from '@/lib/api/personas'

interface EditState {
  name: string
  description: string
  prompt: string
  model: string
  is_default: boolean
}

const EMPTY_EDIT: EditState = { name: '', description: '', prompt: '', model: '', is_default: false }

export function PersonasSection() {
  const [personas, setPersonas] = useState<WriterPersona[]>([])
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState<number | 'new' | null>(null)
  const [form, setForm] = useState<EditState>(EMPTY_EDIT)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    getPersonas().then(setPersonas).finally(() => setLoading(false))
  }, [])

  function startNew() {
    setEditingId('new')
    setForm(EMPTY_EDIT)
  }

  function startEdit(p: WriterPersona) {
    setEditingId(p.id)
    setForm({ name: p.name, description: p.description, prompt: p.prompt, model: p.model ?? '', is_default: p.is_default })
  }

  function cancelEdit() {
    setEditingId(null)
    setForm(EMPTY_EDIT)
  }

  async function handleSave() {
    if (!form.name.trim() || !form.prompt.trim()) {
      toast.error('名称和创作指令不能为空')
      return
    }
    setSaving(true)
    try {
      if (editingId === 'new') {
        const created = await createPersona(form)
        setPersonas(prev => [...prev, created])
        toast.success('写手已创建')
      } else if (editingId !== null) {
        const updated = await updatePersona(editingId, form)
        setPersonas(prev => prev.map(p => p.id === editingId ? updated : p))
        toast.success('写手已更新')
      }
      cancelEdit()
    } catch {
      toast.error('保存失败')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: number) {
    try {
      await deletePersona(id)
      setPersonas(prev => prev.filter(p => p.id !== id))
      toast.success('已删除')
    } catch {
      toast.error('删除失败')
    }
  }

  if (loading) {
    return <div className="flex items-center gap-2 text-sm text-zinc-400"><Loader2 className="w-4 h-4 animate-spin" /> 加载中…</div>
  }

  return (
    <div className="space-y-4">
      {/* Persona list */}
      <div className="space-y-2">
        {personas.map(p => (
          <div key={p.id} className="border border-zinc-200 dark:border-zinc-800 rounded-xl overflow-hidden">
            {editingId === p.id ? (
              <PersonaForm form={form} setForm={setForm} onSave={handleSave} onCancel={cancelEdit} saving={saving} />
            ) : (
              <div className="px-4 py-3 flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{p.name}</span>
                    {p.is_default && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] text-amber-600 bg-amber-50 dark:bg-amber-950 dark:text-amber-400 px-1.5 py-0.5 rounded-full">
                        <Star className="w-2.5 h-2.5" /> 默认
                      </span>
                    )}
                    {p.model && (
                      <span className="text-[10px] text-indigo-600 bg-indigo-50 dark:bg-indigo-950 dark:text-indigo-400 px-1.5 py-0.5 rounded-full font-mono">
                        {p.model}
                      </span>
                    )}
                  </div>
                  {p.description && (
                    <p className="text-[11px] text-zinc-400 mb-1">{p.description}</p>
                  )}
                  <p className="text-xs text-zinc-500 line-clamp-2 font-mono bg-zinc-50 dark:bg-zinc-900 rounded px-2 py-1">
                    {p.prompt}
                  </p>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
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

      {/* New persona form */}
      {editingId === 'new' && (
        <div className="border border-indigo-200 dark:border-indigo-800 rounded-xl overflow-hidden">
          <PersonaForm form={form} setForm={setForm} onSave={handleSave} onCancel={cancelEdit} saving={saving} isNew />
        </div>
      )}

      {editingId === null && (
        <Button variant="outline" size="sm" className="gap-1.5" onClick={startNew}>
          <Plus className="w-3.5 h-3.5" /> 新增写手
        </Button>
      )}
    </div>
  )
}

function PersonaForm({
  form,
  setForm,
  onSave,
  onCancel,
  saving,
  isNew = false,
}: {
  form: EditState
  setForm: (f: EditState) => void
  onSave: () => void
  onCancel: () => void
  saving: boolean
  isNew?: boolean
}) {
  return (
    <div className="px-4 py-3 space-y-3 bg-zinc-50 dark:bg-zinc-900">
      <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{isNew ? '新增写手' : '编辑写手'}</p>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">名称 *</Label>
          <Input
            value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })}
            placeholder="例：公众号深度"
            className="h-8 text-sm"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">简介</Label>
          <Input
            value={form.description}
            onChange={e => setForm({ ...form, description: e.target.value })}
            placeholder="可选，一句话描述风格"
            className="h-8 text-sm"
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">模型</Label>
        <Input
          value={form.model}
          onChange={e => setForm({ ...form, model: e.target.value })}
          placeholder="留空则使用全局设置，例：gpt-4o / claude-opus-4-7"
          className="h-8 text-sm font-mono"
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">创作指令 *</Label>
        <p className="text-[11px] text-zinc-400">描述写手风格、文章要求，作为创作指令（非系统提示词）随用户请求一起发送给模型</p>
        <textarea
          value={form.prompt}
          onChange={e => setForm({ ...form, prompt: e.target.value })}
          placeholder="例：你是一位专业的中文科技公众号作者，擅长深度分析。请撰写1500-2000字的原创文章，结构清晰，专业易读…"
          rows={6}
          className={cn(
            'w-full resize-none rounded-lg border border-zinc-200 dark:border-zinc-700',
            'bg-white dark:bg-zinc-800 px-3 py-2 text-sm font-mono',
            'placeholder:text-zinc-300 dark:placeholder:text-zinc-600',
            'focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400',
          )}
        />
      </div>
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="is_default"
          checked={form.is_default}
          onChange={e => setForm({ ...form, is_default: e.target.checked })}
          className="rounded"
        />
        <label htmlFor="is_default" className="text-xs text-zinc-600 dark:text-zinc-400 cursor-pointer">
          设为默认写手（撰写时预先选中）
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
