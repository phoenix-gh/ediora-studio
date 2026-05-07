'use client'

import { useState } from 'react'
import { Loader2, Eye, EyeOff, CheckCircle, Save, AtSign } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { AppSettings, updateSettings } from '@/lib/api/settings'

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000/api'

function detectCookieFormat(raw: string): string {
  const t = raw.trim()
  if (t.startsWith('[')) return 'JSON 数组格式 ✓'
  if (t.startsWith('#') || t.includes('Netscape')) return 'Netscape 格式 ✓'
  if (t.includes('=')) {
    const count = t.split(';').filter(p => p.includes('=')).length
    return `原始字符串 · ${count} 个 cookie ✓`
  }
  return '格式未识别'
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-zinc-400">{hint}</p>}
    </div>
  )
}

type Source = 'twitterapi' | 'tl1' | 'camofox' | 'classify'

const SOURCES: { key: Source; label: string }[] = [
  { key: 'twitterapi', label: 'twitterapi.io' },
  { key: 'tl1',        label: 'tl1.com'       },
  { key: 'camofox',    label: 'camofox VNC'   },
  { key: 'classify',   label: 'LLM 分类'      },
]

export function XSection({ settings, onSaved }: { settings: AppSettings | null; onSaved: (s: AppSettings) => void }) {
  const [source, setSource] = useState<Source>('twitterapi')

  // twitterapi.io
  const [twitterApiKey, setTwitterApiKey]         = useState('')
  const [showTwitterKey, setShowTwitterKey]       = useState(false)
  const [twitterApiEnabled, setTwitterApiEnabled] = useState(settings?.twitterapi_io_collect_enabled ?? true)
  const [searchQueries, setSearchQueries]         = useState(settings?.x_search_queries ?? '')
  const [xEnabled, setXEnabled]                   = useState(settings?.x_collect_enabled ?? true)
  const [xInterval, setXInterval]                 = useState(settings?.x_collect_interval_minutes ?? 30)
  const [xThreshold, setXThreshold]               = useState(settings?.x_follower_threshold ?? 5000)
  const [xPostWindow, setXPostWindow]             = useState(settings?.x_post_window_hours ?? 24)
  const [xLookback, setXLookback]                 = useState(settings?.x_post_lookback_hours ?? 24)

  // tl1.com
  const [tl1Enabled, setTl1Enabled]   = useState(settings?.tl1_collect_enabled ?? true)
  const [tl1Interval, setTl1Interval] = useState(settings?.tl1_collect_interval_seconds ?? 30)
  const [tl1Hours, setTl1Hours]       = useState(settings?.tl1_trending_hours ?? 2)

  // classify
  const [classifyEnabled, setClassifyEnabled] = useState(settings?.x_post_classify_enabled ?? true)
  const [classifyPrompt, setClassifyPrompt]   = useState(settings?.x_post_classify_prompt ?? '')

  // camofox
  const [camofoxUrl, setCamofoxUrl]         = useState(settings?.camofox_url ?? 'http://localhost:9377')
  const [camofoxApiKey, setCamofoxApiKey]   = useState('')
  const [showCamofoxKey, setShowCamofoxKey] = useState(false)
  const [camofoxUserId, setCamofoxUserId]   = useState(settings?.camofox_user_id ?? 'wemedia_x')
  const [novncUrl, setNovncUrl]             = useState(settings?.camofox_novnc_url ?? 'http://localhost:6080/vnc.html')
  const [xCookies, setXCookies]             = useState('')

  const [saving, setSaving]               = useState(false)
  const [timelineLoading, setTimelineLoading] = useState(false)

  async function handleSave() {
    setSaving(true)
    try {
      const base = source === 'twitterapi' ? {
        twitterapi_io_collect_enabled: twitterApiEnabled,
        x_search_queries: searchQueries,
        x_collect_enabled: xEnabled,
        x_collect_interval_minutes: xInterval,
        x_follower_threshold: xThreshold,
        x_post_window_hours: xPostWindow,
        x_post_lookback_hours: xLookback,
        ...(twitterApiKey ? { twitterapi_io_key: twitterApiKey } : {}),
      } : source === 'tl1' ? {
        tl1_collect_enabled: tl1Enabled,
        tl1_collect_interval_seconds: tl1Interval,
        tl1_trending_hours: tl1Hours,
      } : source === 'classify' ? {
        x_post_classify_enabled: classifyEnabled,
        x_post_classify_prompt: classifyPrompt,
      } : {
        camofox_url: camofoxUrl,
        camofox_user_id: camofoxUserId,
        camofox_novnc_url: novncUrl,
        ...(camofoxApiKey ? { camofox_api_key: camofoxApiKey } : {}),
        ...(xCookies ? { x_cookies: xCookies } : {}),
      }

      const updated = await updateSettings(base)
      onSaved(updated)
      setTwitterApiKey('')
      setCamofoxApiKey('')
      setXCookies('')
      toast.success('配置已保存')
    } catch {
      toast.error('保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-5">
      {/* Source tabs */}
      <div className="flex rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden text-sm w-fit">
        {SOURCES.map(s => (
          <button
            key={s.key}
            type="button"
            onClick={() => setSource(s.key)}
            className={cn(
              'px-4 py-2 transition-colors',
              source === s.key
                ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                : 'text-zinc-500 hover:text-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800 dark:hover:text-zinc-200'
            )}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* ── twitterapi.io ─────────────────────────────────────── */}
      {source === 'twitterapi' && (
        <div className="space-y-4">
          <p className="text-[11px] text-zinc-400">
            通过 twitterapi.io REST API 搜索关键词帖子 & 关注账号时间线，无需浏览器。
          </p>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300">启用自动采集</p>
              <p className="text-[11px] text-zinc-400 mt-0.5">关闭后调度器跳过此数据源</p>
            </div>
            <Switch checked={twitterApiEnabled} onCheckedChange={setTwitterApiEnabled} />
          </div>

          <Row label="API Key">
            <div className="relative">
              <Input
                type={showTwitterKey ? 'text' : 'password'}
                value={twitterApiKey}
                onChange={e => setTwitterApiKey(e.target.value)}
                placeholder={settings?.twitterapi_io_key_set ? '已配置 — 留空不修改' : 'twitterapi.io API Key'}
                className="h-9 text-sm pr-9 font-mono"
                autoComplete="off"
              />
              <button type="button" onClick={() => setShowTwitterKey(v => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600">
                {showTwitterKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>
            {settings?.twitterapi_io_key_set && !twitterApiKey && (
              <p className="text-[11px] text-emerald-600 dark:text-emerald-400 flex items-center gap-1 mt-1">
                <CheckCircle className="w-3 h-3" />已配置
              </p>
            )}
          </Row>

          <Row label="搜索关键词" hint="逗号分隔，每个关键词独立查询；关注账号时间线始终收录">
            <Input
              value={searchQueries}
              onChange={e => setSearchQueries(e.target.value)}
              placeholder="AI, LLM, 大模型, OpenAI"
              className="h-9 text-sm font-mono"
            />
          </Row>

          <div className="grid grid-cols-2 gap-4 pt-1 border-t border-zinc-100 dark:border-zinc-800">
            <Row label="采集间隔">
              <div className="flex items-center gap-2">
                <Input type="number" min={1} max={1440} value={xInterval}
                  onChange={e => setXInterval(Math.max(1, Number(e.target.value)))}
                  className="h-9 text-sm w-20" />
                <span className="text-sm text-zinc-500">分钟</span>
              </div>
            </Row>
            <Row label="粉丝门槛" hint="超过此数加入博主候选库">
              <div className="flex items-center gap-2">
                <Input type="number" min={0} value={xThreshold}
                  onChange={e => setXThreshold(Math.max(0, Number(e.target.value)))}
                  className="h-9 text-sm w-24" />
                <span className="text-sm text-zinc-500">人</span>
              </div>
            </Row>
            <Row label="帖子收录窗口" hint="收录发布时间在此范围内的帖子">
              <div className="flex items-center gap-2">
                <Input type="number" min={1} max={168} value={xPostWindow}
                  onChange={e => setXPostWindow(Math.max(1, Number(e.target.value)))}
                  className="h-9 text-sm w-20" />
                <span className="text-sm text-zinc-500">小时</span>
              </div>
            </Row>
            <Row label="指标追踪时长" hint="超过后不再刷新该帖指标">
              <div className="flex items-center gap-2">
                <Input type="number" min={1} max={168} value={xLookback}
                  onChange={e => setXLookback(Math.max(1, Number(e.target.value)))}
                  className="h-9 text-sm w-20" />
                <span className="text-sm text-zinc-500">小时</span>
              </div>
            </Row>
          </div>

          <div className="flex items-center justify-between pt-1 border-t border-zinc-100 dark:border-zinc-800">
            <div>
              <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300">启用博主候选采集</p>
              <p className="text-[11px] text-zinc-400 mt-0.5">关闭后不再扫描时间线发现新博主</p>
            </div>
            <Switch checked={xEnabled} onCheckedChange={setXEnabled} />
          </div>
        </div>
      )}

      {/* ── tl1.com ───────────────────────────────────────────── */}
      {source === 'tl1' && (
        <div className="space-y-4">
          <p className="text-[11px] text-zinc-400">
            通过 tl1.com API 定时抓取 X 热门中文推文，无需 API Key，直接入库。
          </p>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300">启用自动采集</p>
              <p className="text-[11px] text-zinc-400 mt-0.5">关闭后调度器跳过此数据源</p>
            </div>
            <Switch checked={tl1Enabled} onCheckedChange={setTl1Enabled} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Row label="采集间隔">
              <div className="flex items-center gap-2">
                <Input type="number" min={10} max={3600} value={tl1Interval}
                  onChange={e => setTl1Interval(Math.max(10, Number(e.target.value)))}
                  className="h-9 text-sm w-24" />
                <span className="text-sm text-zinc-500">秒</span>
              </div>
            </Row>
            <Row label="热门时间窗口">
              <div className="flex items-center gap-2">
                <Input type="number" min={1} max={24} value={tl1Hours}
                  onChange={e => setTl1Hours(Math.max(1, Math.min(24, Number(e.target.value))))}
                  className="h-9 text-sm w-20" />
                <span className="text-sm text-zinc-500">小时内热门</span>
              </div>
            </Row>
          </div>
        </div>
      )}

      {/* ── camofox VNC ───────────────────────────────────────── */}
      {source === 'camofox' && (
        <div className="space-y-4">
          <p className="text-[11px] text-zinc-400">
            仅用于手动 VNC 浏览 X 时间线，不参与自动采集。
          </p>

          <div className="grid grid-cols-2 gap-3">
            <Row label="服务地址">
              <Input value={camofoxUrl} onChange={e => setCamofoxUrl(e.target.value)}
                placeholder="http://localhost:9377" className="h-9 text-sm font-mono" />
            </Row>
            <Row label="Session UserId">
              <Input value={camofoxUserId} onChange={e => setCamofoxUserId(e.target.value)}
                placeholder="wemedia_x" className="h-9 text-sm font-mono" />
            </Row>
            <Row label="noVNC 地址" hint="启动 camofox 时设置 ENABLE_VNC=1">
              <Input value={novncUrl} onChange={e => setNovncUrl(e.target.value)}
                placeholder="http://localhost:6080/vnc.html" className="h-9 text-sm font-mono" />
            </Row>
            <Row label="API Key">
              <div className="relative">
                <Input
                  type={showCamofoxKey ? 'text' : 'password'}
                  value={camofoxApiKey}
                  onChange={e => setCamofoxApiKey(e.target.value)}
                  placeholder={settings?.camofox_api_key_set ? '已配置 — 留空不修改' : 'CAMOFOX_API_KEY'}
                  className="h-9 text-sm pr-9 font-mono"
                  autoComplete="off"
                />
                <button type="button" onClick={() => setShowCamofoxKey(v => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600">
                  {showCamofoxKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
              {settings?.camofox_api_key_set && !camofoxApiKey && (
                <p className="text-[11px] text-emerald-600 dark:text-emerald-400 flex items-center gap-1 mt-1">
                  <CheckCircle className="w-3 h-3" />已配置
                </p>
              )}
            </Row>
          </div>

          <div className="flex items-center gap-3 p-3 rounded-lg bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200 dark:border-zinc-700">
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300">打开时间线</p>
              <p className="text-[11px] text-zinc-400 mt-0.5">注入 Cookie，在 camofox 中打开 x.com 时间线</p>
            </div>
            <Button type="button" size="sm" disabled={timelineLoading} className="text-xs gap-1.5 flex-shrink-0"
              onClick={async () => {
                setTimelineLoading(true)
                try {
                  const res = await fetch(`${API}/x/open-timeline`, { method: 'POST' })
                  const data = await res.json()
                  if (data.ok) {
                    window.open(data.novnc_url || novncUrl, '_blank')
                    toast.success(`已注入 ${data.cookie_count} 个 Cookie，时间线已打开`)
                  } else toast.error(`打开失败：${data.error}`)
                } catch (e) { toast.error(`请求失败：${e}`) }
                finally { setTimelineLoading(false) }
              }}>
              {timelineLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <AtSign className="w-3 h-3" />}
              打开时间线
            </Button>
          </div>

          <Row label="X Cookie（VNC 会话用）">
            {xCookies && <span className="text-[11px] text-zinc-400">{detectCookieFormat(xCookies)}</span>}
            <textarea
              value={xCookies}
              onChange={e => setXCookies(e.target.value)}
              placeholder={settings?.x_cookies_set
                ? '已配置 — 粘贴新内容可覆盖'
                : `支持三种格式：\n① 原始字符串：auth_token=xxx; ct0=yyy; ...\n② Cookie-Editor 导出的 JSON 数组\n③ Netscape 格式 (.txt)`}
              rows={3}
              className="w-full rounded-md border border-zinc-200 dark:border-zinc-700 bg-transparent px-3 py-2 text-xs font-mono text-zinc-800 dark:text-zinc-200 placeholder:text-zinc-400 focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-y"
            />
            {settings?.x_cookies_set && !xCookies && (
              <p className="text-[11px] text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                <CheckCircle className="w-3 h-3" />已配置
              </p>
            )}
          </Row>
        </div>
      )}

      {/* ── LLM 分类 ─────────────────────────────────────────── */}
      {source === 'classify' && (
        <div className="space-y-4">
          <p className="text-[11px] text-zinc-400">
            对每篇收录帖子使用 LLM 自动分类，每 5 分钟批量处理未分类帖子。
          </p>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300">启用自动分类</p>
              <p className="text-[11px] text-zinc-400 mt-0.5">关闭后调度器跳过分类任务</p>
            </div>
            <Switch checked={classifyEnabled} onCheckedChange={setClassifyEnabled} />
          </div>

          <Row
            label="分类提示词"
            hint="留空使用默认提示词。使用 {content} 占位符引用帖子内容，LLM 须回复：通告 / 科普 / 教程 / 其他"
          >
            <textarea
              value={classifyPrompt}
              onChange={e => setClassifyPrompt(e.target.value)}
              placeholder={`默认提示词：\n你是一个推文分类助手。请将以下推文内容分类为：通告 / 科普 / 教程 / 其他\n只回复类别名称。\n\n推文内容：\n{content}`}
              rows={8}
              className="w-full rounded-md border border-zinc-200 dark:border-zinc-700 bg-transparent px-3 py-2 text-xs font-mono text-zinc-800 dark:text-zinc-200 placeholder:text-zinc-400 focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-y"
            />
          </Row>
        </div>
      )}

      <Button onClick={handleSave} disabled={saving} size="sm" className="gap-1.5">
        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
        保存
      </Button>
    </div>
  )
}
