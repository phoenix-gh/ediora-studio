import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  combineStartupAndCleanupErrors,
  createDeferredTtsLatch,
  E2E_LLM_MODEL,
  E2E_PROVIDER_TOKEN,
  E2E_SPEECH_MODEL,
  E2E_TRANSCRIPTION_MODEL,
  E2E_VOICE_ID,
  resolveE2EPythonLaunch,
  resolveE2ERedisLaunch,
  startTextVideoProviderServer,
  terminateProvisionalProcessGroup,
  type TextVideoProviderServer,
} from '../../e2e/text-video-provider-server'


const servers: TextVideoProviderServer[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.allSettled(servers.splice(0).map(server => server.close()))
})

function speechRequest(text = '真实链路') {
  return {
    model: E2E_SPEECH_MODEL,
    messages: [{ role: 'assistant', content: text }],
    audio: {
      voice: E2E_VOICE_ID,
      format: 'wav',
    },
  }
}

async function postJson(
  server: TextVideoProviderServer,
  body: unknown,
  authorization = `Bearer ${E2E_PROVIDER_TOKEN}`,
) {
  return fetch(`${server.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

function readWav(payload: {
  choices: Array<{ message: { audio: { data: string } } }>
}) {
  return Buffer.from(payload.choices[0].message.audio.data, 'base64')
}

describe('text-video E2E provider', () => {
  it('returns a true one-second 44.1 kHz mono 16-bit PCM WAV for MiMo', async () => {
    const server = await startTextVideoProviderServer()
    servers.push(server)

    const response = await postJson(server, speechRequest())
    expect(response.status).toBe(200)
    const wav = readWav(await response.json())

    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE')
    expect(wav.readUInt16LE(20)).toBe(1)
    expect(wav.readUInt16LE(22)).toBe(1)
    expect(wav.readUInt32LE(24)).toBe(44_100)
    expect(wav.readUInt16LE(34)).toBe(16)
    expect(wav.subarray(36, 40).toString('ascii')).toBe('data')
    expect(wav.readUInt32LE(40)).toBe(44_100 * 2)
    expect(wav.byteLength).toBe(44 + 44_100 * 2)
    expect(server.callCounts.speech).toBe(1)
    expect(server.requestSummaries).toEqual([
      expect.objectContaining({
        kind: 'speech',
        model: E2E_SPEECH_MODEL,
        text: '真实链路',
      }),
    ])
    expect(JSON.stringify(server.requestSummaries)).not.toContain(
      E2E_PROVIDER_TOKEN,
    )
  })

  it('returns strict split output and rejects invalid request classes', async () => {
    const server = await startTextVideoProviderServer({ maxBodyBytes: 512 })
    servers.push(server)
    const split = await postJson(server, {
      model: E2E_LLM_MODEL,
      messages: [{
        role: 'user',
        content: [
          '你是中文口播分段助手。',
          '完整稿件：测试稿件',
          '有序候选边界：['
            + '{"id":"boundary-middle","kind":"sentence","context":"测试｜稿件"},'
            + '{"id":"boundary-late","kind":"pause","context":"稿｜件"}'
            + ']',
        ].join('\n'),
      }],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'response', schema: { type: 'object' } },
      },
    })

    expect(split.status).toBe(200)
    const payload = await split.json() as {
      choices: Array<{ message: { content: string } }>
    }
    expect(JSON.parse(payload.choices[0].message.content)).toEqual({
      boundaries: [{
        id: 'boundary-middle',
        reason: '形成两段真实口播',
      }],
    })
    expect(server.callCounts.split).toBe(1)

    expect((await postJson(
      server,
      speechRequest(),
      'Bearer wrong-token',
    )).status).toBe(401)
    expect((await postJson(server, {
      model: E2E_LLM_MODEL,
      messages: [{ role: 'user', content: '未知提示词' }],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'response', schema: { type: 'object' } },
      },
    })).status).toBe(422)
    expect((await fetch(`${server.baseUrl}/unknown`)).status).toBe(404)
    expect((await fetch(`${server.baseUrl}/chat/completions`)).status).toBe(405)
    expect((await postJson(server, {
      ...speechRequest(),
      extra: 'x'.repeat(1_000),
    })).status).toBe(413)
  })

  it('accepts prompt JSON scene requests without response_format', async () => {
    const server = await startTextVideoProviderServer()
    servers.push(server)
    const response = await postJson(server, {
      model: E2E_LLM_MODEL,
      messages: [{
        role: 'user',
        content: [
          '你是文字视频分镜导演。',
          '生成范围：all',
          '有序词 ID 与文本：[{"id":"word-0-1","text":"真"},'
            + '{"id":"word-1-2","text":"实"}]',
          '口播语义段：[]',
        ].join('\n\n'),
      }],
    })

    expect(response.status).toBe(200)
    const payload = await response.json() as {
      choices: Array<{ message: { content: string } }>
    }
    expect(JSON.parse(payload.choices[0].message.content)).toEqual({
      scenes: [{
        id: 'scene-e2e-1',
        fromWordId: 'word-0-1',
        throughWordId: 'word-1-2',
        displayText: '真实',
        highlight: ['真'],
        animation: 'fade-up',
      }],
    })
    expect(server.callCounts.scene).toBe(1)
    expect(server.requestSummaries[0]).toMatchObject({
      kind: 'scene',
      wordIds: ['word-0-1', 'word-1-2'],
    })
  })

  it('validates multipart transcription and returns verbose_json words', async () => {
    const server = await startTextVideoProviderServer()
    servers.push(server)
    await postJson(server, speechRequest('真实'))
    await postJson(server, speechRequest('链路'))

    const form = new FormData()
    form.append('model', E2E_TRANSCRIPTION_MODEL)
    form.append('response_format', 'verbose_json')
    form.append('timestamp_granularities[]', 'word')
    form.append(
      'file',
      new Blob([Buffer.from('fake-mp3')], { type: 'audio/mpeg' }),
      'master.mp3',
    )
    const response = await fetch(`${server.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${E2E_PROVIDER_TOKEN}` },
      body: form,
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('x-request-id')).toBe(
      'e2e-transcription-request-1',
    )
    expect(await response.json()).toEqual({
      text: '真实链路',
      language: 'zh',
      duration: 2,
      words: [
        { word: '真', start: 0, end: 0.5 },
        { word: '实', start: 0.5, end: 1 },
        { word: '链', start: 1, end: 1.5 },
        { word: '路', start: 1.5, end: 2 },
      ],
    })
    expect(server.callCounts.transcription).toBe(1)
  })

  it('holds a stale TTS response until the deterministic latch is released', async () => {
    const latch = createDeferredTtsLatch()
    const server = await startTextVideoProviderServer({ ttsLatch: latch })
    servers.push(server)
    let resolved = false
    const responsePromise = postJson(server, speechRequest('旧稿'))
      .then(response => {
        resolved = true
        return response
      })

    await latch.waitUntilObserved()
    expect(resolved).toBe(false)
    expect(server.callCounts.speech).toBe(1)

    latch.release()
    expect((await responsePromise).status).toBe(200)
    expect(resolved).toBe(true)
  })

  it('rejects a missing TTS observation within its own timeout', async () => {
    vi.useFakeTimers()
    const latch = createDeferredTtsLatch()
    let error: unknown
    void latch.waitUntilObserved(20).catch(cause => {
      error = cause
    })

    await vi.advanceTimersByTimeAsync(20)

    expect(error).toEqual(new Error('timed out waiting for TTS observation'))
  })

  it('holds only the configured stale speech text', async () => {
    const latch = createDeferredTtsLatch({ text: '需要暂停' })
    let bypassed = false
    const bypass = latch.holdObservedRequest('直接通过').then(() => {
      bypassed = true
    })
    await Promise.resolve()
    expect(bypassed).toBe(true)

    let held = false
    const hold = latch.holdObservedRequest('需要暂停').then(() => {
      held = true
    })
    await latch.waitUntilObserved()
    expect(held).toBe(false)

    latch.release()
    await Promise.all([bypass, hold])
    expect(held).toBe(true)
  })

  it('builds isolated native and Docker Redis launch contracts', () => {
    expect(resolveE2ERedisLaunch({
      nativeAvailable: true,
      port: 19_876,
      dataDirectory: '/tmp/e2e-redis',
      containerName: 'wms-e2e-redis-owned',
      ownerLabel: 'owner-123',
    })).toEqual({
      mode: 'native',
      command: 'redis-server',
      marker: '19876',
      args: [
        '--bind', '127.0.0.1',
        '--protected-mode', 'yes',
        '--port', '19876',
        '--save', '',
        '--appendonly', 'no',
        '--dir', '/tmp/e2e-redis',
      ],
    })
    expect(resolveE2ERedisLaunch({
      nativeAvailable: false,
      port: 19_876,
      dataDirectory: '/tmp/e2e-redis',
      containerName: 'wms-e2e-redis-owned',
      ownerLabel: 'owner-123',
    })).toEqual({
      mode: 'docker',
      command: 'docker',
      marker: 'wms-e2e-redis-owned',
      args: [
        'run', '--rm',
        '--name', 'wms-e2e-redis-owned',
        '--label', 'com.ediora.text-video-e2e.owner=owner-123',
        '--publish', '127.0.0.1:19876:6379',
        '--volume', '/tmp/e2e-redis:/data',
        'redis:7-alpine',
        'redis-server',
        '--bind', '0.0.0.0',
        '--protected-mode', 'no',
        '--port', '6379',
        '--save', '',
        '--appendonly', 'no',
        '--dir', '/data',
      ],
      containerName: 'wms-e2e-redis-owned',
      ownerLabel: 'owner-123',
    })
  })

  it('uses an explicit E2E Python or a non-capturing conda runtime', () => {
    expect(resolveE2EPythonLaunch({
      WMS_E2E_PYTHON: '/opt/e2e/python',
      WMS_CONDA_ENV: 'ignored',
    })).toEqual({
      command: '/opt/e2e/python',
      args: [],
    })
    expect(resolveE2EPythonLaunch({
      WMS_CONDA_ENV: 'wms-test',
    })).toEqual({
      command: 'conda',
      args: [
        'run',
        '--no-capture-output',
        '-n',
        'wms-test',
        'python',
      ],
    })
    expect(resolveE2EPythonLaunch({})).toEqual({
      command: 'conda',
      args: [
        'run',
        '--no-capture-output',
        '-n',
        'wems',
        'python',
      ],
    })
  })

  it('terminates a provisional process group before escalating to SIGKILL', async () => {
    const signals: Array<[number, NodeJS.Signals]> = []
    const waits = [false, true]

    const exited = await terminateProvisionalProcessGroup({
      pid: 41,
      signalGroup: (groupId, signal) => {
        signals.push([groupId, signal])
      },
      waitForExit: async () => waits.shift() ?? false,
    })

    expect(exited).toBe(true)
    expect(signals).toEqual([
      [-41, 'SIGTERM'],
      [-41, 'SIGKILL'],
    ])
  })

  it('preserves the startup error object when cleanup also fails', () => {
    const startup = new Error('API startup failed')
    const combined = combineStartupAndCleanupErrors(
      startup,
      ['Redis container remained'],
    )

    expect(combined).toBeInstanceOf(AggregateError)
    expect((combined as AggregateError).errors).toEqual([
      startup,
      new Error('Redis container remained'),
    ])
  })
})
