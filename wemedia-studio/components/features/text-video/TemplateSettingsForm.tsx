'use client'

import { useId } from 'react'
import type { ZodError } from 'zod'

import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import type {
  TextVideoTemplateManifest,
  TextVideoTemplateSettingField,
} from '@/remotion/types'

export type TemplateSettingsManifest<P extends Record<string, unknown>> = Pick<
  TextVideoTemplateManifest<P>,
  'id' | 'defaults' | 'propsSchema' | 'settings'
>

type TemplateSettingsFormProps<P extends Record<string, unknown>> = {
  manifest: TemplateSettingsManifest<P>
  value: P
  onChange(value: P): void
  fieldErrors: Record<string, string>
}

type TemplateSettingControlProps<P extends Record<string, unknown>> = {
  field: TextVideoTemplateSettingField<P>
  fieldId: string
  value: P
  onChange(value: P): void
  error?: string
}

function TemplateSettingControl<P extends Record<string, unknown>>({
  field,
  fieldId,
  value,
  onChange,
  error,
}: TemplateSettingControlProps<P>) {
  const invalid = Boolean(error)
  const describedBy = error ? `${fieldId}-error` : undefined

  if (field.kind === 'boolean') {
    return (
      <Field data-invalid={invalid} orientation="horizontal">
        <FieldLabel htmlFor={fieldId}>{field.label}</FieldLabel>
        <Switch
          id={fieldId}
          checked={Boolean(value[field.key])}
          onCheckedChange={checked => onChange({
            ...value,
            [field.key]: checked,
          })}
          aria-invalid={invalid}
          aria-describedby={describedBy}
        />
        {error ? (
          <FieldDescription id={describedBy}>{error}</FieldDescription>
        ) : null}
      </Field>
    )
  }

  if (field.kind === 'select') {
    return (
      <Field data-invalid={invalid}>
        <FieldLabel htmlFor={fieldId}>{field.label}</FieldLabel>
        <Select
          value={String(value[field.key] ?? '')}
          onValueChange={nextValue => {
            if (nextValue !== null) {
              onChange({ ...value, [field.key]: nextValue })
            }
          }}
        >
          <SelectTrigger
            id={fieldId}
            className="w-full"
            aria-invalid={invalid}
            aria-describedby={describedBy}
          >
            <SelectValue>
              {selectedValue => field.options.find(
                option => option.value === selectedValue,
              )?.label ?? ''}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {field.options.map(option => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {error ? (
          <FieldDescription id={describedBy}>{error}</FieldDescription>
        ) : null}
      </Field>
    )
  }

  if (field.kind === 'color') {
    const color = String(value[field.key] ?? '')
    return (
      <Field data-invalid={invalid}>
        <FieldLabel htmlFor={fieldId}>{field.label}</FieldLabel>
        <div className="flex items-center gap-2">
          <Input
            id={`${fieldId}-picker`}
            type="color"
            value={color}
            aria-label={`选择${field.label}`}
            aria-invalid={invalid}
            aria-describedby={describedBy}
            onChange={event => onChange({
              ...value,
              [field.key]: event.target.value,
            })}
            className="size-9 shrink-0"
          />
          <Input
            id={fieldId}
            value={color}
            aria-invalid={invalid}
            aria-describedby={describedBy}
            onChange={event => onChange({
              ...value,
              [field.key]: event.target.value,
            })}
          />
        </div>
        {error ? (
          <FieldDescription id={describedBy}>{error}</FieldDescription>
        ) : null}
      </Field>
    )
  }

  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={fieldId}>{field.label}</FieldLabel>
      <Input
        id={fieldId}
        value={String(value[field.key] ?? '')}
        maxLength={field.maxLength}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        onChange={event => onChange({
          ...value,
          [field.key]: event.target.value,
        })}
      />
      {error ? (
        <FieldDescription id={describedBy}>{error}</FieldDescription>
      ) : null}
    </Field>
  )
}

export function TemplateSettingsForm<P extends Record<string, unknown>>({
  manifest,
  value,
  onChange,
  fieldErrors,
}: TemplateSettingsFormProps<P>) {
  const formId = useId()

  return (
    <div className="flex flex-col gap-5">
      {manifest.settings.map(group => (
        <FieldSet key={group.id}>
          <FieldLegend>{group.label}</FieldLegend>
          <FieldGroup>
            {group.fields.map(field => (
              <TemplateSettingControl
                key={field.key}
                field={field}
                fieldId={`${formId}-${group.id}-${field.key}`}
                value={value}
                onChange={onChange}
                error={fieldErrors[field.key]}
              />
            ))}
          </FieldGroup>
        </FieldSet>
      ))}
    </div>
  )
}

export function templateSettingsFieldErrors(
  error: ZodError,
): Record<string, string> {
  const errors: Record<string, string> = {}

  for (const issue of error.issues) {
    const key = issue.path[0]
    if (typeof key === 'string' && errors[key] === undefined) {
      errors[key] = issue.message
    }
  }

  return errors
}
