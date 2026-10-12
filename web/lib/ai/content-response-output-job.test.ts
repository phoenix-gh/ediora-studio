import { describe, expect, it, vi } from 'vitest'

import { createScriptedCodexPeer } from '../../test/codex-jsonl-peer'
import { CODEX_THREAD_CWD } from './codex-app-server'
import { runCodexAgentTurn } from './codex-app-server-client'
import type { AgentToolAudit } from './agent-runtime-types'
import {
  buildResponseArticleAgentObjective,
  outputInstructions,
  responseArticleCompletionEvidenceFromAudit,
  runContentResponseOutputJob,
  type ContentResponseOutputAgentJobDependencies,
  type ResponseArticleContext,
} from './content-response-output-job'


const context: ResponseArticleContext = {
  output: { id: 55, output_type: 'expanded_article', status: 'queued' },
  item: {
    id: 27,
    source_url: 'https://x.com/source/status/27',
    source_title: '原文标题',
    source_author: '作者',
    analysis: {
      content_value_score: 92,
      core_thesis: 'AI评价核心判断',
      suggested_angle: '实践角度',
      suggested_structure: ['开头', '论证'],
    },
  },
  source: {
    available: true,
    body: '这是完整原文。',
    url: 'https://x.com/source/status/27',
  },
}

function saveDraftItem(output: unknown) {
  return {
    type: 'mcpToolCall',
    id: 'save-1',
    server: 'ediora',
    tool: 'save_draft',
    status: 'completed',
    arguments: {
      topic_id: 'response:27', status: 'drafting', draft_type: 'article',
    },
    result: output,
  }
}

function dependencies(toolOutput?: unknown): ContentResponseOutputAgentJobDependencies {
  const execution = {
    id: 41, job_id: 19, status: 'running', objective: 'pending',
    skill_mode: 'auto' as const, skill_name: null, phase: 'created',
    checkpoint: {}, audit: {}, completion_evidence: {}, version: 1,
  }
  return {
    getJob: vi.fn().mockResolvedValue({
      id: 19, flow: 'content_response_output', title: 'response', status: 'queued',
      input: { response_output_id: 55 }, steps: [],
    }),
    getContext: vi.fn().mockResolvedValue(context),
    ensureExecution: vi.fn().mockResolvedValue(execution),
    checkpointExecution: vi.fn().mockImplementation(async (_jobId, _id, version, update) => ({
      ...execution, version: version + 1, phase: update.phase,
      checkpoint: update.checkpoint, audit: update.audit,
    })),
    appendMessage: vi.fn().mockResolvedValue({}),
    claimToolCall: vi.fn().mockResolvedValue({ action: 'execute' }),
    listToolCalls: vi.fn().mockResolvedValue([]),
    completeToolCall: vi.fn().mockResolvedValue({}),
    failToolCall: vi.fn().mockResolvedValue({}),
    completeExecution: vi.fn().mockResolvedValue({}),
    failExecution: vi.fn().mockResolvedValue({}),
    startStep: vi.fn().mockImplementation(async (_jobId, key) => ({
      id: key === 'agent' ? 71 : 72, attempt: 1,
    })),
    completeStep: vi.fn().mockResolvedValue({}),
    failStep: vi.fn().mockResolvedValue({}),
    completeJob: vi.fn().mockResolvedValue({}),
    linkDraft: vi.fn().mockResolvedValue({
      id: 55, status: 'draft_ready', article_draft_id: 123,
    }),
    apiRoot: () => 'http://api.test',
    runAgentTurn: vi.fn(async options => {
      const peer = createScriptedCodexPeer({
        agentText: '普通模型文本',
        completedItems: toolOutput === undefined ? [] : [saveDraftItem(toolOutput)],
      })
      return runCodexAgentTurn({ ...options, transport: peer.transport })
    }),
  }
}


describe('content response output instructions', () => {
  it('keeps every output editable and forbids publishing', () => {
    expect(outputInstructions('x_share')).toContain('不得发布')
    expect(outputInstructions('expanded_article')).toContain('Markdown')
    expect(outputInstructions('expanded_article')).toContain('不得只输出提纲')
    expect(outputInstructions('commentary')).toContain('个人判断')
  })
})

