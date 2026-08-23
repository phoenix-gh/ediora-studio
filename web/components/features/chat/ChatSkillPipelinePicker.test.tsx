// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { ChatSkill, SubmittedSkillInvocation } from '@/lib/api/chat'
import { ChatSkillPipelinePicker } from './ChatSkillPipelinePicker'

const chatApi = vi.hoisted(() => ({
  listPipelineParameterOptions: vi.fn(),
}))

vi.mock('@/lib/api/chat', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/chat')>('@/lib/api/chat')
  return { ...actual, listPipelineParameterOptions: chatApi.listPipelineParameterOptions }
})

const skills: ChatSkill[] = [
  { name: 'source-research', displayName: '资料研究', description: '检索资料', version: '1.0.0' },
  { name: 'writing-plan', displayName: '写作方案', description: '按方案写作', version: '1.0.0', parameterKind: 'writing_plan', parameterRequired: true },
]

function Harness() {
  const [open, setOpen] = useState(false)
  const [invocations, setInvocations] = useState<SubmittedSkillInvocation[]>([])
  return <>
    <ChatSkillPipelinePicker
      skills={skills}
      invocations={invocations}
      open={open}
      disabled={false}
      onOpenChange={setOpen}
      onChange={setInvocations}
    />
    <output data-testid="invocation-order">{invocations.map(invocation => invocation.skillName).join(',')}</output>
  </>
}

describe('ChatSkillPipelinePicker', () => {
  it('appends duplicate Skills in selection order', async () => {
    render(<Harness />)

    fireEvent.click(screen.getByRole('button', { name: '@ 添加技能' }))
    fireEvent.click(screen.getByRole('button', { name: '@资料研究检索资料' }))
    fireEvent.click(screen.getByRole('button', { name: '@ 添加技能' }))
    fireEvent.click(screen.getByRole('button', { name: '@资料研究检索资料' }))

    expect(screen.getAllByText('@资料研究')).toHaveLength(2)
    expect(screen.getByTestId('invocation-order')).toHaveTextContent('source-research,source-research')
  })

  it('opens a searchable Writing Plan dialog and appends the selected parameter', async () => {
    chatApi.listPipelineParameterOptions.mockResolvedValueOnce({ options: [{
      id: '12', displayName: 'AI 产品观察', kind: 'writing_plan', summary: '从一手资料切入', metadata: { genre: '观点' },
    }] })
    render(<Harness />)

    fireEvent.click(screen.getByRole('button', { name: '@ 添加技能' }))
    fireEvent.click(screen.getByRole('button', { name: /写作方案/ }))

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '选择写作方案' })).toBeInTheDocument()
    await waitFor(() => expect(chatApi.listPipelineParameterOptions).toHaveBeenCalledWith('writing_plan', ''))
    fireEvent.click(screen.getByRole('button', { name: /AI 产品观察/ }))

    expect(screen.getByText('@写作方案:AI 产品观察')).toBeInTheDocument()
    expect(screen.getByTestId('invocation-order')).toHaveTextContent('writing-plan')
  })

  it('removes one complete chip without changing the rest', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: '@ 添加技能' }))
    fireEvent.click(screen.getByRole('button', { name: '@资料研究检索资料' }))
    fireEvent.click(screen.getByRole('button', { name: '@ 添加技能' }))
    fireEvent.click(screen.getByRole('button', { name: '@资料研究检索资料' }))

    fireEvent.click(screen.getAllByRole('button', { name: '移除技能：@资料研究' })[0])

    expect(screen.getAllByText('@资料研究')).toHaveLength(1)
    expect(screen.getByTestId('invocation-order')).toHaveTextContent('source-research')
  })
})
