'use client'

import { useMemo, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Skill } from '@/lib/api/profiles'

interface Props { skills: Skill[] }

export function SkillsPanel({ skills }: Props) {
  const [q, setQ] = useState('')
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase()
    return term ? skills.filter(s => s.name.toLowerCase().includes(term) || s.category.toLowerCase().includes(term)) : skills
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <Input placeholder="搜索 skill 或 category…" value={q} onChange={e => setQ(e.target.value)} className="max-w-sm" />
        <p className="text-sm text-muted-foreground">
          共 {skills.length} 个 skill · Phase 1 只读，需要切换请运行 <code className="font-mono">hermes skills config</code>
        </p>
      </div>
      <div className="space-y-3">
        {grouped.map(([cat, items]) => (
          <details key={cat} open>
            <summary className="cursor-pointer font-semibold py-1">{cat} <span className="text-muted-foreground font-normal">({items.length})</span></summary>
            <ul className="mt-2 grid grid-cols-3 gap-1 text-sm">
              {items.map(s => (
                <li key={`${cat}/${s.name}`} className="font-mono px-2 py-1 rounded bg-muted/40">
                  {s.enabled ? '✓' : '✗'} {s.name}
                </li>
              ))}
            </ul>
          </details>
        ))}
      </div>
    </div>
  )
}
