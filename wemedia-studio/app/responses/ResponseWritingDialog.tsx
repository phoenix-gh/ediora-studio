'use client'

import { useState, type FormEvent } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field'
import type { ResponseOutputType } from '@/lib/api/responses'

export const WRITING_TARGET_OPTIONS: Array<{
  value: ResponseOutputType
  label: string
  description: string
}> = [
  { value: 'x_short_post', label: 'X 短帖', description: '生成适合 X 发布的独立短帖草稿' },
  { value: 'x_article', label: 'X Article', description: '生成适合 X Article 的独立长文草稿' },
  { value: 'wechat_article', label: '公众号文章', description: '生成适合微信公众号的独立文章草稿' },
]

export function ResponseWritingDialog({
  open,
  busy,
  error,
  onOpenChange,
  onConfirm,
}: {
  open: boolean
  busy: boolean
  error: string
  onOpenChange: (open: boolean) => void
  onConfirm: (outputTypes: ResponseOutputType[]) => void
}) {
  const [selected, setSelected] = useState<ResponseOutputType[]>([])

  const toggle = (value: ResponseOutputType, checked: boolean) => {
    setSelected(current => checked
      ? current.includes(value) ? current : [...current, value]
      : current.filter(item => item !== value))
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (selected.length === 0 || busy) return
    onConfirm(selected)
  }

  return (
    <Dialog open={open} onOpenChange={nextOpen => { if (!busy) onOpenChange(nextOpen) }}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>选择创作目标</DialogTitle>
          <DialogDescription>每个目标都会创建独立的 Agent 任务和独立草稿，可以多选。</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <FieldSet>
            <FieldLegend variant="label">目标内容形态</FieldLegend>
            <FieldGroup data-slot="checkbox-group">
              {WRITING_TARGET_OPTIONS.map(option => {
                const inputId = `response-writing-${option.value}`
                return (
                  <Field key={option.value} orientation="horizontal">
                    <Checkbox
                      id={inputId}
                      aria-label={option.label}
                      checked={selected.includes(option.value)}
                      disabled={busy}
                      onCheckedChange={checked => toggle(option.value, checked === true)}
                    />
                    <FieldContent>
                      <FieldLabel htmlFor={inputId}>{option.label}</FieldLabel>
                      <FieldDescription>{option.description}</FieldDescription>
                    </FieldContent>
                  </Field>
                )
              })}
            </FieldGroup>
          </FieldSet>
          {error ? <FieldError>{error}</FieldError> : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>取消</Button>
            <Button type="submit" disabled={busy || selected.length === 0}>
              {busy ? '创建中…' : '开始创作'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
