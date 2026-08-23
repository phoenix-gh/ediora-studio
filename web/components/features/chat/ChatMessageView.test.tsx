// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { ChatPart } from '@/lib/api/chat'
import { ChatMessageView } from './ChatMessageView'
import type { DisplayMessage } from './chat-workspace-types'

function assistantMessage(parts: ChatPart[], id: number | string = 12): DisplayMessage {
  return {
    id,
    role: 'assistant',
    parts,
    text: '',
    created_at: '2026-08-22T00:00:00Z',
  }
}

describe('ChatMessageView', () => {
  it('renders user and assistant Markdown messages', () => {
    const userMessage: DisplayMessage = {
      id: 1,
      role: 'user',
      parts: [{ type: 'text', text: '用户问题' }],
      text: '用户问题',
      created_at: '2026-08-22T00:00:00Z',
    }

    render(
      <>
        <ChatMessageView message={userMessage} />
        <ChatMessageView
          message={assistantMessage([{ type: 'text', text: '**助手回答**' }], 2)}
        />
      </>,
    )

    expect(screen.getByText('用户问题')).toBeInTheDocument()
    expect(screen.getByText('助手回答')).toBeInTheDocument()
  })

  it('renders persisted Skill invocations inline with surrounding user text', () => {
    const userMessage: DisplayMessage = {
      id: 3,
      role: 'user',
      parts: [
        { type: 'text', text: '帮我用(' },
        {
          type: 'skill-invocation',
          invocationId: 'one',
          skillName: 'writing-plan',
          displayName: '写作方案',
          parameterDisplayName: 'AI 产品观察',
        },
        { type: 'text', text: ')来写一篇文章' },
        { type: 'skill-pipeline-request', clientMessageId: 'message-1' },
      ],
      text: '帮我用()来写一篇文章',
      created_at: '2026-08-22T00:00:00Z',
    }

    render(<ChatMessageView message={userMessage} />)

    const token = screen.getByText('@写作方案:AI 产品观察')
    expect(token).toHaveAttribute('data-skill-token', 'true')
    expect(token.parentElement).toHaveTextContent('帮我用(@写作方案:AI 产品观察)来写一篇文章')
  })

  it('renders tool approval actions with the persisted message identity', async () => {
    const user = userEvent.setup()
    const onApproval = vi.fn()

    render(
      <ChatMessageView
        message={assistantMessage([{
          type: 'tool-event',
          toolCallId: 'call-1',
          toolName: 'searchInformationSources',
          state: 'approval-requested',
          approval: { id: 'approval-1' },
        }])}
        onApproval={onApproval}
      />,
    )

    await user.click(screen.getByRole('button', { name: '批准' }))
    expect(onApproval).toHaveBeenCalledWith(12, 'call-1', 'approval-1', true)
  })

  it('keeps same-named tools independent when their call ids differ', async () => {
    const user = userEvent.setup()
    const onApproval = vi.fn()

    render(
      <ChatMessageView
        message={assistantMessage([
          {
            type: 'tool-event',
            toolCallId: 'call-1',
            toolName: 'searchInformationSources',
            state: 'approval-requested',
            approval: { id: 'approval-1' },
          },
          {
            type: 'tool-event',
            toolCallId: 'call-2',
            toolName: 'searchInformationSources',
            state: 'approval-requested',
            approval: { id: 'approval-2' },
          },
        ])}
        onApproval={onApproval}
      />,
    )

    const approvals = screen.getAllByRole('button', { name: '批准' })
    expect(approvals).toHaveLength(2)
    await user.click(approvals[1])

    expect(onApproval).toHaveBeenCalledWith(12, 'call-2', 'approval-2', true)
  })
})
