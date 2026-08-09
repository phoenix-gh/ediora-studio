import { expect, test } from '@playwright/test'

const item = {
  id: 1,
  source_type: 'x_post',
  source_id: 'post-1',
  source_url: 'https://x.com/example/status/1',
  source_title: '一个值得写进内容系统的 X 主题',
  source_author: 'example',
  source_published_at: '2026-08-05T00:00:00Z',
  workflow_status: 'ready',
  decision_status: 'pending',
  content_types: ['research'],
  destination: null,
  current_analysis_run_id: 101,
  feedback_reason: '',
  created_at: '2026-08-05T00:00:00Z',
  updated_at: '2026-08-05T00:00:00Z',
  analysis: {
    id: 101,
    version: 1,
    status: 'succeeded',
    job_id: null,
    content_value_score: 91,
    value_dimensions: {
      novelty: { score: 90, reason: '新角度' },
      practicality: { score: 84, reason: '可执行' },
      credibility: { score: 88, reason: '证据充分' },
      writing_space: { score: 92, reason: '有展开空间' },
      evergreen_value: { score: 76, reason: '可长期参考' },
    },
    summary_cn: '摘要',
    core_thesis: '核心判断',
    suggested_title: '建议标题',
    suggested_angle: '从实践路径切入',
    target_reader: '内容创作者',
    suggested_structure: ['开篇', '论证', '结论'],
    value_points: ['价值点'],
    evidence: [{ text: '原文证据', type: 'source_claim' }],
    risks: ['需要核验'],
    verification_items: ['查证来源'],
    recommended_content_types: ['research'],
    recommended_disposition: 'worth_writing',
    recommendation_reason: '适合写入内容系统',
    created_at: '2026-08-05T00:00:00Z',
    completed_at: '2026-08-05T00:01:00Z',
  },
}

const detail = {
  ...item,
  source: {
    type: 'x_post',
    id: 'post-1',
    url: item.source_url,
    title: item.source_title,
    author: item.source_author,
    published_at: item.source_published_at,
    available: true,
    unavailable_reason: '',
    content: '完整的 X 原文正文',
    raw_markdown: '完整的 X 原文正文',
  },
  outputs: [],
}

const nextItem = {
  ...item,
  id: 2,
  source_id: 'post-2',
  source_url: 'https://x.com/example/status/2',
  source_title: '第二页的 X 情报内容',
  current_analysis_run_id: 102,
  analysis: { ...item.analysis, id: 102 },
}

test('triages an X item and starts a full article writing job', async ({ page }) => {
  const requests: Array<{ url: string; method: string; body: string }> = []
  const listRequests: string[] = []
  await page.route('**/api/responses/1/outputs', async route => {
    requests.push({ url: route.request().url(), method: route.request().method(), body: route.request().postData() ?? '' })
    await route.fulfill({ json: {
      outputs: [{ id: 55, output_type: 'expanded_article', status: 'queued', job_id: 56, job_status: 'queued', created: true }],
    } })
  })
  await page.route('**/api/responses/1', async route => {
    await route.fulfill({ json: detail })
  })
  await page.route('**/api/responses?*', async route => {
    listRequests.push(route.request().url())
    const pageNumber = new URL(route.request().url()).searchParams.get('page')
    await route.fulfill({ json: {
      items: pageNumber === '2' ? [nextItem] : [item],
      counts: { all: 2, pending: 2, worth_writing: 0, creative_asset: 0, not_processed: 0 },
      total: 2,
      page: pageNumber === '2' ? 2 : 1,
      page_size: 30,
    } })
  })

  await page.goto('/responses')
  await expect(page.getByRole('heading', { name: '情报中心' })).toBeVisible()
  await expect(page.getByRole('heading', { name: item.source_title })).toBeVisible()
  await expect(page.getByText('完整的 X 原文正文')).toBeVisible()
  await expect(page.getByText('AI 评价')).toBeVisible()
  await expect(page.getByRole('button', { name: '筛选：3天内' })).toHaveClass(/bg-muted/)

  await page.getByRole('button', { name: new RegExp(item.source_title) }).click()
  await expect(page.getByText('AI 评价')).toBeVisible()
  await expect(page.getByText('正在加载原文与 AI 评价…')).not.toBeVisible()

  await page.getByTestId('responses-list-sentinel').scrollIntoViewIfNeeded()
  await expect(page.getByText(nextItem.source_title)).toBeVisible()
  await expect.poll(() => listRequests.some(url => new URL(url).searchParams.get('page') === '2')).toBe(true)

  await page.getByRole('button', { name: '值得写', exact: true }).click()
  await expect.poll(() => requests.length).toBe(1)
  expect(JSON.parse(requests[0].body)).toEqual({
    analysis_run_id: 101,
    output_types: ['expanded_article'],
  })
  expect(requests.some(request => request.url.includes('/publish'))).toBe(false)
})
