import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import { setSkillEnabled } from '../skills/registry'
import {
  creativeAssetUploadQuery,
  illustrationImageInputSchema,
  insertInlineImage,
  loadBaoyuSkillRulesForTest,
  parseTemplateCandidate,
  runPromptImageGenerationFlow,
  toolsForContentStep,
} from './content-job'

const imageGeneration = vi.hoisted(() => vi.fn())

vi.mock('ai', async importOriginal => ({
  ...await importOriginal<typeof import('ai')>(),
  generateImage: imageGeneration,
}))

let runtimeDir = ''

afterEach(async () => {
  delete process.env.SKILLS_RUNTIME_DIR
  delete process.env.SKILLS_STATE_FILE
  delete process.env.SKILLS_MAX_REFERENCE_BYTES
  vi.unstubAllEnvs()
  imageGeneration.mockReset()
  if (runtimeDir) await rm(runtimeDir, { recursive: true, force: true })
  runtimeDir = ''
})

it('keeps template extraction free of persistence tools', () => {
  expect(toolsForContentStep('template_extraction')).toEqual([])
})

it('encodes standalone image title and directory for Creative Assets', () => {
  const query = new URLSearchParams(creativeAssetUploadQuery('GitHub 日榜 2026-08-09', ' 临时文件 '))

  expect(query.get('media_kind')).toBe('image')
  expect(query.get('title')).toBe('GitHub 日榜 2026-08-09')
  expect(query.get('directory')).toBe('临时文件')
})

it('inserts an illustration after its matching level-two heading', () => {
  expect(insertInlineImage('## 安装\n\n正文', '/api/uploads/install.png', '安装')).toEqual({
    content: '## 安装\n\n![插图](/api/uploads/install.png)\n\n正文',
    placement: 'anchor',
  })
})

it('appends an illustration when its heading is absent', () => {
  expect(insertInlineImage('# 标题\n\n正文', '/api/uploads/fallback.png', '不存在')).toEqual({
    content: '# 标题\n\n正文\n\n![插图](/api/uploads/fallback.png)',
    placement: 'append',
  })
})

it('does not insert the same illustration URL twice', () => {
  expect(insertInlineImage('![插图](/api/uploads/install.png)', '/api/uploads/install.png', '安装')).toEqual({
    content: '![插图](/api/uploads/install.png)',
    placement: 'existing',
  })
})

it('requires a heading anchor for automatic illustrations', () => {
  expect(illustrationImageInputSchema.safeParse({ prompt: 'x'.repeat(20) }).success).toBe(false)
  expect(illustrationImageInputSchema.safeParse({
    prompt: 'x'.repeat(20),
    anchor_heading: '安装 sing-box',
  }).success).toBe(true)
})

it('accepts a null merge target from a non-merge candidate', () => {
  expect(parseTemplateCandidate(JSON.stringify({
    recommendation: 'create', title: '案例拆解', genre: 'commentary', writing_guide: '先讲现象，再解释原因。',
    title_formula: '[现象] 为什么发生', unsuitable_for: '纯新闻', genericity_check: '未含专有名词', merge_target_id: null, reason: '可复用',
  })).merge_target_id).toBeNull()
})

it('normalizes an array of unsuitable cases into display text', () => {
  expect(parseTemplateCandidate(JSON.stringify({
    recommendation: 'create', title: '案例拆解', genre: 'commentary', writing_guide: '先讲现象，再解释原因。',
    title_formula: '[现象] 为什么发生', unsuitable_for: ['纯新闻', '无案例观点'], genericity_check: '未含专有名词', reason: '可复用',
  })).unsuitable_for).toBe('纯新闻\n无案例观点')
})

it('refuses to load a disabled automatic image Skill', async () => {
  runtimeDir = await mkdtemp(join(tmpdir(), 'wms-content-skill-'))
  process.env.SKILLS_RUNTIME_DIR = runtimeDir
  process.env.SKILLS_STATE_FILE = join(runtimeDir, 'skills-state.json')

  await setSkillEnabled('baoyu-cover-image', false)
  await expect(loadBaoyuSkillRulesForTest('cover')).rejects.toThrow(/unavailable|disabled/i)
})

