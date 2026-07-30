'use client'

import { useState } from 'react'
import { Loader2, Save } from 'lucide-react'
import { toast } from 'sonner'

import {
  TemplateSettingsForm,
  templateSettingsFieldErrors,
  type TemplateSettingsManifest,
} from '@/components/features/text-video/TemplateSettingsForm'
import { FormSection } from '@/components/layout/FormSection'
import { Button } from '@/components/ui/button'
import {
  Field,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
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
  updateSettings,
} from '@/lib/api/settings'
import { textVideoTemplates } from '@/remotion/registry'

function templateKey(template: { id: string; version: number }) {
  return `${template.id}@${template.version}`
}

function normalizedTemplateDefaults(
  manifest: TemplateSettingsManifest<Record<string, unknown>>,
  stored: Record<string, unknown> | undefined,
) {
  const parsed = manifest.propsSchema.safeParse({
    ...manifest.defaults,
    ...stored,
  })
  if (parsed.success) return parsed.data

  return manifest.propsSchema.parse(manifest.defaults)
}

const initialManifest = textVideoTemplates[0]
const initialTemplateKey = templateKey(initialManifest)

export function TextVideoSection({
  settings,
  onSaved,
}: {
  settings: AppSettings | null
  onSaved(settings: AppSettings): void
}) {
  const [selectedTemplateKey, setSelectedTemplateKey] = useState(
    initialTemplateKey,
  )
  const [draft, setDraft] = useState<Record<string, unknown>>(() =>
    normalizedTemplateDefaults(
      initialManifest,
      settings?.text_video_template_defaults[initialTemplateKey],
    ),
  )
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  const manifest = textVideoTemplates.find(
    template => templateKey(template) === selectedTemplateKey,
  ) ?? initialManifest

  function selectTemplate(nextKey: string | null) {
    if (nextKey === null) return
    const nextManifest = textVideoTemplates.find(
      template => templateKey(template) === nextKey,
    )
    if (!nextManifest) return

    setSelectedTemplateKey(nextKey)
    setDraft(normalizedTemplateDefaults(
      nextManifest,
      settings?.text_video_template_defaults[nextKey],
    ))
    setFieldErrors({})
  }

  async function save() {
    const parsed = manifest.propsSchema.safeParse(draft)
    if (!parsed.success) {
      setFieldErrors(templateSettingsFieldErrors(parsed.error))
      return
    }

    setSaving(true)
    try {
      const updated = await updateSettings({
        text_video_template_defaults: {
          ...settings?.text_video_template_defaults,
          [selectedTemplateKey]: parsed.data,
        },
      })
      onSaved(updated)
      setDraft(parsed.data)
      setFieldErrors({})
      toast.success('文字视频模板默认视觉已保存')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <FormSection
      title="模板默认视觉"
      description="配置文字视频模板的品牌信息与默认画面；新项目会继承这些值。"
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="text-video-template">模板</FieldLabel>
          <Select value={selectedTemplateKey} onValueChange={selectTemplate}>
            <SelectTrigger id="text-video-template" className="w-full">
              <SelectValue>
                {value => textVideoTemplates.find(
                  template => templateKey(template) === value,
                )?.name ?? value}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {textVideoTemplates.map(template => (
                  <SelectItem
                    key={templateKey(template)}
                    value={templateKey(template)}
                  >
                    {template.name ?? template.id}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      </FieldGroup>

      <TemplateSettingsForm
        manifest={manifest}
        value={draft}
        onChange={nextDraft => {
          setDraft(nextDraft)
          setFieldErrors(currentErrors => {
            const remainingErrors = Object.fromEntries(
              Object.entries(currentErrors).filter(([key]) =>
                Object.is(draft[key], nextDraft[key]),
              ),
            )
            return Object.keys(remainingErrors).length === Object.keys(currentErrors).length
              ? currentErrors
              : remainingErrors
          })
        }}
        fieldErrors={fieldErrors}
      />

      <div className="flex justify-end">
        <Button onClick={() => void save()} disabled={saving}>
          {saving
            ? <Loader2 data-icon="inline-start" className="animate-spin" />
            : <Save data-icon="inline-start" />}
          保存模板默认值
        </Button>
      </div>
    </FormSection>
  )
}
