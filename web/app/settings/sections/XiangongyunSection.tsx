'use client'

import { useCallback, useEffect, useState } from 'react'
import { Eye, EyeOff, Loader2, Power, RefreshCw, Save, Server, SquarePower } from 'lucide-react'
import { toast } from 'sonner'

import { FormSection } from '@/components/layout/FormSection'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Progress, ProgressLabel, ProgressValue } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  type AppSettings,
  bootXiangongyunInstance,
  getXiangongyunInstance,
  listXiangongyunInstances,
  shutdownXiangongyunInstance,
  updateSettings,
} from '@/lib/api/settings'
import type { XiangongyunInstance } from '@/lib/xiangongyun/client'

const DEFAULT_BASE_URL = 'https://api.xiangongyun.com'
const STATUS_REFRESH_MS = 5_000

function statusVariant(status: string): 'success' | 'warning' | 'destructive' | 'secondary' {
  if (status === 'running') return 'success'
  if (status === 'shutdown' || status === 'destroyed') return 'secondary'
  if (status === 'destroying' || status === 'freeze') return 'destructive'
  return 'warning'
}

function displayValue(value: unknown) {
  if (value === undefined || value === null || value === '') return '—'
  return String(value)
}

export function XiangongyunSection({
  settings,
  onSaved,
}: {
  settings: AppSettings | null
  onSaved: (settings: AppSettings) => void
}) {
  const [baseUrl, setBaseUrl] = useState(
    settings?.xiangongyun_base_url ?? DEFAULT_BASE_URL,
  )
  const [token, setToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [selectedId, setSelectedId] = useState(
    settings?.xiangongyun_default_instance_id ?? '',
  )
  const [instances, setInstances] = useState<XiangongyunInstance[]>([])
  const [selectedInstance, setSelectedInstance] = useState<XiangongyunInstance | null>(null)
  const [loadingInstances, setLoadingInstances] = useState(false)
  const [loadingStatus, setLoadingStatus] = useState(false)
  const [busyAction, setBusyAction] = useState<'boot' | 'shutdown' | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const refreshSelected = useCallback(async (instanceId: string) => {
    if (!instanceId) {
      setSelectedInstance(null)
      return
    }
    setLoadingStatus(true)
    try {
      const detail = await getXiangongyunInstance(instanceId)
      setSelectedInstance(detail)
      setError('')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '获取实例状态失败')
    } finally {
      setLoadingStatus(false)
    }
  }, [])

  const refreshInstances = useCallback(async () => {
    setLoadingInstances(true)
    try {
      const response = await listXiangongyunInstances()
      setInstances(response.list)
      setError('')
      setSelectedId(current => {
        if (current || response.list.length === 0) return current
        return response.list[0]?.id ?? ''
      })
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '获取仙宫云实例列表失败')
    } finally {
      setLoadingInstances(false)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshInstances()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [refreshInstances])

  useEffect(() => {
    if (!selectedId) return
    let disposed = false
    const refresh = async () => {
      if (disposed) return
      await refreshSelected(selectedId)
    }
    void refresh()
    const timer = window.setInterval(() => {
      void refresh()
    }, STATUS_REFRESH_MS)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [refreshSelected, selectedId])

  async function handleSave() {
    setSaving(true)
    try {
      const updated = await updateSettings({
        xiangongyun_base_url: baseUrl.trim() || DEFAULT_BASE_URL,
        xiangongyun_default_instance_id: selectedId,
        ...(token.trim() ? { xiangongyun_api_token: token.trim() } : {}),
      })
      onSaved(updated)
      setToken('')
      toast.success('仙宫云配置已保存')
      await refreshInstances()
    } catch {
      toast.error('仙宫云配置保存失败')
    } finally {
      setSaving(false)
    }
  }

  async function handleAction(action: 'boot' | 'shutdown') {
    if (!selectedId) return
    setBusyAction(action)
    try {
      if (action === 'boot') {
        await bootXiangongyunInstance(selectedId)
        toast.success('开机指令已发送')
      } else {
        await shutdownXiangongyunInstance(selectedId)
        toast.success('关机指令已发送')
      }
      await refreshSelected(selectedId)
    } catch (requestError) {
      toast.error(requestError instanceof Error ? requestError.message : '实例操作失败')
    } finally {
      setBusyAction(null)
    }
  }

  const progress = selectedInstance?.progress
  const selectedInList = !selectedId || instances.some(instance => instance.id === selectedId)

  return (
    <div className="flex flex-col gap-4">
      <FormSection
        title="仙宫云 API"
        description="Token 只保存在服务端；浏览器通过本服务读取实例列表和发送生命周期指令。"
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="xiangongyun-base-url">API 地址</FieldLabel>
            <Input
              id="xiangongyun-base-url"
              value={baseUrl}
              onChange={event => setBaseUrl(event.target.value)}
              placeholder={DEFAULT_BASE_URL}
              autoComplete="off"
              className="font-mono"
            />
            <FieldDescription>
              默认使用官方 API 地址；如使用兼容代理，可在这里填写代理的 HTTP(S) 地址。
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="xiangongyun-api-token">API Token</FieldLabel>
            <div className="flex gap-2">
              <Input
                id="xiangongyun-api-token"
                type={showToken ? 'text' : 'password'}
                value={token}
                onChange={event => setToken(event.target.value)}
                placeholder={settings?.xiangongyun_api_token_set
                  ? `已配置 (${settings.xiangongyun_api_token_preview}) — 输入新值可替换`
                  : '请输入仙宫云 API Token'}
                autoComplete="off"
                className="font-mono"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={showToken ? '隐藏 API Token' : '显示 API Token'}
                onClick={() => setShowToken(value => !value)}
              >
                {showToken ? <EyeOff /> : <Eye />}
              </Button>
            </div>
            <FieldDescription>
              {settings?.xiangongyun_api_token_set
                ? `已配置 (${settings.xiangongyun_api_token_preview})；留空保存不会覆盖现有 Token。`
                : '尚未配置 Token。'}
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="xiangongyun-default-instance">默认实例</FieldLabel>
            <div className="flex gap-2">
              <Select
                value={selectedId}
                onValueChange={value => {
                  if (value) setSelectedId(value)
                }}
              >
                <SelectTrigger id="xiangongyun-default-instance" className="min-w-0 flex-1">
                  <SelectValue placeholder="请选择实例" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {instances.map(instance => (
                      <SelectItem key={instance.id} value={instance.id}>
                        {instance.name || instance.id}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                onClick={() => void refreshInstances()}
                disabled={loadingInstances}
              >
                {loadingInstances
                  ? <Loader2 data-icon="inline-start" />
                  : <RefreshCw data-icon="inline-start" />}
                刷新实例
              </Button>
            </div>
            {!selectedInList ? (
              <FieldDescription className="text-warning">
                已保存的默认实例不在当前列表中，请刷新列表后重新选择。
              </FieldDescription>
            ) : null}
          </Field>

          {error ? (
            <Alert variant="destructive">
              <Server />
              <AlertTitle>仙宫云请求失败</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button onClick={handleSave} disabled={saving} aria-label="保存仙宫云配置">
              {saving ? <Loader2 data-icon="inline-start" /> : <Save data-icon="inline-start" />}
              保存配置
            </Button>
          </div>
        </FieldGroup>
      </FormSection>

      <FormSection
        title="实例状态"
        description="查看默认实例状态并发送开机、关机指令。数字人分镜任务会在开始前检查这个实例。"
      >
        <FieldGroup>
          {selectedInstance ? (
            <div className="flex flex-col gap-4 rounded-lg border border-border bg-background p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">{selectedInstance.name || selectedInstance.id}</p>
                  <p className="font-mono text-xs text-muted-foreground">{selectedInstance.id}</p>
                </div>
                <Badge variant={statusVariant(selectedInstance.status)}>
                  {selectedInstance.status}
                </Badge>
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <div>
                  <p className="text-xs text-muted-foreground">GPU 型号</p>
                  <p>{displayValue(selectedInstance.gpu_model)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">GPU 数量</p>
                  <p>{displayValue(selectedInstance.gpu_used)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">CPU</p>
                  <p>{displayValue(selectedInstance.cpu_model)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">数据中心</p>
                  <p>{displayValue(selectedInstance.data_center_name)}</p>
                </div>
              </div>
              {typeof progress === 'number' ? (
                <Progress value={Math.max(0, Math.min(100, progress))}>
                  <ProgressLabel>进度</ProgressLabel>
                  <ProgressValue />
                </Progress>
              ) : null}
              {selectedInstance.web_url ? (
                <a
                  href={selectedInstance.web_url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-primary underline underline-offset-3"
                >
                  打开实例 Web 地址
                </a>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handleAction('boot')}
                  disabled={busyAction !== null || loadingStatus}
                >
                  {busyAction === 'boot' ? <Loader2 data-icon="inline-start" /> : <Power data-icon="inline-start" />}
                  开机
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handleAction('shutdown')}
                  disabled={busyAction !== null || loadingStatus}
                >
                  {busyAction === 'shutdown' ? <Loader2 data-icon="inline-start" /> : <SquarePower data-icon="inline-start" />}
                  关机
                </Button>
              </div>
            </div>
          ) : (
            <FieldDescription>
              {loadingInstances || loadingStatus
                ? '正在读取实例状态…'
                : '配置 Token 后刷新实例列表。'}
            </FieldDescription>
          )}
        </FieldGroup>
      </FormSection>
    </div>
  )
}
