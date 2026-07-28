// @vitest-environment jsdom

import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { CoverStyle } from '@/lib/api/publish-accounts'

import { CoverStyleEditor } from './CoverStyleEditor'

const selectCases = [
  ['type', '类型 type', 'hero', 'h'],
  ['palette', '配色 palette', 'cool', 'c'],
  ['rendering', '渲染 rendering', 'pixel', 'pi'],
  ['text', '文字 text', 'text-rich', 'text'],
  ['mood', '气氛 mood', 'bold', 'bo'],
  ['aspect_ratio', '长宽比 aspect', '16:9', '16'],
] as const

const textareaCases = [
  ['视觉签名（signature_motifs，一行一个）', 'lobster\ngrid'],
  ['禁止元素（negative，一行一个）', 'no people\nno logos'],
] as const

describe('CoverStyleEditor', () => {
  it('associates unique labels with all shared controls', () => {
    render(
      <CoverStyleEditor
        coverStyle={{}}
        onCoverStyleChange={vi.fn()}
        motifsText=""
        onMotifsTextChange={vi.fn()}
        negativeText=""
        onNegativeTextChange={vi.fn()}
      />,
    )

    const selectControls = selectCases.map(([, label]) => screen.getByLabelText(label))
    const textareaControls = textareaCases.map(([label]) => screen.getByLabelText(label))
    const controls = [...selectControls, ...textareaControls]
    const ids = controls.map(control => control.id)
    expect(ids.every(Boolean)).toBe(true)
    expect(new Set(ids).size).toBe(controls.length)
    expect(selectControls.every(control => control.dataset.slot === 'select-trigger')).toBe(true)
    expect(textareaControls.every(control => control.dataset.slot === 'textarea')).toBe(true)
  })

  it.each(selectCases)('updates %s through its labelled select without changing the payload', async (key, label, value, typeahead) => {
    const user = userEvent.setup()
    const onCoverStyleChange = vi.fn()
    const coverStyle: CoverStyle = { type: 'minimal' }
    render(
      <CoverStyleEditor
        coverStyle={coverStyle}
        onCoverStyleChange={onCoverStyleChange}
        motifsText=""
        onMotifsTextChange={vi.fn()}
        negativeText=""
        onNegativeTextChange={vi.fn()}
      />,
    )

    screen.getByLabelText(label).focus()
    await user.keyboard(typeahead)

    expect(onCoverStyleChange).toHaveBeenLastCalledWith({ ...coverStyle, [key]: value })
  })

  it('maps the non-empty unconfigured option back to an empty business value', async () => {
    const user = userEvent.setup()
    const onCoverStyleChange = vi.fn()
    render(
      <CoverStyleEditor
        coverStyle={{ type: 'minimal' }}
        onCoverStyleChange={onCoverStyleChange}
        motifsText=""
        onMotifsTextChange={vi.fn()}
        negativeText=""
        onNegativeTextChange={vi.fn()}
      />,
    )

    screen.getByLabelText('类型 type').focus()
    await user.keyboard('(')

    expect(onCoverStyleChange).toHaveBeenLastCalledWith({ type: '' })
  })

  it('updates both labelled textareas without changing callback payloads', async () => {
    const user = userEvent.setup()
    const onMotifsTextChange = vi.fn()
    const onNegativeTextChange = vi.fn()

    function TextareaHarness() {
      const [motifsText, setMotifsText] = useState('')
      const [negativeText, setNegativeText] = useState('')
      return (
        <CoverStyleEditor
          coverStyle={{}}
          onCoverStyleChange={vi.fn()}
          motifsText={motifsText}
          onMotifsTextChange={value => {
            onMotifsTextChange(value)
            setMotifsText(value)
          }}
          negativeText={negativeText}
          onNegativeTextChange={value => {
            onNegativeTextChange(value)
            setNegativeText(value)
          }}
        />
      )
    }

    render(<TextareaHarness />)
    await user.type(screen.getByLabelText(textareaCases[0][0]), textareaCases[0][1])
    await user.type(screen.getByLabelText(textareaCases[1][0]), textareaCases[1][1])

    expect(onMotifsTextChange).toHaveBeenLastCalledWith('lobster\ngrid')
    expect(onNegativeTextChange).toHaveBeenLastCalledWith('no people\nno logos')
  })
})
