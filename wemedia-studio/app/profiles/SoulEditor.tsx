'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { saveSoul } from '@/lib/api/profiles'

interface Props {
  profile: string
  initial: string
  readonly: boolean
  onSaved: (text: string) => void
}

export function SoulEditor({ profile, initial, readonly, onSaved }: Props) {
  const [text, setText] = useState(initial)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setText(initial)
  }, [initial, profile])

  async function handleSave() {
    setSaving(true)
    try {
      await saveSoul(profile, text)
      onSaved(text)
      toast.success('SOUL 已保存')
    } catch (e) {
      toast.error(String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3">
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        disabled={readonly}
        className="w-full min-h-[420px] font-mono text-sm border rounded p-3 bg-background disabled:opacity-60"
      />
      <div className="flex justify-end">
        <Button
          disabled={readonly || saving || text === initial}
          onClick={handleSave}
        >
          {saving ? '保存中…' : '保存'}
        </Button>
      </div>
    </div>
  )
}
