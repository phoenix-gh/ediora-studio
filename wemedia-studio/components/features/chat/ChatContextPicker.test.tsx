import { readFileSync } from 'node:fs'

import { expect, it } from 'vitest'

it('uses one add-context trigger and opens the draft search dialog', () => {
  const source = readFileSync(new URL('./ChatContextPicker.tsx', import.meta.url), 'utf8')

  expect(source).toContain('添加上下文')
  expect(source).toContain('<Popover')
  expect(source).toContain('<Dialog')
  expect(source).toContain('搜索草稿')
  expect(source).not.toContain('<select')
})

it('renders removable chips and filters drafts by title', () => {
  const source = readFileSync(new URL('./ChatContextPicker.tsx', import.meta.url), 'utf8')

  expect(source).toContain('onSkillNameChange(undefined)')
  expect(source).toContain('onDraftIdChange(undefined)')
  expect(source).toContain('draft.title.toLocaleLowerCase().includes(draftQuery.toLocaleLowerCase())')
})
