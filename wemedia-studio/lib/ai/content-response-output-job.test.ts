import { describe, expect, it } from 'vitest'

import { outputInstructions } from './content-response-output-job'


describe('content response output instructions', () => {
  it('keeps every output editable and forbids publishing', () => {
    expect(outputInstructions('x_share')).toContain('不得发布')
    expect(outputInstructions('expanded_article')).toContain('Markdown')
    expect(outputInstructions('commentary')).toContain('个人判断')
  })
})
