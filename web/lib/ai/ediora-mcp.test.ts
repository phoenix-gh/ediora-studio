import { afterEach, describe, expect, it } from 'vitest'

import { chatEdioraMcpServers, scheduledEdioraMcpServers } from './ediora-mcp'

const previous = {
  API_URL: process.env.API_URL,
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
}

afterEach(() => {
  for (const key of ['API_URL', 'NEXT_PUBLIC_API_URL'] as const) {
    const value = previous[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('Ediora MCP address', () => {
  it('uses the server API address for scheduled and chat agents', () => {
    process.env.API_URL = 'http://api:8000/api'
    process.env.NEXT_PUBLIC_API_URL = 'https://ediora.example.com/api'
    expect(scheduledEdioraMcpServers(83).ediora).toEqual({
      url: 'http://api:8000/mcp',
      http_headers: {
        'X-Agent-Mode': 'scheduled',
        'X-Daily-Creation-Run-Id': '83',
      },
      default_tools_approval_mode: 'approve',
    })
    expect(chatEdioraMcpServers(12).ediora.url).toBe('http://api:8000/mcp')
  })

  it('uses the public API address when the server address is unset', () => {
    delete process.env.API_URL
    process.env.NEXT_PUBLIC_API_URL = 'https://ediora.example.com/api/'
    expect(scheduledEdioraMcpServers(83).ediora.url).toBe('https://ediora.example.com/mcp')
  })
})