it('applies the shared Skill reference byte limit to background cover rules', async () => {
  process.env.SKILLS_MAX_REFERENCE_BYTES = '1'

  await expect(loadBaoyuSkillRulesForTest('cover')).rejects.toMatchObject({ code: 'too_large' })
})

it('generates a prompt image, uploads it, and records the runtime model', async () => {
  vi.stubEnv('API_URL', 'http://localhost:8000/api')
  vi.stubEnv('WORKER_TOKEN', 'prompt-assets-worker-token-0123456789012345')
  imageGeneration.mockResolvedValue({
    images: [{ uint8Array: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }],
  })
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/settings/ai-runtime')) {
      return new Response(JSON.stringify({
        image: {
          api_key: 'sk-image',
          model: 'gpt-image-1',
          base_url: 'https://images.example/v1',
        },
      }), { status: 200 })
    }
    if (url.includes('/assets/upload')) {
      expect(new URL(url).searchParams.get('media_kind')).toBe('image')
      expect(init?.headers).toMatchObject({
        'X-Worker-Token': 'prompt-assets-worker-token-0123456789012345',
        'X-Content-Job-Id': '72',
      })
      return new Response(JSON.stringify({
        id: 88,
        url: '/api/uploads/prompt-image.png',
        title: '城市夜景',
      }), { status: 201 })
    }
    if (url.endsWith('/assets/generations/17/succeed')) {
      expect(JSON.parse(String(init?.body))).toEqual({
        media_asset_id: 88,
        provider: 'openai-compatible',
        model: 'gpt-image-1',
      })
      return new Response('{}', { status: 200 })
    }
    return new Response('{}', { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)

  const output = await runPromptImageGenerationFlow({
    id: 72,
    flow: 'prompt_image_generation',
    title: '[提示词图片] 城市夜景',
    input: {
      prompt_asset_id: 10,
      generation_id: 17,
      prompt_snapshot: '  一张有霓虹灯的未来城市夜景  ',
      title_snapshot: '城市夜景',
    },
    steps: [],
  })

  expect(output).toEqual({
    generation_id: 17,
    asset_id: 88,
    asset_url: '/api/uploads/prompt-image.png',
    model: 'gpt-image-1',
  })
  expect(imageGeneration).toHaveBeenCalledWith(expect.objectContaining({
    prompt: '一张有霓虹灯的未来城市夜景',
    n: 1,
  }))
  expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/assets/generations/17/fail'))).toBe(false)
})

it('records a bounded prompt generation failure and does not mark it succeeded', async () => {
  vi.stubEnv('API_URL', 'http://localhost:8000/api')
  vi.stubEnv('WORKER_TOKEN', 'prompt-assets-worker-token-0123456789012345')
  imageGeneration.mockRejectedValue(new Error('provider failed '.repeat(100)))
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/settings/ai-runtime')) {
      return new Response(JSON.stringify({
        image: { api_key: 'sk-image', model: 'gpt-image-1', base_url: '' },
      }), { status: 200 })
    }
    if (url.endsWith('/assets/generations/18/fail')) {
      const body = JSON.parse(String(init?.body)) as { error: string }
      expect(body.error.length).toBeLessThanOrEqual(500)
      return new Response('{}', { status: 200 })
    }
    return new Response('{}', { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)

  await expect(runPromptImageGenerationFlow({
    id: 73,
    flow: 'prompt_image_generation',
    title: '[提示词图片] 失败',
    input: {
      prompt_asset_id: 11,
      generation_id: 18,
      prompt_snapshot: '一张失败测试图片的提示词',
      title_snapshot: '失败',
    },
    steps: [],
  })).rejects.toThrow('provider failed')

  expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/assets/generations/18/succeed'))).toBe(false)
})