describe('content response Agent writing job', () => {
  it('does not treat a novelty conflict with an id-shaped payload as saved', () => {
    expect(responseArticleCompletionEvidenceFromAudit({
      toolName: 'save_draft',
      toolCallId: 'save-conflict',
      sideEffecting: true,
      autoApproved: true,
      status: 'succeeded',
      inputSummary: {},
      occurredAt: '2026-08-27T00:00:00Z',
      output: {
        saved: false,
        id: 999,
        title: '不应采用',
        status: 'drafting',
        novelty: { decision: 'duplicate' },
      },
    }, { responseItemId: 27 })).toBeNull()
  })

  it.each([
    ['x_short_post', 'X 短帖', 'x'],
    ['x_article', 'X Article', 'x_article'],
    ['wechat_article', '公众号文章', 'mp'],
  ])('targets %s as %s and saves draft type %s', (outputType, label, draftType) => {
    const objective = buildResponseArticleAgentObjective({
      ...context,
      output: { ...context.output, output_type: outputType },
    }, 41)

    expect(objective).toContain(`目标内容形态：${label}`)
    expect(objective).toContain(`draft_type="${draftType}"`)
    expect(objective).toContain('自主判断并加载相关 Skill')
    expect(objective).not.toContain('280 字符')
    expect(objective).not.toContain('固定小标题')
  })

  it('builds an objective for full article writing and direct save_draft persistence', () => {
    const objective = buildResponseArticleAgentObjective(context, 41)

    expect(objective).toContain('原文')
    expect(objective).toContain('AI评价')
    expect(objective).toContain('完整中文 Markdown 文章')
    expect(objective).toContain('topic_id=response:27')
    expect(objective).toContain('status="drafting"')
    expect(objective).toContain('draft_type="article"')
    expect(objective).toContain('save_draft')
    expect(objective).toContain('不得发布')
    expect(objective).toContain('自主判断是否使用 Skill')
  })

  it('fails prose-only Agent output without save_draft evidence', async () => {
    const deps = dependencies()

    await expect(runContentResponseOutputJob(19, deps)).rejects.toThrow(
      'missing valid save_draft evidence',
    )
    expect(deps.linkDraft).not.toHaveBeenCalled()
    expect(deps.completeJob).not.toHaveBeenCalled()
  })

  it('links the real draft returned by save_draft after Agent execution', async () => {
    const deps = dependencies({
      structuredContent: { result: {
        saved: true, id: 123, title: '完整文章', status: 'drafting',
        created_at: '2026-08-07T00:00:00Z',
      } },
    })

    const result = await runContentResponseOutputJob(19, deps)

    expect(result).toMatchObject({ id: 55, status: 'draft_ready', article_draft_id: 123 })
    expect(deps.linkDraft).toHaveBeenCalledWith(19, 55, 123)
    expect(deps.completeJob).toHaveBeenCalledWith(19)
    expect(deps.completeExecution).toHaveBeenCalledWith(19, 41, expect.objectContaining({
      toolName: 'save_draft', draftId: 123, responseItemId: 27,
    }))
    expect(deps.runAgentTurn).toHaveBeenCalledWith(expect.objectContaining({
      approvalPolicy: 'never',
      cwd: CODEX_THREAD_CWD,
    }))
    expect(deps.checkpointExecution).toHaveBeenLastCalledWith(
      19, 41, expect.any(Number), expect.objectContaining({
        phase: 'finalizing',
      }),
    )
  })

  it('records the response-writing Agent session lifecycle', async () => {
    const deps = dependencies({
      structuredContent: { result: {
        saved: true, id: 123, title: '完整文章', status: 'drafting',
        created_at: '2026-08-07T00:00:00Z',
      } },
    })
    const events: Array<Record<string, unknown>> = []
    deps.appendLogEvent = vi.fn(async (_jobId, event) => { events.push(event as Record<string, unknown>) })
    const sessionEvents: Array<Record<string, unknown>> = []
    deps.appendSessionEvent = vi.fn(async (_jobId, _executionId, event) => { sessionEvents.push(event as Record<string, unknown>) })

    await runContentResponseOutputJob(19, deps)

    expect(events.map(event => event.event_type)).toEqual([
      'session/turn-start',
      'skill/selected',
      'session/capabilities',
      'session/turn-end',
    ])
    expect(sessionEvents.map(event => event.type)).toEqual([
      'turn/start', 'user/message', 'agent/skill', 'turn/end',
    ])
  })

  it('recovers a persisted save_draft call without rerunning the Agent', async () => {
    const deps = dependencies()
    vi.mocked(deps.listToolCalls).mockResolvedValue([{
      tool_call_id: 'save-before-restart', tool_name: 'save_draft', status: 'succeeded',
      output: { structuredContent: { result: {
        // Historical save_draft results predate the explicit saved flag.
        id: 123, title: '完整文章', status: 'drafting',
      } } },
    }])

    await runContentResponseOutputJob(19, deps)

    expect(deps.runAgentTurn).not.toHaveBeenCalled()
    expect(deps.linkDraft).toHaveBeenCalledWith(19, 55, 123)
    expect(deps.completeJob).toHaveBeenCalledWith(19)
  })

  it('uses a completed Agent step and only retries link_draft', async () => {
    const deps = dependencies()
    vi.mocked(deps.getJob).mockResolvedValue({
      id: 19, flow: 'content_response_output', title: 'response', status: 'queued',
      input: { response_output_id: 55 },
      steps: [{
        id: 71, key: 'agent', attempt: 1, status: 'succeeded',
        output: {
          toolName: 'save_draft', toolCallId: 'save-1',
          draftId: 123, responseItemId: 27,
        },
      }],
    })

    await runContentResponseOutputJob(19, deps)

    expect(deps.getContext).not.toHaveBeenCalled()
    expect(deps.runAgentTurn).not.toHaveBeenCalled()
    expect(deps.startStep).toHaveBeenCalledWith(19, 'link_draft')
    expect(deps.linkDraft).toHaveBeenCalledWith(19, 55, 123)
  })
})
