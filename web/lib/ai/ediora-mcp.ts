import type { CodexMcpHttpServer } from './codex-app-server-client'

// Codex calls MCP from the web process, so API_URL wins over the public URL.
export function deploymentApiBase() {
  return (process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000/api').replace(/\/$/, '')
}

export function mcpUrlFromApiBase(apiBase: string) {
  const url = new URL(apiBase)
  url.pathname = '/mcp'
  url.search = ''
  url.hash = ''
  return url.toString()
}

export function edioraMcpServers(headers: Record<string, string>): Record<string, CodexMcpHttpServer> {
  return {
    ediora: {
      url: mcpUrlFromApiBase(deploymentApiBase()),
      http_headers: headers,
      // Codex approvalPolicy "never" rejects tools that still require approval.
      // "approve" runs this server's tools without stopping for a prompt.
      default_tools_approval_mode: 'approve',
    },
  }
}

export function chatEdioraMcpServers(sessionId: number) {
  return edioraMcpServers({
    'X-Agent-Mode': 'chat',
    'X-Agent-Session-Id': String(sessionId),
  })
}

export function scheduledEdioraMcpServers(runId: number) {
  return edioraMcpServers({
    'X-Agent-Mode': 'scheduled',
    'X-Daily-Creation-Run-Id': String(runId),
  })
}
