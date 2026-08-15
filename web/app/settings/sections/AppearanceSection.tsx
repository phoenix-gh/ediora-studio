'use client'

import { Monitor, Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'

import { FormSection } from '@/components/layout/FormSection'
import { Button } from '@/components/ui/button'

const OPTIONS = [
  { value: 'system', label: '跟随系统', icon: Monitor },
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
] as const

export function AppearanceSection() {
  const { theme, setTheme } = useTheme()

  return (
    <FormSection
      title="主题"
      description="选择界面配色；跟随系统会随设备的外观设置自动切换。"
    >
      <div aria-label="外观主题" className="grid gap-3 sm:grid-cols-3" role="group">
        {OPTIONS.map(({ value, label, icon: Icon }) => (
          <Button
            key={value}
            type="button"
            variant={theme === value ? 'default' : 'outline'}
            aria-pressed={theme === value}
            className="h-auto justify-start py-4"
            onClick={() => setTheme(value)}
          >
            <Icon data-icon="inline-start" />
            {label}
          </Button>
        ))}
      </div>
    </FormSection>
  )
}
