'use client'
import { useEffect, useMemo, useState } from 'react'
import { Image as ImageIcon, LockKeyhole, Music, Pencil, Plus, Trash2, Video } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { createCreativeAsset, createCreativeAssetDirectory, createTopicSourceRule, creativeAssetUrl, deleteCreativeAsset, deleteCreativeAssetDirectory, listCreativeAssetDirectories, listTopicSourceRules, renameCreativeAssetDirectory, selectDailyArticleCandidates, updateCreativeAsset, type CreativeAsset, type CreativeAssetDirectory, type TopicSourceRule } from '@/lib/api/assets'
import { createJob } from '@/lib/api/jobs'
import { listXSubscriptions } from '@/lib/api/x'

type TypeTab = 'article' | 'media'
type MediaFilter = 'all' | 'image' | 'video' | 'audio'

export function AssetsClient({ initialAssets }: { initialAssets: CreativeAsset[] }) {
  const [assets, setAssets] = useState(initialAssets)
  const [type, setType] = useState<TypeTab>('article')
  const [directory, setDirectory] = useState('')
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>('all')
  const [selectedId, setSelectedId] = useState<number | null>(initialAssets[0]?.id ?? null)
  const [previewAsset, setPreviewAsset] = useState<CreativeAsset | null>(null)
  const [directories, setDirectories] = useState<CreativeAssetDirectory[]>([])
  const [topicRules, setTopicRules] = useState<TopicSourceRule[]>([])
  const [dailyCandidates, setDailyCandidates] = useState<CreativeAsset[]>([])
  const [articleDialog, setArticleDialog] = useState<{ item: CreativeAsset | null; content: string; url: string; error: string } | null>(null)
  const [directoryDialog, setDirectoryDialog] = useState<{ item: CreativeAssetDirectory | null; name: string; error: string } | null>(null)
  const [topicDialog, setTopicDialog] = useState<{ subscriptionId: string; keywords: string; error: string } | null>(null)
  const [topicSubscriptions, setTopicSubscriptions] = useState<Array<{ id: number; label: string }>>([])
  const [confirmDialog, setConfirmDialog] = useState<{ message: string; action: () => Promise<void> } | null>(null)
  const [messageDialog, setMessageDialog] = useState<string | null>(null)
  useEffect(() => { void listCreativeAssetDirectories(type).then(setDirectories) }, [type])
  useEffect(() => { void listTopicSourceRules().then(setTopicRules) }, [])
  const visible = useMemo(() => assets.filter(item => item.asset_type === type && (!directory || item.directory === directory) && (type !== 'media' || mediaFilter === 'all' || item.media_kind === mediaFilter)), [assets, type, directory, mediaFilter])
  const selected = visible.find(item => item.id === selectedId) ?? visible[0]
  const count = (value: string) => assets.filter(item => item.asset_type === type && (!value || item.directory === value)).length
  const tree = useMemo(() => { const walk = (parentId: number | null, depth = 0): Array<CreativeAssetDirectory & { depth: number }> => directories.filter(item => item.parent_id === parentId).flatMap(item => [{ ...item, depth }, ...walk(item.id, depth + 1)]); return walk(null) }, [directories])
  function addDirectory() { setDirectoryDialog({ item: null, name: '', error: '' }) }
  function editDirectory(item: CreativeAssetDirectory) { setDirectoryDialog({ item, name: item.name, error: '' }) }
  async function saveDirectory() { if (!directoryDialog) return; const name = directoryDialog.name.trim(); if (!name) { setDirectoryDialog(value => value ? { ...value, error: '请输入目录名称。' } : value); return }; if (directoryDialog.item) { const updated = await renameCreativeAssetDirectory(directoryDialog.item.id, name); setDirectories(items => items.map(value => value.id === updated.id ? updated : value)) } else { const parent = directories.find(item => item.name === directory) ?? null; const created = await createCreativeAssetDirectory(name, type, parent?.id ?? null); setDirectories(items => [...items, created]) }; setDirectoryDialog(null) }
  async function removeDirectory(item: CreativeAssetDirectory) {
    setConfirmDialog({ message: `删除目录“${item.name}”及其子目录？目录内资产会移回未分类。`, action: async () => { await deleteCreativeAssetDirectory(item.id)
    setDirectories(items => {
      const removed = new Set<number>([item.id])
      let changed = true
      while (changed) {
        changed = false
        for (const value of items) {
          if (value.parent_id !== null && removed.has(value.parent_id) && !removed.has(value.id)) {
            removed.add(value.id)
            changed = true
          }
        }
      }
      return items.filter(value => !removed.has(value.id))
    })
    if (directory === item.name) setDirectory('') } })
  }
  function openArticleDialog(item: CreativeAsset | null) { setArticleDialog({ item, content: item?.content ?? '', url: item?.url ?? '', error: '' }) }
  async function saveArticle() { if (!articleDialog) return; const content = articleDialog.content.trim(); if (!content) { setArticleDialog(value => value ? { ...value, error: '请输入原始内容。' } : value); return }; if (articleDialog.item) { const updated = await updateCreativeAsset(articleDialog.item.id, { content, url: articleDialog.url.trim() }); setAssets(items => items.map(value => value.id === updated.id ? updated : value)) } else { const created = await createCreativeAsset({ asset_type: 'article', media_kind: null, title: '', content, url: articleDialog.url.trim(), media_type: '', filename: '', directory, tags: [] }); setAssets(items => [created, ...items]); setSelectedId(created.id) }; setArticleDialog(null) }
  async function removeArticle(item: CreativeAsset) { setConfirmDialog({ message: '删除这条原始素材？', action: async () => { await deleteCreativeAsset(item.id); setAssets(items => items.filter(value => value.id !== item.id)); setSelectedId(null) } }) }
  async function configureTopicRule() { if (!directory) return; const subscriptions = await listXSubscriptions(); setTopicSubscriptions(subscriptions); setTopicDialog({ subscriptionId: subscriptions[0] ? String(subscriptions[0].id) : '', keywords: '', error: subscriptions.length ? '' : '没有可用的 X 订阅。' }) }
  async function saveTopicRule() { if (!topicDialog) return; const subscriptionId = Number(topicDialog.subscriptionId); if (!Number.isSafeInteger(subscriptionId) || subscriptionId <= 0) { setTopicDialog(value => value ? { ...value, error: '请选择 X 订阅。' } : value); return }; const created = await createTopicSourceRule({ subscription_id: subscriptionId, directory, keywords: topicDialog.keywords.split(/[,，]/).map(item => item.trim()).filter(Boolean) }); setTopicRules(items => [created, ...items]); setTopicDialog(null) }
  async function importTopicSources() { const rules = topicRules.filter(item => item.directory === directory && item.enabled); if (!rules.length) { setMessageDialog('请先为当前主题目录配置 X 入库规则。'); return } const now = Date.now(); await Promise.all(rules.map(rule => createJob({ flow: 'topic_source', title: `${directory}：X 主题素材甄选`, input: { rule_id: rule.id }, idempotency_key: `topic-source:${rule.id}:${now}` }))); setMessageDialog(`已提交 ${rules.length} 个 AI 甄选任务，可在“任务中心”查看进度。`) }
  async function showDailyCandidates() { if (!directory) { setMessageDialog('请先选择一个主题目录。'); return } const result = await selectDailyArticleCandidates(directory); setDailyCandidates(result.assets); if (!result.assets.length) setMessageDialog('当前主题没有尚未选用的素材。') }
  return <div className="flex h-full overflow-hidden bg-white dark:bg-zinc-950">
    <aside className="flex w-60 shrink-0 flex-col border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <div className="px-4 py-3"><h2 className="text-sm font-semibold">创作资产</h2></div>
      <div className="flex border-y border-zinc-200 dark:border-zinc-800">
        <button onClick={() => { setType('article'); setDirectory('') }} className={cn('flex-1 border-b-2 py-2.5 text-xs', type === 'article' ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-zinc-500')}>文章</button>
        <button onClick={() => { setType('media'); setDirectory('') }} className={cn('flex-1 border-b-2 py-2.5 text-xs', type === 'media' ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-zinc-500')}>多媒体</button>
      </div>
      <div className="flex items-center px-4 pt-4 pb-1 text-[11px] font-medium text-zinc-400">目录<button onClick={() => void addDirectory()} className="ml-auto text-indigo-500"><Plus className="h-3.5 w-3.5" /></button></div>
      <nav className="py-1">
        <button onClick={() => setDirectory('')} className={cn('flex w-full items-center px-4 py-2 text-left text-xs', !directory ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300' : 'text-zinc-600 hover:bg-zinc-50 dark:text-zinc-400 dark:hover:bg-zinc-800')}><span>全部资产</span><span className="ml-auto text-zinc-400">{count('')}</span></button>
        {tree.map(item => (
          <div key={item.id} className="group flex items-center" style={{ paddingLeft: `${item.depth * 14}px` }}>
            <button onClick={() => setDirectory(item.name)} className={cn('flex flex-1 items-center px-4 py-2 text-left text-xs', directory === item.name && 'bg-indigo-50 text-indigo-700')}>
              <span className="inline-flex items-center">
                {item.is_system ? <LockKeyhole aria-label="系统目录" className="mr-1 h-3 w-3" /> : <span aria-hidden="true">📁&nbsp;</span>}
                {item.name}
              </span>
              <span className="ml-auto text-zinc-400">{count(item.name)}</span>
            </button>
            {!item.is_system && (
              <span className="mr-2 hidden gap-1 group-hover:flex">
                <button aria-label={`重命名${item.name}`} onClick={() => void editDirectory(item)}><Pencil className="h-3 w-3" /></button>
                <button aria-label={`删除${item.name}`} className="text-red-500" onClick={() => void removeDirectory(item)}><Trash2 className="h-3 w-3" /></button>
              </span>
            )}
          </div>
        ))}
      </nav>
    </aside>
    <main className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-12 items-center gap-4 border-b border-zinc-200 px-6 dark:border-zinc-800"><span className="text-xs font-medium">{directory || '全部资产'}</span>{type === 'article' && <><button onClick={() => openArticleDialog(null)} className="text-xs text-indigo-600">新增素材</button>{directory && <><button onClick={() => void configureTopicRule()} className="text-xs text-zinc-600">配置 X 入库</button><button onClick={() => void importTopicSources()} className="text-xs text-zinc-600">AI 筛选入库</button><button onClick={() => void showDailyCandidates()} className="text-xs text-zinc-600">每日选 10 条</button><span className="text-[11px] text-zinc-400">{topicRules.filter(item => item.directory === directory && item.enabled).length} 个账号规则</span></>}</>}{type === 'media' && <div className="flex gap-3 text-xs text-zinc-500">{(['all','image','video','audio'] as MediaFilter[]).map(item => <button key={item} onClick={() => setMediaFilter(item)} className={cn(mediaFilter === item && 'font-medium text-indigo-600')}>{item === 'all' ? '全部' : item === 'image' ? '图片' : item === 'video' ? '视频' : '音频'}</button>)}</div>}<span className="ml-auto text-xs text-zinc-400">{visible.length} 项</span></div>
      <div className={cn('min-h-0 flex-1', type === 'article' && 'grid grid-cols-[minmax(0,1fr)_minmax(320px,.8fr)]')}><section className={cn('overflow-y-auto', type === 'article' ? 'divide-y divide-zinc-100 dark:divide-zinc-800' : 'grid grid-cols-3 content-start gap-3 p-4 md:grid-cols-6 xl:grid-cols-8')}>
        {type === 'article' ? visible.map(item => <button key={item.id} onClick={() => setSelectedId(item.id)} className={cn('block w-full px-6 py-4 text-left hover:bg-zinc-50 dark:hover:bg-zinc-900', selected?.id === item.id && 'bg-indigo-50/70 dark:bg-indigo-950/20')}><div className="flex items-center gap-2"><span className="text-sm font-medium">{item.title || item.content.slice(0, 36)}</span><span className="text-[10px] text-zinc-400">文章</span></div><p className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-500">{item.content}</p></button>) : visible.map(item => <button key={item.id} onClick={() => setSelectedId(item.id)} onDoubleClick={() => setPreviewAsset(item)} title="双击预览" className={cn('overflow-hidden rounded-lg border text-left transition-colors hover:border-indigo-300 hover:bg-indigo-50/30 dark:border-zinc-800 dark:hover:border-indigo-700', selected?.id === item.id && 'border-indigo-500 ring-1 ring-indigo-500')}>
          <div className="relative flex aspect-[4/3] items-center justify-center overflow-hidden bg-zinc-100 dark:bg-zinc-900">{item.media_kind === 'image' ? <img src={creativeAssetUrl(item.url)} alt={item.title} className="h-full w-full object-cover" /> : item.media_kind === 'video' ? <><video src={creativeAssetUrl(item.url)} className="h-full w-full object-cover" muted preload="metadata" /><span className="absolute rounded-full bg-black/55 p-2 text-white"><Video className="h-4 w-4" /></span></> : <div className="flex flex-col items-center gap-2 text-zinc-400"><Music className="h-8 w-8" /><span className="text-[11px]">音频</span></div>}</div>
          <div className="p-3"><p className="truncate text-xs font-medium text-zinc-800 dark:text-zinc-100">{item.title}</p><div className="mt-1 flex items-center gap-1 text-[10px] text-zinc-400">{item.media_kind === 'image' ? <ImageIcon className="h-3 w-3" /> : item.media_kind === 'video' ? <Video className="h-3 w-3" /> : <Music className="h-3 w-3" />}<span>{item.media_kind === 'image' ? '图片' : item.media_kind === 'video' ? '视频' : '音频'}</span></div></div>
        </button>)}
      </section>
      {type === 'article' && <aside className="overflow-y-auto border-l border-zinc-200 bg-zinc-50 p-6 dark:border-zinc-800 dark:bg-zinc-950">{selected ? <><div className="flex items-center gap-2"><h3 className="text-lg font-semibold">原始素材</h3><button onClick={() => openArticleDialog(selected)} className="ml-auto text-xs text-indigo-600">编辑</button><button onClick={() => void removeArticle(selected)} className="text-xs text-red-500">删除</button></div>{selected.url && <a href={selected.url} target="_blank" rel="noreferrer" className="mt-3 block truncate text-xs text-indigo-600">{selected.url}</a>}<p className="mt-5 whitespace-pre-wrap text-sm leading-7 text-zinc-700 dark:text-zinc-200">{selected.content}</p></> : <p className="text-sm text-zinc-400">当前目录没有资产。</p>}</aside>}</div>
    </main>
    <Dialog open={previewAsset !== null} onOpenChange={open => !open && setPreviewAsset(null)}>
      <DialogContent className="max-w-5xl p-4">
        <DialogHeader><DialogTitle>{previewAsset?.title}</DialogTitle><DialogDescription>双击多媒体资产打开预览。</DialogDescription></DialogHeader>
        {previewAsset?.media_kind === 'image' ? <img src={creativeAssetUrl(previewAsset.url)} alt={previewAsset.title} className="max-h-[75vh] w-full object-contain" /> : previewAsset?.media_kind === 'video' ? <video src={creativeAssetUrl(previewAsset.url)} controls autoPlay className="max-h-[75vh] w-full" /> : previewAsset?.media_kind === 'audio' ? <audio src={creativeAssetUrl(previewAsset.url)} controls autoPlay className="w-full" /> : null}
      </DialogContent>
    </Dialog>
    <Dialog open={articleDialog !== null} onOpenChange={open => !open && setArticleDialog(null)}>
      <DialogContent className="max-w-xl"><DialogHeader><DialogTitle>{articleDialog?.item ? '编辑文章素材' : '新增文章素材'}</DialogTitle><DialogDescription>保存原始内容，来源 URL 可留空。</DialogDescription></DialogHeader><div className="space-y-3"><Textarea autoFocus value={articleDialog?.content ?? ''} onChange={event => setArticleDialog(value => value ? { ...value, content: event.target.value, error: '' } : value)} placeholder="粘贴原始文章内容" className="min-h-48" /><Input value={articleDialog?.url ?? ''} onChange={event => setArticleDialog(value => value ? { ...value, url: event.target.value } : value)} placeholder="来源 URL（可留空）" />{articleDialog?.error && <p className="text-xs text-red-500">{articleDialog.error}</p>}</div><DialogFooter><Button variant="outline" onClick={() => setArticleDialog(null)}>取消</Button><Button onClick={() => void saveArticle()}>保存</Button></DialogFooter></DialogContent>
    </Dialog>
    <Dialog open={directoryDialog !== null} onOpenChange={open => !open && setDirectoryDialog(null)}><DialogContent><DialogHeader><DialogTitle>{directoryDialog?.item ? '重命名目录' : '新增目录'}</DialogTitle></DialogHeader><Input autoFocus value={directoryDialog?.name ?? ''} onChange={event => setDirectoryDialog(value => value ? { ...value, name: event.target.value, error: '' } : value)} placeholder="目录名称" />{directoryDialog?.error && <p className="text-xs text-red-500">{directoryDialog.error}</p>}<DialogFooter><Button variant="outline" onClick={() => setDirectoryDialog(null)}>取消</Button><Button onClick={() => void saveDirectory()}>保存</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={topicDialog !== null} onOpenChange={open => !open && setTopicDialog(null)}><DialogContent><DialogHeader><DialogTitle>配置 X 入库规则</DialogTitle><DialogDescription>选择订阅并填写可选关键词。</DialogDescription></DialogHeader><select value={topicDialog?.subscriptionId ?? ''} onChange={event => setTopicDialog(value => value ? { ...value, subscriptionId: event.target.value, error: '' } : value)} className="h-8 w-full rounded-lg border bg-transparent px-2 text-sm">{topicSubscriptions.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select><Input value={topicDialog?.keywords ?? ''} onChange={event => setTopicDialog(value => value ? { ...value, keywords: event.target.value } : value)} placeholder="主题关键词（逗号分隔，可留空）" />{topicDialog?.error && <p className="text-xs text-red-500">{topicDialog.error}</p>}<DialogFooter><Button variant="outline" onClick={() => setTopicDialog(null)}>取消</Button><Button onClick={() => void saveTopicRule()}>保存</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={confirmDialog !== null} onOpenChange={open => !open && setConfirmDialog(null)}><DialogContent><DialogHeader><DialogTitle>确认操作</DialogTitle><DialogDescription>{confirmDialog?.message}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setConfirmDialog(null)}>取消</Button><Button variant="destructive" onClick={() => { const action = confirmDialog?.action; setConfirmDialog(null); if (action) void action() }}>确认</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={messageDialog !== null} onOpenChange={open => !open && setMessageDialog(null)}><DialogContent><DialogHeader><DialogTitle>提示</DialogTitle><DialogDescription>{messageDialog}</DialogDescription></DialogHeader><DialogFooter><Button onClick={() => setMessageDialog(null)}>知道了</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={dailyCandidates.length > 0} onOpenChange={open => !open && setDailyCandidates([])}>
      <DialogContent className="max-w-2xl"><DialogHeader><DialogTitle>今日二次创作候选</DialogTitle><DialogDescription>从“{directory}”中选出的前 10 条原始素材。</DialogDescription></DialogHeader><div className="max-h-[55vh] space-y-3 overflow-y-auto">{dailyCandidates.map((item, index) => <button key={item.id} onClick={() => { setSelectedId(item.id); setDailyCandidates([]) }} className="block w-full rounded border border-zinc-200 p-3 text-left text-sm hover:bg-zinc-50"><span className="mr-2 text-xs text-zinc-400">{index + 1}</span>{item.content}</button>)}</div></DialogContent>
    </Dialog>
  </div>
}
