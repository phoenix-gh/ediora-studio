'use client'

import { useState, useMemo } from 'react'
import { FileText, ExternalLink, Download, RefreshCw, Search, ChevronDown, ChevronUp } from 'lucide-react'
import { toast } from 'sonner'
import { Paper, getPapers, collectPapers } from '@/lib/api/papers'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { AddToTopicPopover } from '@/components/features/AddToTopicPopover'

const CATEGORIES = ['全部', 'cs.AI', 'cs.CL', 'cs.CV', 'cs.LG', 'cs.RO', 'stat.ML']

const CATEGORY_CN: Record<string, string> = {
  'cs.AI': '人工智能', 'cs.CL': '计算语言学', 'cs.CV': '计算机视觉',
  'cs.LG': '机器学习', 'cs.RO': '机器人学', 'stat.ML': '统计机器学习',
  'cs.HC': '人机交互', 'cs.IR': '信息检索', 'cs.NE': '神经进化计算',
  'cs.SE': '软件工程', 'cs.CR': '密码与安全', 'cs.DB': '数据库',
  'cs.DC': '分布式计算', 'cs.DS': '数据结构', 'cs.GT': '博弈论',
  'cs.MA': '多智能体', 'cs.MM': '多媒体', 'cs.NI': '网络架构',
  'cs.OS': '操作系统', 'cs.PL': '编程语言', 'cs.CY': '计算与社会',
  'cs.CE': '计算工程', 'cs.CG': '计算几何', 'cs.GR': '计算机图形学',
  'cs.IT': '信息论', 'cs.SI': '社交网络', 'cs.SC': '符号计算',
  'cs.NA': '数值分析', 'cs.PF': '性能分析', 'cs.AR': '体系结构',
  'eess.AS': '音频处理', 'eess.IV': '图像与视频', 'eess.SP': '信号处理',
  'eess.SY': '系统控制', 'math.OC': '优化与控制', 'math.ST': '统计理论',
  'physics.comp-ph': '计算物理', 'q-bio.QM': '定量方法', 'q-bio.NC': '神经科学',
  'q-fin.ST': '统计金融', 'stat.AP': '应用统计', 'stat.ME': '统计方法',
}

function catLabel(code: string) {
  const cn = CATEGORY_CN[code]
  return cn ? `${code} / ${cn}` : code
}
const DAYS_OPTIONS = [1, 3, 7, 14, 30]

