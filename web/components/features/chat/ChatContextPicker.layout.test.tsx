// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'

import { ChatContextPicker } from './ChatContextPicker'

it('fills the composer action row so the footer action can align to the far right', () => {
  render(
    <ChatContextPicker
      skills={[]}
      drafts={[]}
      disabled={false}
      footerAction={<button type="button">发送消息</button>}
      onSkillNameChange={() => undefined}
      onDraftIdChange={() => undefined}
    />,
  )

  const actionRow = screen.getByRole('button', { name: '发送消息' }).parentElement?.parentElement
  expect(actionRow).toHaveClass('min-w-0', 'flex-1')
})
