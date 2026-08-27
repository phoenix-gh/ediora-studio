import { describe, expect, it } from 'vitest'

import {
  MODEL_ERROR_DIAGNOSTIC_PAYLOAD_LIMIT,
  modelErrorEvidenceFromUnknown,
} from './model-error-evidence'

describe('model error evidence', () => {
  it('preserves sanitized bounded AI SDK-style error evidence', () => {
    const secrets = ['message-secret', 'cause-secret', 'text-secret', 'usage-secret', 'response-secret']
    const error = Object.assign(new Error(`Bearer ${secrets[0]}`), {
      name: 'AI_NoObjectGeneratedError',
      text: `token=${secrets[2]}`,
      finishReason: 'length',
      usage: { api_key: secrets[3], inputTokens: 10, outputTokens: 20 },
      response: {
        credentials: { accessToken: secrets[4] },
        url: `https://provider.test/v1/responses?token=${secrets[4]}`,
      },
      cause: new Error(`password=${secrets[1]}`),
    })

    const evidence = modelErrorEvidenceFromUnknown(error)
    const serialized = JSON.stringify(evidence)

    for (const secret of secrets) expect(serialized).not.toContain(secret)
    expect(evidence).toMatchObject({
      name: 'AI_NoObjectGeneratedError',
      message: expect.stringContaining('[REDACTED]'),
      cause: { name: 'Error', message: expect.stringContaining('[REDACTED]') },
      text: expect.stringContaining('[REDACTED]'),
      finishReason: 'length',
      usage: { api_key: '[REDACTED]', inputTokens: 10, outputTokens: 20 },
      response: {
        credentials: '[REDACTED]',
        url: expect.stringContaining('[REDACTED]'),
      },
    })
  })

  it('marks depth truncation and caps broad evidence under the global payload budget', () => {
    const tooDeep = { level: { level: { level: { level: { level: 'beyond-depth-limit' } } } } }
    const broad = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [
      `branch_${index}`,
      { detail: 'x'.repeat(8 * 1024) },
    ]))
    const evidence = modelErrorEvidenceFromUnknown(Object.assign(new Error('No object generated'), {
      response: tooDeep,
      usage: broad,
    }))

    expect(evidence.truncated).toBe(true)
    expect(JSON.stringify(evidence.response)).toContain('[truncated]')
    expect(new TextEncoder().encode(JSON.stringify(evidence)).byteLength)
      .toBeLessThanOrEqual(MODEL_ERROR_DIAGNOSTIC_PAYLOAD_LIMIT)
  })
})
