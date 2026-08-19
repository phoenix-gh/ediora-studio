'use client'

import { CheckCircle, FlaskConical, Loader2, Trash2, XCircle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { cn } from '@/lib/utils'
import type { LLMAdapter, LLMAdapterInput } from '@/lib/api/settings'

export type LLMAdapterDraft = LLMAdapter & Pick<LLMAdapterInput, 'api_key' | 'clear_api_key'>
export type LLMAdapterTestState = 'idle' | 'testing' | 'ok' | 'fail'

type LLMAdapterEditorProps = {
  adapter: LLMAdapterDraft
  onChange: (patch: Partial<LLMAdapterDraft>) => void
  onDelete?: () => void
  onTest: () => void
  testState: LLMAdapterTestState
  testMessage: string
}

export function LLMAdapterEditor({
  adapter,
  onChange,
  onDelete,
  onTest,
  testState,
  testMessage,
}: LLMAdapterEditorProps) {
  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface-muted/30 p-3" data-testid={`llm-adapter-${adapter.id}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-foreground">Adapter 实例</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">一个实例共用一个模型，可声明文本和图片能力。</p>
        </div>
        {onDelete ? (
          <Button type="button" size="sm" variant="ghost" className="text-destructive" onClick={onDelete} aria-label={`删除 Adapter ${adapter.name || adapter.id}`}>
            <Trash2 />
            删除
          </Button>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`adapter-name-${adapter.id}`}>Adapter 名称</FieldLabel>
          <Input
            id={`adapter-name-${adapter.id}`}
            value={adapter.name}
            onChange={event => onChange({ name: event.target.value })}
            placeholder="例如：信息筛选主接口"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`adapter-protocol-${adapter.id}`}>协议</FieldLabel>
          <NativeSelect id={`adapter-protocol-${adapter.id}`} value="openai" disabled>
            <option value="openai">OpenAI-compatible</option>
          </NativeSelect>
        </Field>
        <Field>
          <FieldLabel htmlFor={`adapter-endpoint-${adapter.id}`}>Endpoint</FieldLabel>
          <Input
            id={`adapter-endpoint-${adapter.id}`}
            value={adapter.endpoint}
            onChange={event => onChange({ endpoint: event.target.value })}
            placeholder="https://api.openai.com/v1"
            className="font-mono"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`adapter-model-${adapter.id}`}>模型</FieldLabel>
          <Input
            id={`adapter-model-${adapter.id}`}
            value={adapter.model}
            onChange={event => onChange({ model: event.target.value })}
            placeholder="例如：gpt-4.1-mini"
            className="font-mono"
          />
        </Field>
      </div>

      <Field>
        <FieldLabel htmlFor={`adapter-key-${adapter.id}`}>API Key</FieldLabel>
        <Input
          id={`adapter-key-${adapter.id}`}
          type="password"
          value={adapter.api_key ?? ''}
          onChange={event => onChange({ api_key: event.target.value, clear_api_key: false })}
          placeholder={adapter.api_key_set ? `已配置 (${adapter.api_key_preview}) — 留空不修改` : '输入 API Key'}
          autoComplete="off"
          className="font-mono"
        />
        {adapter.api_key_set && !adapter.clear_api_key ? (
          <FieldDescription className="flex items-center justify-between gap-2">
            <span>已配置 ({adapter.api_key_preview})</span>
            <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-destructive" onClick={() => onChange({ api_key: '', clear_api_key: true })}>
              清除 API Key
            </Button>
          </FieldDescription>
        ) : null}
      </Field>

      <div className="flex flex-wrap items-center gap-4 text-xs">
        <label className="flex items-center gap-2" htmlFor={`adapter-text-${adapter.id}`}>
          <Checkbox
            id={`adapter-text-${adapter.id}`}
            checked={adapter.supports_text}
            onCheckedChange={checked => onChange({ supports_text: checked === true })}
          />
          支持文本
        </label>
        <label className="flex items-center gap-2" htmlFor={`adapter-image-${adapter.id}`}>
          <Checkbox
            id={`adapter-image-${adapter.id}`}
            checked={adapter.supports_image}
            onCheckedChange={checked => onChange({ supports_image: checked === true })}
          />
          支持图片
        </label>
        {adapter.supports_image ? (
          <label className="flex items-center gap-2" htmlFor={`adapter-response-${adapter.id}`}>
            图片返回
            <NativeSelect
              id={`adapter-response-${adapter.id}`}
              value={adapter.image_response_format}
              onChange={event => onChange({ image_response_format: event.target.value as 'url' | 'base64' })}
              className="w-28"
            >
              <option value="url">URL</option>
              <option value="base64">base64</option>
            </NativeSelect>
          </label>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-border/70 pt-2">
        <Button type="button" variant="outline" size="sm" onClick={onTest} disabled={testState === 'testing'}>
          {testState === 'testing' ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
          {testState === 'ok' ? <CheckCircle data-icon="inline-start" /> : null}
          {testState === 'fail' ? <XCircle data-icon="inline-start" /> : null}
          {testState === 'idle' ? <FlaskConical data-icon="inline-start" /> : null}
          测试连接
        </Button>
        {testMessage ? (
          <span
            role={testState === 'fail' ? 'alert' : 'status'}
            className={cn(
              'max-w-full truncate text-xs',
              testState === 'fail' ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {testState === 'ok' ? `✓ ${testMessage}` : testMessage}
          </span>
        ) : null}
      </div>
    </div>
  )
}
