'use client'

import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Skill, toggleSkills } from '@/lib/api/profiles'

interface Props {
  profile: string
  readonly: boolean
  skills: Skill[]
  onChange: (next: Skill[]) => void
}

export function SkillsPanel({ profile, readonly, skills, onChange }: Props) {
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase()
    return term
      ? skills.filter(s => s.name.toLowerCase().includes(term) || s.category.toLowerCase().includes(term))
      : skills
  }, [skills, q])

  const grouped = useMemo(() => {
    const map = new Map<string, Skill[]>()
    for (const s of filtered) {
      const key = s.category || '(uncategorized)'
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(s)
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [filtered])

  async function applyToggle(names: string[], enabled: boolean, busyKey: string) {
    setBusy(busyKey)
    try {
      await toggleSkills(profile, names, enabled)
      const targets = new Set(names)
      onChange(skills.map(s => (targets.has(s.name) ? { ...s, enabled } : s)))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <Input
          placeholder="搜索 skill 或 category…"
          value={q}
          onChange={e => setQ(e.target.value)}
          className="max-w-sm"
        />
        <p className="text-sm text-muted-foreground">共 {skills.length} 个 skill</p>
      </div>
      <div className="space-y-3">
        {grouped.map(([cat, items]) => {
          const allOn = items.every(s => s.enabled)
          const allOff = items.every(s => !s.enabled)
          const catBusyKey = `cat:${cat}`
          return (
            <details key={cat} open>
              <summary className="cursor-pointer font-semibold py-1 flex items-center justify-between">
                <span>
                  {cat}{' '}
                  <span className="text-muted-foreground font-normal">({items.length})</span>
                </span>
                <span className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={readonly || allOn || busy === catBusyKey}
                    onClick={e => {
                      e.preventDefault()
                      applyToggle(items.map(s => s.name), true, catBusyKey)
                    }}
                  >
                    全开
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={readonly || allOff || busy === catBusyKey}
                    onClick={e => {
                      e.preventDefault()
                      applyToggle(items.map(s => s.name), false, catBusyKey)
                    }}
                  >
                    全关
                  </Button>
                </span>
              </summary>
              <ul className="mt-2 grid grid-cols-2 gap-1 text-sm">
                {items.map(s => {
                  const rowBusyKey = `skill:${s.name}`
                  return (
                    <li
                      key={`${cat}/${s.name}`}
                      className="flex items-center justify-between gap-3 border rounded px-3 py-1.5"
                    >
                      <span className="font-mono truncate">{s.name}</span>
                      <Switch
                        checked={s.enabled}
                        disabled={readonly || busy === rowBusyKey || busy === catBusyKey}
                        onCheckedChange={() => applyToggle([s.name], !s.enabled, rowBusyKey)}
                      />
                    </li>
                  )
                })}
              </ul>
            </details>
          )
        })}
      </div>
    </div>
  )
}
