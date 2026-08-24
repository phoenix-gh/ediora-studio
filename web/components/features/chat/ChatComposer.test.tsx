// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { SubmittedSkillInvocation } from '@/lib/api/chat'
import { ChatComposer, type ChatComposerProps } from './ChatComposer'

const skills = [{
  name: 'article-drafting',
  displayName: '文章写作',
  description: '按资料写文章',
  version: '1.0.0',
}]

function placeCaretAtEnd(editor: HTMLElement) {
  if (editor instanceof HTMLTextAreaElement) {
    editor.setSelectionRange(editor.value.length, editor.value.length)
    return
  }
  const range = document.createRange()
  range.selectNodeContents(editor)
  range.collapse(false)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

function Harness({ onSubmit = () => true }: { onSubmit?: ChatComposerProps['onSubmit'] }) {
  const [value, setValue] = useState('帮我用(')
  const [invocations, setInvocations] = useState<SubmittedSkillInvocation[]>([])

  return (
    <>
    <ChatComposer
      value={value}
      skills={skills}
      drafts={[]}
      skillName=""
      draftId={null}
      pipelineInvocations={invocations}
      disabled={false}
      variant="page"
      onChange={setValue}
      onSkillNameChange={() => undefined}
      onDraftIdChange={() => undefined}
      onPipelineInvocationsChange={setInvocations}
      onSubmit={onSubmit}
    />
    <output data-testid="invocation-count">{invocations.length}</output>
    <output data-testid="invocation-order">{invocations.map(invocation => invocation.invocationId).join(',')}</output>
    <output data-testid="objective">{value}</output>
    <button type="button" onClick={() => setInvocations([])}>clear-invocations</button>
    </>
  )
}

describe('ChatComposer', () => {
  it('uses a bottom Skill sheet on narrow screens', () => {
    const originalMatchMedia = window.matchMedia
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        matches: query === '(max-width: 639px)',
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => true,
      }),
    })
    const view = render(<Harness />)
    try {
      const editor = screen.getByRole('textbox', { name: '消息内容' })
      placeCaretAtEnd(editor)
      fireEvent.keyDown(editor, { key: '@', shiftKey: true, isComposing: false })

      expect(screen.getByRole('heading', { name: '选择技能' })).toBeInTheDocument()
      expect(document.querySelector('[data-slot="sheet-content"]')).toBeInTheDocument()
    } finally {
      view.unmount()
      Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia })
    }
  })

  it('opens the Skill picker for a keyboard @ produced with Shift', () => {
    render(<Harness />)

    const editor = screen.getByRole('textbox', { name: '消息内容' })
    placeCaretAtEnd(editor)
    fireEvent.keyDown(editor, { key: '@', shiftKey: true, isComposing: false })

    expect(screen.getByPlaceholderText('搜索技能')).toBeInTheDocument()
    expect(editor).toHaveTextContent('帮我用(@')
    expect(screen.getByTestId('objective')).toHaveTextContent('帮我用(@')
  })

  it('keeps a typed @ as ordinary text until a Skill is confirmed', () => {
    render(<Harness />)

    const editor = screen.getByRole('textbox', { name: '消息内容' })
    placeCaretAtEnd(editor)
    fireEvent.keyDown(editor, { key: '@', isComposing: false })

    expect(editor.querySelector('[data-skill-invocation-id]')).not.toBeInTheDocument()
    expect(editor).toHaveTextContent('帮我用(@')
  })

  it('inserts a selected Skill as an inline atomic token at the caret', () => {
    render(<Harness />)

    const editor = screen.getByRole('textbox', { name: '消息内容' })
    expect(screen.queryByRole('button', { name: '@ 添加技能' })).not.toBeInTheDocument()
    placeCaretAtEnd(editor)
    fireEvent.keyDown(editor, { key: '@', shiftKey: false, isComposing: false })
    fireEvent.click(screen.getByRole('button', { name: /文章写作/ }))

    const token = screen.getByText('@文章写作')
    expect(token).toHaveAttribute('contenteditable', 'false')
    expect(token.closest('[contenteditable="true"]')).toBe(editor)
    expect(editor).toHaveTextContent('帮我用(@文章写作')
    expect(screen.queryByRole('button', { name: '移除技能：@文章写作' })).not.toBeInTheDocument()
  })

  it('removes the whole inline Skill token with one Backspace', () => {
    render(<Harness />)

    const editor = screen.getByRole('textbox', { name: '消息内容' })
    placeCaretAtEnd(editor)
    fireEvent.keyDown(editor, { key: '@', shiftKey: false, isComposing: false })
    fireEvent.click(screen.getByRole('button', { name: /文章写作/ }))
    const token = screen.getByText('@文章写作')
    const range = document.createRange()
    range.setStartAfter(token)
    range.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)

    fireEvent.keyDown(editor, { key: 'Backspace' })

    expect(screen.queryByText('@文章写作')).not.toBeInTheDocument()
    expect(screen.getByTestId('invocation-count')).toHaveTextContent('0')
    expect(screen.getByTestId('objective')).toHaveTextContent('帮我用(')
  })

  it('synchronizes the structured invocation when a selected token is deleted', () => {
    render(<Harness />)

    const editor = screen.getByRole('textbox', { name: '消息内容' })
    placeCaretAtEnd(editor)
    fireEvent.keyDown(editor, { key: '@', shiftKey: false, isComposing: false })
    fireEvent.click(screen.getByRole('button', { name: /文章写作/ }))
    editor.querySelector('[data-skill-invocation-id]')?.remove()
    fireEvent.input(editor)

    expect(screen.getByTestId('invocation-count')).toHaveTextContent('0')
    expect(screen.getByTestId('objective')).toHaveTextContent('帮我用(')
  })

  it('removes stale token DOM when structured invocations are cleared externally', () => {
    render(<Harness />)

    const editor = screen.getByRole('textbox', { name: '消息内容' })
    placeCaretAtEnd(editor)
    fireEvent.keyDown(editor, { key: '@', isComposing: false })
    fireEvent.click(screen.getByRole('button', { name: /文章写作/ }))
    fireEvent.click(screen.getByRole('button', { name: 'clear-invocations' }))

    expect(editor.querySelector('[data-skill-invocation-id]')).not.toBeInTheDocument()
    expect(editor).toHaveTextContent('帮我用(')
  })

  it('updates the objective when a Skill replaces selected text', () => {
    render(<Harness />)

    const editor = screen.getByRole('textbox', { name: '消息内容' })
    const textNode = editor.firstChild!
    const range = document.createRange()
    range.setStart(textNode, 0)
    range.setEnd(textNode, 2)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    fireEvent.keyDown(editor, { key: '@', isComposing: false })
    fireEvent.click(screen.getByRole('button', { name: /文章写作/ }))

    expect(screen.getByTestId('objective')).toHaveTextContent('用(')
    expect(editor).toHaveTextContent('@文章写作用(')
  })

  it('submits ordered message parts while keeping Skill tokens out of the objective', () => {
    const onSubmit = vi.fn(() => true)
    render(<Harness onSubmit={onSubmit} />)

    const editor = screen.getByRole('textbox', { name: '消息内容' })
    placeCaretAtEnd(editor)
    fireEvent.keyDown(editor, { key: '@', shiftKey: false, isComposing: false })
    fireEvent.click(screen.getByRole('button', { name: /文章写作/ }))
    editor.append(document.createTextNode(')来写一篇文章'))
    fireEvent.input(editor)
    fireEvent.submit(editor.closest('form')!)

    expect(onSubmit).toHaveBeenCalledWith(
      '帮我用()来写一篇文章',
      [
        { type: 'text', text: '帮我用(' },
        expect.objectContaining({
          type: 'skill-invocation',
          invocationId: expect.any(String),
          skillName: 'article-drafting',
          skillDisplayName: '文章写作',
        }),
        { type: 'text', text: ')来写一篇文章' },
      ],
    )
  })

  it('pastes readable @ text as plain text without creating another Skill token', () => {
    render(<Harness />)

    const editor = screen.getByRole('textbox', { name: '消息内容' })
    placeCaretAtEnd(editor)
    fireEvent.keyDown(editor, { key: '@', shiftKey: false, isComposing: false })
    fireEvent.click(screen.getByRole('button', { name: /文章写作/ }))
    placeCaretAtEnd(editor)

    fireEvent.paste(editor, {
      clipboardData: { getData: () => '@文章写作' },
    })

    expect(editor.querySelectorAll('[data-skill-invocation-id]')).toHaveLength(1)
    expect(editor).toHaveTextContent('帮我用(@文章写作@文章写作')
    expect(screen.getByTestId('invocation-count')).toHaveTextContent('1')
  })

  it('keeps structured invocations in the same order as tokens inserted before existing tokens', () => {
    render(<Harness />)

    const editor = screen.getByRole('textbox', { name: '消息内容' })
    placeCaretAtEnd(editor)
    fireEvent.keyDown(editor, { key: '@', isComposing: false })
    fireEvent.click(screen.getByRole('button', { name: /文章写作/ }))

    const range = document.createRange()
    range.setStart(editor, 0)
    range.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    fireEvent.keyDown(editor, { key: '@', isComposing: false })
    fireEvent.click(screen.getByRole('button', { name: /文章写作/ }))

    const tokenOrder = Array.from(editor.querySelectorAll<HTMLElement>('[data-skill-invocation-id]'))
      .map(token => token.dataset.skillInvocationId)
      .join(',')
    expect(screen.getByTestId('invocation-order')).toHaveTextContent(tokenOrder)
  })

  it('removes the structured invocation when plain-text paste replaces a token', () => {
    render(<Harness />)

    const editor = screen.getByRole('textbox', { name: '消息内容' })
    placeCaretAtEnd(editor)
    fireEvent.keyDown(editor, { key: '@', isComposing: false })
    fireEvent.click(screen.getByRole('button', { name: /文章写作/ }))
    const token = editor.querySelector<HTMLElement>('[data-skill-invocation-id]')!
    const range = document.createRange()
    range.selectNode(token)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)

    fireEvent.paste(editor, {
      clipboardData: { getData: () => '@文章写作' },
    })

    expect(editor.querySelectorAll('[data-skill-invocation-id]')).toHaveLength(0)
    expect(screen.getByTestId('invocation-count')).toHaveTextContent('0')
  })

  it('removes an atomic token adjacent to a caret inside a nested block', () => {
    render(<Harness />)

    const editor = screen.getByRole('textbox', { name: '消息内容' })
    placeCaretAtEnd(editor)
    fireEvent.keyDown(editor, { key: '@', isComposing: false })
    fireEvent.click(screen.getByRole('button', { name: /文章写作/ }))
    const token = editor.querySelector<HTMLElement>('[data-skill-invocation-id]')!
    const line = document.createElement('div')
    line.append(token)
    editor.append(line)
    const range = document.createRange()
    range.setStart(line, line.childNodes.length)
    range.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)

    fireEvent.keyDown(editor, { key: 'Backspace', isComposing: false })

    expect(editor.querySelector('[data-skill-invocation-id]')).not.toBeInTheDocument()
    expect(screen.getByTestId('invocation-count')).toHaveTextContent('0')
  })

  it('preserves contenteditable block breaks as message newlines', () => {
    const onSubmit = vi.fn(() => true)
    render(<Harness onSubmit={onSubmit} />)

    const editor = screen.getByRole('textbox', { name: '消息内容' })
    const secondLine = document.createElement('div')
    secondLine.textContent = '第二行'
    editor.replaceChildren(document.createTextNode('第一行'), secondLine)
    fireEvent.input(editor)
    fireEvent.submit(editor.closest('form')!)

    expect(screen.getByTestId('objective').textContent).toBe('')
    expect(onSubmit).toHaveBeenCalledWith('第一行\n第二行', [{ type: 'text', text: '第一行\n第二行' }])
  })
})
