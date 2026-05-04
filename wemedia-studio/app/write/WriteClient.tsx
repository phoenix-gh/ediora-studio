'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Topic } from '@/lib/types'
import {
  ArticleDraft,
  DraftStatus,
  createArticleDraft,
  generateArticleDraft,
  getArticleDrafts,
  updateArticleDraft,
} from '@/lib/api/write'
import { getPersonas, WriterPersona } from '@/lib/api/personas'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { UrgencyBadge } from '@/components/features/UrgencyBadge'
import { ScoreStars } from '@/components/features/ScoreStars'
import { Sparkles, Copy, Check, ChevronDown, Star, ExternalLink, FileText, Save } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

function WordCount({ text }: { text: string }) {
  const count = text.replace(/\s/g, '').length
  return (
    <span className="text-xs text-zinc-400 tabular-nums">
      {count.toLocaleString()} 字
    </span>
  )
}

const draftStatusOptions: { value: DraftStatus; label: string }[] = [
  { value: 'drafting', label: '起草中' },
  { value: 'editing', label: '修改中' },
  { value: 'ready', label: '待发布' },
  { value: 'published', label: '已发布' },
]

function formatTime(iso?: string) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function draftTitleFromContent(content: string, fallback: string) {
  const first = content.split('\n').map(line => line.replace(/^#+\s*/, '').trim()).find(Boolean)
  return (first || fallback).slice(0, 120)
}

interface Props {
  topic: Topic | null
  acceptedTopics: Topic[]
}

export function WriteClient({ topic: initialTopic, acceptedTopics }: Props) {
  const router = useRouter()
  const [topic, setTopic] = useState(initialTopic)
  const [draft, setDraft] = useState('')
  const [draftRecord, setDraftRecord] = useState<ArticleDraft | null>(null)
  const [draftStatus, setDraftStatus] = useState<DraftStatus>('drafting')
  const [generating, setGenerating] = useState(false)
  const [copied, setCopied] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [showTopicPicker, setShowTopicPicker] = useState(false)

  const [personas, setPersonas] = useState<WriterPersona[]>([])
  const [selectedPersonaId, setSelectedPersonaId] = useState<number | null>(null)
  const [showPersonaPicker, setShowPersonaPicker] = useState(false)
  const lastSavedContent = useRef('')
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    getPersonas().then(list => {
      setPersonas(list)
      const def = list.find(p => p.is_default)
      if (def) setSelectedPersonaId(def.id)
    })
  }, [])

  const selectedPersona = personas.find(p => p.id === selectedPersonaId)
  const topicId = topic?.id

  useEffect(() => {
    if (!topicId) return
    let cancelled = false
    getArticleDrafts(topicId).then(list => {
      if (cancelled) return
      const latest = list[0] ?? null
      setDraftRecord(latest)
      setDraft(latest?.content ?? '')
      setDraftStatus(latest?.status ?? 'drafting')
      if (latest?.persona_id) setSelectedPersonaId(latest.persona_id)
      lastSavedContent.current = latest?.content ?? ''
    }).catch(() => {
      if (!cancelled) toast.error('草稿加载失败')
    })
    return () => { cancelled = true }
  }, [topicId])

  useEffect(() => {
    if (!topic || generating) return
    if (!draft.trim()) return
    if (draft === lastSavedContent.current) return

    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      setSaveState('saving')
      try {
        const title = draftTitleFromContent(draft, topic.title)
        const saved = draftRecord
          ? await updateArticleDraft(draftRecord.id, { content: draft, title, status: draftStatus, persona_id: selectedPersonaId })
          : await createArticleDraft({ topic_id: topic.id, content: draft, title, status: draftStatus, persona_id: selectedPersonaId })
        setDraftRecord(saved)
        lastSavedContent.current = saved.content
        setSaveState('saved')
      } catch {
        setSaveState('error')
      }
    }, 900)

    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [draft, draftRecord, draftStatus, generating, selectedPersonaId, topic])

  async function handleGenerate() {
    if (!topic) return
    setGenerating(true)
    try {
      const res = await generateArticleDraft(topic.id, selectedPersonaId ?? undefined)
      const saved: ArticleDraft = {
        id: res.id,
        topic_id: res.topic_id,
        title: res.title,
        content: res.content || res.draft,
        status: res.status,
        persona_id: res.persona_id,
        version: res.version,
        created_at: res.created_at,
        updated_at: res.updated_at,
      }
      setDraftRecord(saved)
      setDraft(saved.content)
      setDraftStatus(saved.status)
      lastSavedContent.current = saved.content
      setSaveState('saved')
      toast.success('草稿已生成，请按需修改')
    } catch {
      toast.error('生成失败，请检查 AI 配置')
    } finally {
      setGenerating(false)
    }
  }

  async function handleCopy() {
    await navigator.clipboard.writeText(draft)
    setCopied(true)
    toast.success('已复制到剪贴板')
    setTimeout(() => setCopied(false), 2000)
  }

  function selectTopic(t: Topic) {
    setTopic(t)
    setDraft('')
    setDraftRecord(null)
    setDraftStatus('drafting')
    lastSavedContent.current = ''
    setShowTopicPicker(false)
    router.push(`/write?topicId=${t.id}`)
  }

  async function changeStatus(status: DraftStatus) {
    setDraftStatus(status)
    if (!topic) return
    try {
      const title = draftTitleFromContent(draft, topic.title)
      const saved = draftRecord
        ? await updateArticleDraft(draftRecord.id, { status, content: draft, title, persona_id: selectedPersonaId })
        : await createArticleDraft({ topic_id: topic.id, status, content: draft, title, persona_id: selectedPersonaId })
      setDraftRecord(saved)
      lastSavedContent.current = saved.content
      setSaveState('saved')
      toast.success(`状态已更新为「${draftStatusOptions.find(x => x.value === status)?.label}」`)
    } catch {
      setSaveState('error')
      toast.error('状态更新失败')
    }
  }

  if (!topic && acceptedTopics.length === 0) {
    return (
      <div className="px-8 py-8">
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100 mb-2">撰写文章</h1>
        <div className="text-center py-24 text-zinc-400">
          <p className="text-sm mb-2">还没有已采纳的选题</p>
          <p className="text-xs">在「选题决策流」中采纳一个选题后，就可以在这里起草文章</p>
        </div>
      </div>
    )
  }

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">撰写文章</h1>
          <p className="text-xs text-zinc-400 mt-1">
            {draftRecord ? `草稿 #${draftRecord.id} · v${draftRecord.version} · ${formatTime(draftRecord.updated_at)}` : '尚未保存草稿'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {draft && <WordCount text={draft} />}
          <span className={cn(
            'inline-flex items-center gap-1 text-xs',
            saveState === 'error' ? 'text-red-500' : saveState === 'saving' ? 'text-amber-500' : 'text-zinc-400'
          )}>
            <Save className="w-3.5 h-3.5" />
            {saveState === 'saving' ? '保存中' : saveState === 'error' ? '保存失败' : draftRecord ? '已自动保存' : '等待输入'}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-[280px_minmax(0,1fr)_300px] gap-4 items-start">
        <aside className="sticky top-6 space-y-3">
          <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              {topic && <UrgencyBadge urgency={topic.urgency} />}
              {topic && <ScoreStars score={topic.score} />}
            </div>
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 leading-snug">
              {topic?.title ?? '请选择一个选题'}
            </h2>
            {topic && <p className="text-xs text-zinc-500 leading-relaxed mt-2">{topic.summary}</p>}
            {acceptedTopics.length > 1 && (
              <div className="relative mt-3">
                <Button variant="outline" size="sm" className="gap-1 text-xs w-full" onClick={() => setShowTopicPicker(v => !v)}>
                  切换选题 <ChevronDown className="w-3 h-3" />
                </Button>
                {showTopicPicker && (
                  <div className="absolute left-0 right-0 top-full mt-1 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-lg z-10 overflow-hidden">
                    {acceptedTopics.map(t => (
                      <button
                        key={t.id}
                        onClick={() => selectTopic(t)}
                        className={cn(
                          'w-full text-left px-3 py-2.5 text-xs hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors',
                          t.id === topic?.id && 'bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400'
                        )}
                      >
                        <p className="font-medium line-clamp-1">{t.title}</p>
                        <p className="text-zinc-400 mt-0.5 line-clamp-1">{t.category}</p>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4">
            <p className="text-xs font-medium text-zinc-500 mb-2">写作状态</p>
            <div className="grid grid-cols-2 gap-1.5">
              {draftStatusOptions.map(option => (
                <button
                  key={option.value}
                  onClick={() => changeStatus(option.value)}
                  className={cn(
                    'rounded-md border px-2 py-1.5 text-xs transition-colors',
                    draftStatus === option.value
                      ? 'border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-300'
                      : 'border-zinc-200 text-zinc-500 hover:border-zinc-300 dark:border-zinc-800'
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {topic?.recommendReason && (
            <div className="bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-100 dark:border-indigo-900 rounded-xl p-4">
              <p className="text-xs font-medium text-indigo-700 dark:text-indigo-300 mb-1">推荐理由</p>
              <p className="text-xs text-indigo-700/80 dark:text-indigo-300/80 leading-relaxed">{topic.recommendReason}</p>
            </div>
          )}
        </aside>

        <main className="min-w-0">
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            {personas.length > 0 && (
              <div className="relative">
                <button
                  onClick={() => setShowPersonaPicker(v => !v)}
                  className={cn(
                    'flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors',
                    selectedPersona
                      ? 'border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-300'
                      : 'border-zinc-200 bg-white text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400'
                  )}
                >
                  {selectedPersona?.is_default && <Star className="w-3 h-3" />}
                  {selectedPersona?.name ?? '选择写手'}
                  <ChevronDown className="w-3 h-3" />
                </button>
                {showPersonaPicker && (
                  <div className="absolute left-0 top-full mt-1 w-56 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-lg z-10 overflow-hidden">
                    {personas.map(p => (
                      <button
                        key={p.id}
                        onClick={() => { setSelectedPersonaId(p.id); setShowPersonaPicker(false) }}
                        className={cn(
                          'w-full text-left px-3 py-2.5 text-xs hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors',
                          p.id === selectedPersonaId && 'bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400'
                        )}
                      >
                        <div className="flex items-center gap-1">
                          {p.is_default && <Star className="w-2.5 h-2.5 text-amber-500" />}
                          <span className="font-medium">{p.name}</span>
                        </div>
                        {p.description && <p className="text-zinc-400 mt-0.5 truncate">{p.description}</p>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <Button onClick={handleGenerate} disabled={!topic || generating} className="gap-1.5">
              <Sparkles className="w-3.5 h-3.5" />
              {generating ? 'AI 起草中…' : draft ? '重新生成草稿' : 'AI 起草文章'}
            </Button>

            {draft && (
              <Button variant="outline" size="sm" className="gap-1.5" onClick={handleCopy}>
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? '已复制' : '复制全文'}
              </Button>
            )}
          </div>

          {generating ? (
            <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 space-y-3">
              {[80, 60, 90, 70, 85, 65].map((w, i) => (
                <Skeleton key={i} className="h-4 rounded" style={{ width: `${w}%` }} />
              ))}
            </div>
          ) : (
            <textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              placeholder={topic ? '点击「AI 起草文章」生成初稿，或直接在此处开始写作，内容会自动保存。' : '请先选择一个已采纳的选题'}
              className={cn(
                'w-full min-h-[70vh] resize-none rounded-xl border border-zinc-200 dark:border-zinc-800',
                'bg-white dark:bg-zinc-900 p-5 text-sm text-zinc-800 dark:text-zinc-200',
                'leading-relaxed placeholder:text-zinc-300 dark:placeholder:text-zinc-600',
                'focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400',
                'font-mono'
              )}
            />
          )}
        </main>

        <aside className="sticky top-6 space-y-3">
          <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <FileText className="w-4 h-4 text-zinc-400" />
              <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400">信源证据</p>
              <span className="ml-auto text-xs text-zinc-400">{topic?.sources.length ?? 0}</span>
            </div>
            <div className="space-y-2">
              {topic?.sources.length ? topic.sources.map((source, index) => (
                <a
                  key={source.id || source.url || index}
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block rounded-lg border border-zinc-100 dark:border-zinc-800 px-3 py-2 hover:border-indigo-200 dark:hover:border-indigo-800 transition-colors"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0">{source.platform || '来源'}</Badge>
                    <ExternalLink className="w-3 h-3 text-zinc-300 ml-auto" />
                  </div>
                  <p className="text-xs text-zinc-700 dark:text-zinc-300 leading-snug line-clamp-2">
                    {source.title || source.url}
                  </p>
                </a>
              )) : (
                <p className="text-xs text-zinc-400 leading-relaxed">当前选题没有结构化信源。建议补齐原文链接后再生成正式稿。</p>
              )}
            </div>
          </div>

          <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4">
            <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-2">标签</p>
            <div className="flex flex-wrap gap-1.5">
              {topic?.tags.map(tag => (
                <Badge key={tag} variant="secondary" className="text-[11px] font-normal px-2 py-0.5">{tag}</Badge>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
