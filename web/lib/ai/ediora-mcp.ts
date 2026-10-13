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
