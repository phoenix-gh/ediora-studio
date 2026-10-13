import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { runContentResponseOutputJob } from './content-response-output-job'
import { runDailyCreationAgentJob } from './daily-creation-agent-job'
import { runSkillPipelineJob } from './skill-pipeline-job'

const sources = [
  new URL('./daily-creation-agent-job.ts', import.meta.url),
  new URL('./skill-pipeline-job.ts', import.meta.url),
  new URL('./content-response-output-job.ts', import.meta.url),
  new URL('../../app/api/chat/route.ts', import.meta.url),
]

describe('in-app agent entry points', () => {
  it('use the Codex app-server client instead of the AI SDK agent loop', async () => {
    const files = await Promise.all(sources.map(async url => ({
      path: fileURLToPath(url),
      source: await readFile(url, 'utf8'),
    })))

    for (const file of files) {
      expect(file.source, file.path).toContain('runCodexAgentTurn')
      expect(file.source, file.path).not.toMatch(/\bopenAgentRuntime\b/)
      expect(file.source, file.path).not.toMatch(/\bstreamText\b/)
      expect(file.source, file.path).not.toMatch(/\bgenerateText\b/)
      expect(file.source, file.path).not.toMatch(/sandbox:\s*'workspaceWrite'/)
      if (file.source.includes('sandbox:')) {
        expect(file.source, file.path).toMatch(/sandbox:\s*'workspace-write'/)
      }
    }

    expect(runDailyCreationAgentJob).toEqual(expect.any(Function))
    expect(runSkillPipelineJob).toEqual(expect.any(Function))
    expect(runContentResponseOutputJob).toEqual(expect.any(Function))
  })
})
