import { describe, expect, it } from 'vitest'

import { parseTopicSourceDecision } from './topic-source-job'

describe('topic source AI decision contract', () => {
  it('keeps only tweet IDs supplied in the JSON decision', () => {
    expect(parseTopicSourceDecision('```json\n{"accepted_tweet_ids":["a","b"]}\n```')).toEqual({
      accepted_tweet_ids: ['a', 'b'],
    })
  })

  it('rejects malformed decision data', () => {
    expect(() => parseTopicSourceDecision('{"accepted_tweet_ids":"a"}')).toThrow()
  })
})
