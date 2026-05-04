'use client'

import { useState } from 'react'
import { Loader2, Eye, EyeOff, CheckCircle, Save, AtSign } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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

// ── Subsection wrapper ─────────────────────────────────────────────────────────

function Sub({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
      <div className="px-4 py-2.5 bg-zinc-50 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800">
        <h3 className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">{title}</h3>
      </div>
      <div className="p-4 space-y-4">{children}</div>
    </div>
  )
}

export function XSection({ settings, onSaved }: { settings: AppSettings | null; onSaved: (s: AppSettings) => void }) {
  // camofox
  const [camofoxUrl, setCamofoxUrl]       = useState(settings?.camofox_url ?? 'http://localhost:9377')
  const [camofoxApiKey, setCamofoxApiKey] = useState('')
  const [showCamofoxKey, setShowCamofoxKey] = useState(false)
  const [camofoxUserId, setCamofoxUserId] = useState(settings?.camofox_user_id ?? 'wemedia_x')
  const [novncUrl, setNovncUrl]           = useState(settings?.camofox_novnc_url ?? 'http://localhost:6080/vnc.html')

  // cookies
  const [xCookies, setXCookies] = useState('')

  // collection params
  const [xInterval, setXInterval]           = useState(settings?.x_collect_interval_minutes ?? 30)
  const [xThreshold, setXThreshold]         = useState(settings?.x_follower_threshold ?? 5000)
  const [xPostWindow, setXPostWindow]       = useState(settings?.x_post_window_hours ?? 24)
  const [xLookback, setXLookback]           = useState(settings?.x_post_lookback_hours ?? 24)
  const [xScrolls, setXScrolls]             = useState(settings?.x_timeline_scrolls ?? 5)

  // action states
  const [saving, setSaving]               = useState(false)
  const [vncLoading, setVncLoading]       = useState(false)
  const [importLoading, setImportLoading] = useState(false)
  const [timelineLoading, setTimelineLoading] = useState(false)

  async function handleSave() {
    setSaving(true)
    try {
      const updated = await updateSettings({
        camofox_url: camofoxUrl,
        camofox_user_id: camofoxUserId,
        camofox_novnc_url: novncUrl,
        x_collect_interval_minutes: xInterval,
        x_follower_threshold: xThreshold,
        x_post_lookback_hours: xLookback,
        x_timeline_scrolls: xScrolls,
        x_post_window_hours: xPostWindow,
        ...(camofoxApiKey ? { camofox_api_key: camofoxApiKey } : {}),
        ...(xCookies ? { x_cookies: xCookies } : {}),
      })
      onSaved(updated)
      setCamofoxApiKey('')
      setXCookies('')
      toast.success('X 配置已保存')
    } catch {
      toast.error('保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-5">

      {/* ── camofox 连接 ───────────────────────────────────────── */}
      <Sub title="camofox 浏览器">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">服务地址</Label>
            <Input value={camofoxUrl} onChange={e => setCamofoxUrl(e.target.value)}
              placeholder="http://localhost:9377" className="h-9 text-sm font-mono" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Session UserId</Label>
            <Input value={camofoxUserId} onChange={e => setCamofoxUserId(e.target.value)}
              placeholder="wemedia_x" className="h-9 text-sm font-mono" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">noVNC 地址</Label>
            <Input value={novncUrl} onChange={e => setNovncUrl(e.target.value)}
              placeholder="http://localhost:6080/vnc.html" className="h-9 text-sm font-mono" />
            <p className="text-[11px] text-zinc-400">启动 camofox 时设置 ENABLE_VNC=1</p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">API Key</Label>
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
              <p className="text-[11px] text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                <CheckCircle className="w-3 h-3" />已配置
              </p>
            )}
          </div>
        </div>
      </Sub>

      {/* ── 登录 / 会话 ────────────────────────────────────────── */}
      <Sub title="登录 &amp; 会话">
        {/* VNC login flow */}
        <div className="flex items-center gap-3 p-3 rounded-lg bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200 dark:border-zinc-700">
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300">VNC 登录流程</p>
            <p className="text-[11px] text-zinc-400 mt-0.5">先「打开登录页」→ VNC 界面手动登录 → 再「导入登录状态」</p>
          </div>
          <div className="flex gap-2 flex-shrink-0">
            <Button type="button" variant="outline" size="sm" disabled={vncLoading} className="text-xs gap-1.5"
              onClick={async () => {
                setVncLoading(true)
                try {
                  const res = await fetch(`${API}/x/open-login`, { method: 'POST' })
                  const data = await res.json()
                  if (data.ok) {
                    window.open(data.novnc_url || novncUrl, '_blank')
                    toast.success('已在 camofox 中打开登录页，请在 VNC 窗口完成登录')
                  } else toast.error(`打开失败：${data.error}`)
                } catch (e) { toast.error(`请求失败：${e}`) }
                finally { setVncLoading(false) }
              }}>
              {vncLoading && <Loader2 className="w-3 h-3 animate-spin" />}
              打开登录页
            </Button>
            <Button type="button" size="sm" disabled={importLoading} className="text-xs gap-1.5"
              onClick={async () => {
                setImportLoading(true)
                try {
                  const res = await fetch(`${API}/x/import-session`, { method: 'POST' })
                  const data = await res.json()
                  if (data.ok) {
                    toast.success(`已导入 ${data.cookie_count} 个 Cookie`)
                    window.location.reload()
                  } else toast.error(`导入失败：${data.error}`)
                } catch (e) { toast.error(`请求失败：${e}`) }
                finally { setImportLoading(false) }
              }}>
              {importLoading && <Loader2 className="w-3 h-3 animate-spin" />}
              导入登录状态
            </Button>
          </div>
        </div>

        {/* Open timeline */}
        <div className="flex items-center gap-3 p-3 rounded-lg bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200 dark:border-zinc-700">
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300">打开时间线</p>
            <p className="text-[11px] text-zinc-400 mt-0.5">注入已保存的 Cookie，在 camofox 中打开 x.com 时间线</p>
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

        {/* X Cookies */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label className="text-xs">X Cookie（手动填写）</Label>
            {xCookies && <span className="text-[11px] text-zinc-400">{detectCookieFormat(xCookies)}</span>}
          </div>
          <textarea
            value={xCookies}
            onChange={e => setXCookies(e.target.value)}
            placeholder={settings?.x_cookies_set
              ? '已配置 — 粘贴新内容可覆盖'
              : `支持三种格式：\n① 原始字符串：auth_token=xxx; ct0=yyy; ...\n② Cookie-Editor 导出的 JSON 数组\n③ Netscape 格式 (.txt)`}
            rows={4}
            className="w-full rounded-md border border-zinc-200 dark:border-zinc-700 bg-transparent px-3 py-2 text-xs font-mono text-zinc-800 dark:text-zinc-200 placeholder:text-zinc-400 focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-y"
          />
          {settings?.x_cookies_set && !xCookies && (
            <p className="text-[11px] text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
              <CheckCircle className="w-3 h-3" />已配置，自动转换为 camofox 格式
            </p>
          )}
          <p className="text-[11px] text-zinc-400">
            DevTools → Network → 任意 x.com 请求 → Request Headers → 复制 Cookie 值粘贴即可
          </p>
        </div>
      </Sub>

      {/* ── 采集参数 ────────────────────────────────────────────── */}
      <Sub title="博主候选采集">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label className="text-xs">采集间隔</Label>
            <div className="flex items-center gap-2">
              <Input type="number" min={1} max={1440} value={xInterval}
                onChange={e => setXInterval(Math.max(1, Number(e.target.value)))}
                className="h-9 text-sm w-20" />
              <span className="text-sm text-zinc-500">分钟</span>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">粉丝门槛</Label>
            <div className="flex items-center gap-2">
              <Input type="number" min={0} value={xThreshold}
                onChange={e => setXThreshold(Math.max(0, Number(e.target.value)))}
                className="h-9 text-sm w-24" />
              <span className="text-sm text-zinc-500">人</span>
            </div>
            <p className="text-[11px] text-zinc-400">超过此数加入博主备选库</p>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">时间线滚动次数</Label>
          <div className="flex items-center gap-2">
            <Input type="number" min={1} max={20} value={xScrolls}
              onChange={e => setXScrolls(Math.max(1, Number(e.target.value)))}
              className="h-9 text-sm w-20" />
            <span className="text-[11px] text-zinc-400">次 · 每次滚动后等待内容加载，过大会增加采集时长</span>
          </div>
        </div>
      </Sub>

      {/* ── 帖子趋势采集 ──────────────────────────────────────── */}
      <Sub title="帖子趋势采集">
        <p className="text-[11px] text-zinc-400 -mt-1">
          每次采集时，收录时间线上指定时间窗口内的帖子，并持续追踪回复 / 点赞 / 阅读数变化趋势。
        </p>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label className="text-xs">帖子收录窗口</Label>
            <div className="flex items-center gap-2">
              <Input type="number" min={1} max={168} value={xPostWindow}
                onChange={e => setXPostWindow(Math.max(1, Number(e.target.value)))}
                className="h-9 text-sm w-20" />
              <span className="text-sm text-zinc-500">小时</span>
            </div>
            <p className="text-[11px] text-zinc-400">收录发布时间在此窗口内的帖子</p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">指标追踪时长</Label>
            <div className="flex items-center gap-2">
              <Input type="number" min={1} max={168} value={xLookback}
                onChange={e => setXLookback(Math.max(1, Number(e.target.value)))}
                className="h-9 text-sm w-20" />
              <span className="text-sm text-zinc-500">小时</span>
            </div>
            <p className="text-[11px] text-zinc-400">超过此时长不再主动刷新指标</p>
          </div>
        </div>
      </Sub>

      <Button onClick={handleSave} disabled={saving} size="sm" className="gap-1.5">
        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
        保存
      </Button>
    </div>
  )
}
