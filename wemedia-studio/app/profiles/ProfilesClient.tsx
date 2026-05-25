'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  listProfiles,
  getProfile,
  type ProfileSummary,
  type ProfileDetail,
} from '@/lib/api/profiles'
import { SoulEditor } from './SoulEditor'
import { ToolsPanel } from './ToolsPanel'
import { SkillsPanel } from './SkillsPanel'
// SkillsPanel is added in Task 6.

export function ProfilesClient() {
  const [list, setList] = useState<ProfileSummary[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<ProfileDetail | null>(null)
  const [tab, setTab] = useState<'soul' | 'tools' | 'skills'>('soul')

  useEffect(() => {
    listProfiles()
      .then(rows => {
        setList(rows)
        const first = rows.find(p => !p.is_default) ?? rows[0]
        if (first) setSelected(first.name)
      })
      .catch(e => toast.error(e instanceof Error ? e.message : String(e)))
  }, [])

  useEffect(() => {
    if (!selected) return
    let ignore = false
    getProfile(selected)
      .then(d => { if (!ignore) setDetail(d) })
      .catch(e => { if (!ignore) toast.error(e instanceof Error ? e.message : String(e)) })
    return () => { ignore = true }
  }, [selected])

  const readonly = detail?.is_default ?? false

  return (
    <div className="flex h-full">
      <aside className="w-64 border-r overflow-y-auto">
        <ul>
          {list.map(p => (
            <li key={p.name}>
              <button
                className={`w-full text-left px-4 py-2 hover:bg-muted ${
                  selected === p.name ? 'bg-muted font-medium' : ''
                }`}
                onClick={() => setSelected(p.name)}
              >
                <div className="flex items-center gap-2">
                  <span>{p.name}</span>
                  {p.is_default && (
                    <span className="text-xs text-muted-foreground">(default · 只读)</span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">{p.model}</div>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <main className="flex-1 overflow-y-auto p-6">
        {!detail ? (
          <p className="text-muted-foreground">选择一个 profile</p>
        ) : (
          <>
            <h1 className="text-xl font-semibold mb-4">{detail.name}</h1>
            <div className="border-b mb-4 flex gap-4">
              {(['soul', 'tools', 'skills'] as const).map(t => (
                <button
                  key={t}
                  className={`pb-2 ${
                    tab === t
                      ? 'border-b-2 border-primary font-medium'
                      : 'text-muted-foreground'
                  }`}
                  onClick={() => setTab(t)}
                >
                  {t.toUpperCase()}
                </button>
              ))}
            </div>
            {tab === 'soul' && (
              <SoulEditor
                profile={detail.name}
                initial={detail.soul}
                readonly={readonly}
                onSaved={text => setDetail({ ...detail, soul: text })}
              />
            )}
            {tab === 'tools' && (
              <ToolsPanel
                profile={detail.name}
                readonly={readonly}
                toolsets={detail.toolsets}
                mcpServers={detail.mcp_servers}
                onChange={next => setDetail({ ...detail, ...next })}
              />
            )}
            {tab === 'skills' && (
              <SkillsPanel
                profile={detail.name}
                readonly={readonly}
                skills={detail.skills}
                onChange={next => setDetail({ ...detail, skills: next })}
              />
            )}
          </>
        )}
      </main>
    </div>
  )
}