function PaperCard({ paper }: { paper: Paper }) {
  const [expanded, setExpanded] = useState(false)
  const authors = paper.authors.length > 3
    ? paper.authors.slice(0, 3).join(', ') + ` 等 ${paper.authors.length} 人`
    : paper.authors.join(', ')
  const date = new Date(paper.submitted_at).toLocaleDateString('zh-CN', {
    month: 'short', day: 'numeric',
  })
  const titleCn = paper.title_cn || paper.title
  const abstractCn = (paper.abstract_cn || paper.abstract || '').replace(/\s+/g, ' ').trim()
  const shortAbstractCn = abstractCn.length > 200 ? abstractCn.slice(0, 200) + '…' : abstractCn

  return (
    <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 hover:border-zinc-300 dark:hover:border-zinc-700 transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <a
            href={paper.arxiv_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium text-zinc-900 dark:text-zinc-100 hover:text-indigo-600 dark:hover:text-indigo-400 line-clamp-2 leading-snug"
          >
            {titleCn}
          </a>
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <span className="text-[11px] text-zinc-400">{date}</span>
            {authors && <span className="text-[11px] text-zinc-400 truncate max-w-[280px]">{authors}</span>}
          </div>
          <div className="flex gap-1 mt-2 flex-wrap">
            {paper.categories.slice(0, 5).map(cat => (
              <span key={cat} className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
                {catLabel(cat)}
              </span>
            ))}
          </div>
        </div>
        <div className="flex gap-1 flex-shrink-0">
          <a
            href={paper.arxiv_url}
            target="_blank"
            rel="noopener noreferrer"
            className="p-1.5 rounded text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            title="在 arXiv 查看"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
          {paper.pdf_url && (
            <a
              href={paper.pdf_url}
              target="_blank"
              rel="noopener noreferrer"
              className="p-1.5 rounded text-zinc-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950 transition-colors"
              title="下载 PDF"
            >
              <Download className="w-3.5 h-3.5" />
            </a>
          )}
          <AddToTopicPopover
            url={paper.arxiv_url}
            title={titleCn}
            summary={abstractCn.slice(0, 200)}
            platform="papers"
          />
        </div>
      </div>

      {abstractCn && (
        <div className="mt-2.5">
          <p className="text-[12px] text-zinc-600 dark:text-zinc-400 leading-relaxed">
            {expanded ? abstractCn : shortAbstractCn}
          </p>
          {abstractCn.length > 200 && (
            <button
              onClick={() => setExpanded(v => !v)}
              className="mt-1 flex items-center gap-0.5 text-[11px] text-zinc-400 hover:text-zinc-600 transition-colors"
            >
              {expanded ? <><ChevronUp className="w-3 h-3" />收起</> : <><ChevronDown className="w-3 h-3" />展开摘要</>}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export function PapersClient({ initialPapers }: { initialPapers: Paper[] }) {
  const [papers, setPapers] = useState(initialPapers)
  const [category, setCategory] = useState('全部')
  const [days, setDays] = useState(7)
  const [search, setSearch] = useState('')
  const [collecting, setCollecting] = useState(false)
  const [loading, setLoading] = useState(false)

  async function handleCollect() {
    setCollecting(true)
    try {
      const result = await collectPapers()
      toast.success(`采集完成，新增 ${result.new_papers} 篇论文`)
      if (result.errors.length > 0) {
        toast.warning(`${result.errors.length} 个分类采集失败`)
      }
      await refresh()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : '采集失败')
    } finally {
      setCollecting(false)
    }
  }

  async function refresh() {
    setLoading(true)
    try {
      const data = await getPapers({
        limit: 200,
        days,
        category: category !== '全部' ? category : undefined,
        search: search || undefined,
      })
      setPapers(data)
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  const filtered = useMemo(() => {
    let list = papers
    if (category !== '全部') list = list.filter(p => p.primary_category === category)
    if (search) {
      const q = search.toLowerCase()
      list = list.filter(p =>
        p.title.toLowerCase().includes(q) ||
        p.title_cn.toLowerCase().includes(q) ||
        p.abstract.toLowerCase().includes(q) ||
        p.abstract_cn.toLowerCase().includes(q) ||
        p.authors.some(a => a.toLowerCase().includes(q))
      )
    }
    return list
  }, [papers, category, search])

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-6 py-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-zinc-400" />
            <h1 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">论文追踪</h1>
            <span className="text-xs text-zinc-400 bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 rounded-full">
              {filtered.length} 篇
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-400" />
              <Input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="搜索标题/摘要/作者"
                className="h-8 text-xs pl-8 w-52"
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleCollect}
              disabled={collecting}
              className="h-8 text-xs gap-1.5"
            >
              <RefreshCw className={cn('w-3.5 h-3.5', collecting && 'animate-spin')} />
              {collecting ? '采集中…' : '立即采集'}
            </Button>
          </div>
        </div>

        {/* Category + Days filters */}
        <div className="flex items-center gap-4 mt-3">
          <div className="flex gap-1 flex-wrap">
            {CATEGORIES.map(cat => (
              <button
                key={cat}
                onClick={() => setCategory(cat)}
                className={cn(
                  'px-2.5 py-1 rounded-md text-xs font-medium transition-colors',
                  category === cat
                    ? 'bg-indigo-600 text-white'
                    : 'text-zinc-500 hover:text-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                )}
              >
                {cat === '全部' ? cat : catLabel(cat)}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 ml-auto">
            <span className="text-xs text-zinc-400">最近</span>
            {DAYS_OPTIONS.map(d => (
              <button
                key={d}
                onClick={async () => { setDays(d); setLoading(true); try { const data = await getPapers({ limit: 200, days: d, category: category !== '全部' ? category : undefined, search: search || undefined }); setPapers(data) } catch {} finally { setLoading(false) } }}
                className={cn(
                  'px-2 py-0.5 rounded text-xs transition-colors',
                  days === d
                    ? 'bg-zinc-200 dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 font-medium'
                    : 'text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                )}
              >
                {d}天
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-sm text-zinc-400">加载中…</div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 gap-2 text-zinc-400">
            <FileText className="w-8 h-8 opacity-30" />
            <p className="text-sm">暂无论文数据，点击「立即采集」抓取 arXiv 最新论文</p>
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map(paper => (
              <PaperCard key={paper.arxiv_id} paper={paper} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
