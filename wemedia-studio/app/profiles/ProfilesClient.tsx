'use client'

import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import {
  listProfiles,
  getProfile,
  type ProfileSummary,
  type ProfileDetail,
} from '@/lib/api/profiles'
import { Button } from '@/components/ui/button'
import { SoulEditor } from './SoulEditor'
import { ToolsPanel } from './ToolsPanel'
import { SkillsPanel } from './SkillsPanel'
import { ProfileHeader, Avatar } from './ProfileHeader'
import { NewProfileDialog } from './NewProfileDialog'

export function ProfilesClient() {
  const [list, setList] = useState<ProfileSummary[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<ProfileDetail | null>(null)
  const [tab, setTab] = useState<'soul' | 'tools' | 'skills'>('soul')
  const [newOpen, setNewOpen] = useState(false)

  async function reload(selectName?: string) {
    try {
      const rows = await listProfiles()
      setList(rows)
      const target = selectName ?? selected ?? rows.find(p => !p.is_default)?.name ?? rows[0]?.name
      if (target) setSelected(typeof target === 'string' ? target : target)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => { reload() }, []) // eslint-disable-line react-hooks/exhaustive-deps

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
      {/* ── Sidebar ── */}
      <aside className="w-64 shrink-0 border-r flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <span className="text-sm font-medium text-muted-foreground">Profiles</span>
          <Button size="sm" variant="ghost" className="h-7 px-2 gap-1" onClick={() => setNewOpen(true)}>
            <Plus className="size-4" />
            新建
          </Button>
        </div>
        <ul className="flex-1 overflow-y-auto py-1">
          {list.map(p => (
            <li key={p.name}>
              <button
                className={`w-full text-left px-3 py-2 hover:bg-muted transition-colors ${
                  selected === p.name ? 'bg-muted' : ''
                }`}
                onClick={() => setSelected(p.name)}
              >
                <div className="flex items-center gap-2.5">
                  <Avatar url={p.avatar_url} name={p.display_name || p.name} size={32} />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium leading-tight">
                      {p.display_name || p.name}
                    </div>
                    <div className="truncate text-xs text-muted-foreground font-mono leading-tight">
                      {p.name}
                    </div>
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {/* ── Main ── */}
      <main className="flex-1 overflow-y-auto p-6">
        {!detail ? (
          <p className="text-muted-foreground">选择一个 profile</p>
        ) : (
          <>
            <ProfileHeader
              detail={detail}
              onChanged={next => setDetail({ ...detail, ...next } as ProfileDetail)}
              onDeleted={() => {
                setDetail(null)
                setSelected(null)
                reload()
              }}
            />
            <div className="border-b mb-4 flex gap-4">
              {(['soul', 'tools', 'skills'] as const).map(t => (
                <button
                  key={t}
                  className={`pb-2 text-sm ${
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

      <NewProfileDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        candidates={list}
        onCreated={id => {
          reload(id)
          setTab('soul')
        }}
      />
    </div>
  )
}
