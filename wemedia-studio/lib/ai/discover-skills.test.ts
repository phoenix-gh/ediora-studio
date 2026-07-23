import { describe, expect, it } from 'vitest'

import { discoverSkills } from './discover-skills'

describe('discoverSkills', () => {
  it('automatically lists every local skill with a named frontmatter block', async () => {
    const skills = await discoverSkills()

    expect(skills.map(skill => skill.name)).toEqual(expect.arrayContaining([
      'baoyu-article-illustrator',
      'baoyu-cover-image',
    ]))
    expect(skills).toEqual([...skills].sort((left, right) => left.name.localeCompare(right.name)))
    expect(skills.find(skill => skill.name === 'baoyu-cover-image')).toMatchObject({
      description: expect.any(String),
      version: expect.any(String),
      instructions: expect.stringContaining('baoyu-cover-image'),
    })
  })
})
