'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Switch } from '@/components/ui/switch'
import {
  type ProjectSkill,
  listProjectSkills,
  installProjectSkill,
  uninstallProjectSkill,
} from '@/lib/api/skills'

interface Props {
  profile: string
  readonly: boolean
}

export function ProjectSkillsPanel({ profile, readonly }: Props) {
  const [skills, setSkills] = useState<ProjectSkill[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let ignore = false
    setLoading(true)
    listProjectSkills(profile)
      .then(rows => { if (!ignore) setSkills(rows) })
      .catch(e => { if (!ignore) toast.error(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!ignore) setLoading(false) })
    return () => { ignore = true }
  }, [profile])

  async function flip(s: ProjectSkill) {
    setBusy(s.name)
    const next = !s.installed
    try {
      if (next) await installProjectSkill(profile, s.name)
      else await uninstallProjectSkill(profile, s.name)
      setSkills(prev => prev.map(x => (x.name === s.name ? { ...x, installed: next } : x)))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  if (loading) return <p className="text-sm text-muted-foreground">加载中…</p>
  if (skills.length === 0)
    return <p className="text-sm text-muted-foreground">项目暂无可安装技能（WeMediaStudio/skills/）</p>

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        来自 WeMediaStudio/skills/ · 安装后 symlink 到该 profile 的 skills/wemedia/
      </p>
      <ul className="space-y-2">
        {skills.map(s => (
          <li
            key={s.name}
            className="flex items-start justify-between gap-4 border rounded px-4 py-3"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-medium">{s.name}</span>
                {s.version && <span className="text-xs text-muted-foreground">v{s.version}</span>}
              </div>
              {s.description && (
                <p className="text-sm text-muted-foreground mt-0.5">{s.description}</p>
              )}
              {s.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {s.tags.map(t => (
                    <span key={t} className="text-xs bg-muted px-1.5 py-0.5 rounded">
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <Switch
              checked={s.installed}
              disabled={readonly || busy === s.name}
              onCheckedChange={() => flip(s)}
            />
          </li>
        ))}
      </ul>
    </div>
  )
}
