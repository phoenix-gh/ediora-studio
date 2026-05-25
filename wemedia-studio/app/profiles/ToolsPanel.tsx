'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Switch } from '@/components/ui/switch'
import { Toolset, McpServer, toggleToolset, toggleMcp } from '@/lib/api/profiles'

interface Props {
  profile: string
  readonly: boolean
  toolsets: Toolset[]
  mcpServers: McpServer[]
  onChange: (next: { toolsets: Toolset[]; mcp_servers: McpServer[] }) => void
}

export function ToolsPanel({ profile, readonly, toolsets, mcpServers, onChange }: Props) {
  const [busy, setBusy] = useState<string | null>(null)

  async function flipToolset(t: Toolset) {
    setBusy(`ts:${t.name}`)
    try {
      await toggleToolset(profile, t.name, !t.enabled)
      onChange({
        toolsets: toolsets.map(x => x.name === t.name ? { ...x, enabled: !t.enabled } : x),
        mcp_servers: mcpServers,
      })
    } catch (e) { toast.error(String(e)) } finally { setBusy(null) }
  }

  async function flipMcp(m: McpServer) {
    setBusy(`mcp:${m.name}`)
    try {
      await toggleMcp(profile, m.name, !m.enabled)
      onChange({
        toolsets,
        mcp_servers: mcpServers.map(x => x.name === m.name ? { ...x, enabled: !m.enabled } : x),
      })
    } catch (e) { toast.error(String(e)) } finally { setBusy(null) }
  }

  return (
    <div className="space-y-8">
      <section>
        <h2 className="font-semibold mb-3">内置 Toolsets</h2>
        <div className="grid grid-cols-2 gap-2">
          {toolsets.map(t => (
            <label key={t.name} className="flex items-center justify-between gap-3 border rounded px-3 py-2">
              <span className="text-sm">
                <span className="mr-2">{t.emoji}</span>
                <span className="font-mono">{t.name}</span>
                <span className="ml-2 text-muted-foreground">{t.label}</span>
              </span>
              <Switch checked={t.enabled} disabled={readonly || busy === `ts:${t.name}`} onCheckedChange={() => flipToolset(t)} />
            </label>
          ))}
        </div>
      </section>
      <section>
        <h2 className="font-semibold mb-3">MCP Servers</h2>
        {mcpServers.length === 0 ? <p className="text-sm text-muted-foreground">未注册 MCP server</p> : (
          <div className="space-y-2">
            {mcpServers.map(m => (
              <label key={m.name} className="flex items-center justify-between gap-3 border rounded px-3 py-2">
                <span className="text-sm">
                  <span className="font-mono">{m.name}</span>
                  <span className="ml-2 text-muted-foreground">{m.url}</span>
                </span>
                <Switch checked={m.enabled} disabled={readonly || busy === `mcp:${m.name}`} onCheckedChange={() => flipMcp(m)} />
              </label>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
