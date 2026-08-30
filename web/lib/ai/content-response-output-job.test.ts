import { describe, expect, it, vi } from 'vitest'

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

const jobCapabilitySnapshot = {
  schemaVersion: 1 as const,
  mode: 'job' as const,
  skill: null,
  tools: [],
  policy: { approvalPolicy: 'automatic' as const, allowedToolNames: null },
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
    loadModel: vi.fn().mockResolvedValue({}),
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
    openRuntime: vi.fn().mockImplementation(async options => ({
      tools: {},
      catalogContext: 'Enabled Skills available for automatic activation:',
      selectedSkill: undefined,
      prepare: vi.fn(),
      snapshot: () => ({ referenceCount: 0, readReferenceCount: 0 }),
      activeContext: () => undefined,
      capabilitySnapshot: () => jobCapabilitySnapshot,
      readReferences: vi.fn(),
      close: vi.fn(),
      run: vi.fn().mockImplementation(async request => {
        await request.onStep?.({ phase: 'execute', parts: [] })
        if (toolOutput !== undefined) {
          const started: AgentToolAudit = {
            toolName: 'save_draft', toolCallId: 'save-1',
            sideEffecting: true, autoApproved: true, status: 'started',
            inputSummary: {
              topic_id: 'response:27', status: 'drafting', draft_type: 'article',
            }, occurredAt: '2026-08-07T00:00:00Z',
          }
          const decision = await options.beforeToolExecute?.(started)
          if (decision && decision.action !== 'execute') throw new Error(decision.error)
          await options.onToolAudit?.({ ...started, status: 'succeeded', output: toolOutput })
        }
        return { kind: 'completed', text: '普通模型文本', parts: [], revisionCount: 0 }
      }),
    })),
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
    expect(deps.openRuntime).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'job', policyProfile: 'response-writing',
    }))
    expect(deps.checkpointExecution).toHaveBeenLastCalledWith(
      19, 41, expect.any(Number), expect.objectContaining({
        phase: 'finalizing',
        audit: expect.objectContaining({ capabilities: jobCapabilitySnapshot }),
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

  it('rejects a retry before Agent execution when the pinned capabilities drift', async () => {
    const deps = dependencies({
      structuredContent: { result: {
        saved: true, id: 123, title: '完整文章', status: 'drafting',
        created_at: '2026-08-07T00:00:00Z',
      } },
    })
    vi.mocked(deps.ensureExecution).mockResolvedValue({
      id: 41, job_id: 19, status: 'running', objective: 'pending',
      skill_mode: 'auto', skill_name: null, phase: 'finalizing', version: 3,
      checkpoint: {}, audit: {}, completion_evidence: {},
      capability_pin: {
        ...jobCapabilitySnapshot,
        tools: [{
          name: 'new_tool', description: '', inputSchemaDigest: null,
          sideEffecting: false, needsApproval: false, replayPolicy: 'replayable',
          concurrencyPolicy: 'serialized', idempotencyPolicy: 'unknown',
        }],
      },
    })

    await expect(runContentResponseOutputJob(19, deps))
      .rejects.toThrow('Agent capability drift detected: tools')
    expect(deps.failStep).toHaveBeenCalledWith(19, 71, expect.any(Error), false)
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

    expect(deps.loadModel).not.toHaveBeenCalled()
    expect(deps.openRuntime).not.toHaveBeenCalled()
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
    expect(deps.loadModel).not.toHaveBeenCalled()
    expect(deps.openRuntime).not.toHaveBeenCalled()
    expect(deps.startStep).toHaveBeenCalledWith(19, 'link_draft')
    expect(deps.linkDraft).toHaveBeenCalledWith(19, 55, 123)
  })
})
