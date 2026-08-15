'use client'

import { useState } from 'react'
import { Loader2, Save, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { FormSection } from '@/components/layout/FormSection'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { AppSettings, updateSettings } from '@/lib/api/settings'

interface CollectionProxyFormProps {
  settings: AppSettings | null
  onSaved(settings: AppSettings): void
}

export function CollectionProxyForm({ settings, onSaved }: CollectionProxyFormProps) {
  const [proxyUrl, setProxyUrl] = useState(settings?.collection_proxy_url ?? '')
  const [configured, setConfigured] = useState(settings?.collection_proxy_url_set ?? false)
  const [preview, setPreview] = useState(settings?.collection_proxy_url_preview ?? '')
  const [saving, setSaving] = useState(false)

  async function save(value: string) {
    setSaving(true)
    try {
      const updated = await updateSettings({ collection_proxy_url: value })
      setProxyUrl(updated.collection_proxy_url)
      setConfigured(updated.collection_proxy_url_set)
      setPreview(updated.collection_proxy_url_preview)
      onSaved(updated)
      toast.success(value ? '采集代理已保存并立即生效' : '采集代理已清除')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存采集代理失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <FormSection
      title="采集网络代理"
      description="为需要访问外部网络的数据采集统一配置代理，保存后无需重启服务。"
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="collection-proxy-url">代理地址</FieldLabel>
          <Input
            id="collection-proxy-url"
            value={proxyUrl}
            onChange={event => setProxyUrl(event.target.value)}
            placeholder={configured && !proxyUrl
              ? '已配置认证代理，输入新地址可替换'
              : 'http://127.0.0.1:7890'}
            className="font-mono"
            autoComplete="off"
          />
          <FieldDescription>
            只作用于采集通道，不会写入进程级 <code className="font-mono">HTTP_PROXY</code> /{' '}
            <code className="font-mono">HTTPS_PROXY</code>。支持 http、https 与 socks5。
          </FieldDescription>
        </Field>

        <div className="rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm">
          <span className="font-medium text-foreground">
            {configured ? '已启用' : '未启用'}
          </span>
          {configured && preview ? (
            <code className="ml-2 break-all font-mono text-muted-foreground">{preview}</code>
          ) : null}
        </div>

        <p className="text-sm text-muted-foreground">
          适用于 X / feedgrab、Reddit、YouTube、GitHub 和论文等采集通道。
        </p>

        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => save(proxyUrl.trim())}
            disabled={saving || !proxyUrl.trim()}
          >
            {saving ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Save data-icon="inline-start" />}
            保存代理
          </Button>
          {configured ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => save('')}
              disabled={saving}
            >
              <Trash2 data-icon="inline-start" />
              清除代理
            </Button>
          ) : null}
        </div>
      </FieldGroup>
    </FormSection>
  )
}
