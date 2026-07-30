import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'


export const E2E_PROVIDER_TOKEN = 'task12-provider-dummy-token'
export const E2E_LLM_MODEL = 'task12-structured-output'
export const E2E_SPEECH_MODEL = 'mimo-v2.5-tts'
export const E2E_TRANSCRIPTION_MODEL = 'task12-whisper'
export const E2E_VOICE_ID = 'task12-voice'

const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024
const CHAT_PATH = '/v1/chat/completions'
const TRANSCRIPTION_PATH = '/v1/audio/transcriptions'
export const E2E_REDIS_OWNER_LABEL =
  'com.ediora.text-video-e2e.owner'

export type E2ERedisLaunch = {
  mode: 'native' | 'docker'
  command: string
  args: string[]
  marker: string
  containerName?: string
  ownerLabel?: string
}

export function resolveE2ERedisLaunch({
  nativeAvailable,
  port,
  dataDirectory,
  containerName,
  ownerLabel,
}: {
  nativeAvailable: boolean
  port: number
  dataDirectory: string
  containerName: string
  ownerLabel: string
}): E2ERedisLaunch {
  if (nativeAvailable) {
    return {
      mode: 'native',
      command: 'redis-server',
      marker: String(port),
      args: [
        '--bind', '127.0.0.1',
        '--protected-mode', 'yes',
        '--port', String(port),
        '--save', '',
        '--appendonly', 'no',
        '--dir', dataDirectory,
      ],
    }
  }
  return {
    mode: 'docker',
    command: 'docker',
    marker: containerName,
    args: [
      'run', '--rm',
      '--name', containerName,
      '--label', `${E2E_REDIS_OWNER_LABEL}=${ownerLabel}`,
      '--publish', `127.0.0.1:${port}:6379`,
      '--volume', `${dataDirectory}:/data`,
      'redis:7-alpine',
      'redis-server',
      '--bind', '0.0.0.0',
      '--protected-mode', 'no',
      '--port', '6379',
      '--save', '',
      '--appendonly', 'no',
      '--dir', '/data',
    ],
    containerName,
    ownerLabel,
  }
}

export function resolveE2EPythonLaunch(
  environment: Partial<Pick<
    NodeJS.ProcessEnv,
    'WMS_E2E_PYTHON' | 'WMS_CONDA_ENV'
  >>,
) {
  const explicit = environment.WMS_E2E_PYTHON?.trim()
  if (explicit) return { command: explicit, args: [] as string[] }
  return {
    command: 'conda',
    args: [
      'run',
      '--no-capture-output',
      '-n',
      environment.WMS_CONDA_ENV?.trim() || 'wems',
      'python',
    ],
  }
}

export type ProviderCallKind =
  | 'speech'
  | 'split'
  | 'scene'
  | 'transcription'

export type ProviderRequestSummary = {
  kind: ProviderCallKind
  model: string
  text?: string
  wordIds?: string[]
  bytes?: number
}

export class DeferredTtsLatch {
  private observed = false
  private released = false
  private resolveObserved!: () => void
  private resolveReleased!: () => void
  private readonly observedPromise = new Promise<void>(resolve => {
    this.resolveObserved = resolve
  })
  private readonly releasedPromise = new Promise<void>(resolve => {
    this.resolveReleased = resolve
  })

  waitUntilObserved(): Promise<void> {
    return this.observedPromise
  }

  release(): void {
    if (this.released) return
    this.released = true
    this.resolveReleased()
  }

  async holdObservedRequest(): Promise<void> {
    if (!this.observed) {
      this.observed = true
      this.resolveObserved()
    }
    await this.releasedPromise
  }
}

export function createDeferredTtsLatch(): DeferredTtsLatch {
  return new DeferredTtsLatch()
}

export type TextVideoProviderServer = {
  origin: string
  baseUrl: string
  callCounts: Record<ProviderCallKind, number>
  requestSummaries: ProviderRequestSummary[]
  close(): Promise<void>
}

export type TextVideoProviderServerOptions = {
  authToken?: string
  maxBodyBytes?: number
  ttsLatch?: DeferredTtsLatch
}

class ProviderRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function hasExactKeys(record: JsonRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort()
  return actual.length === keys.length
    && actual.every((key, index) => key === [...keys].sort()[index])
}

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const bytes = Buffer.from(JSON.stringify(body))
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': String(bytes.byteLength),
    'Cache-Control': 'no-store',
    ...headers,
  })
  response.end(bytes)
}

async function readBoundedBody(
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<Buffer> {
  const declared = Number(request.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBodyBytes) {
    request.resume()
    throw new ProviderRequestError(413, 'request body too large')
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += bytes.byteLength
    if (total > maxBodyBytes) {
      request.resume()
      throw new ProviderRequestError(413, 'request body too large')
    }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

function parseJsonBody(bytes: Buffer): JsonRecord {
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new ProviderRequestError(400, 'request body must be JSON')
  }
  if (!isRecord(value)) {
    throw new ProviderRequestError(422, 'request body must be an object')
  }
  return value
}

function messageText(value: unknown): string {
  if (!isRecord(value) || !hasExactKeys(value, ['content', 'role'])) {
    throw new ProviderRequestError(422, 'invalid chat message')
  }
  if (
    !['user', 'assistant'].includes(String(value.role))
    || typeof value.content !== 'string'
    || !value.content
  ) {
    throw new ProviderRequestError(422, 'invalid chat message')
  }
  return value.content
}

function validateSpeechRequest(body: JsonRecord): string {
  if (
    !hasExactKeys(body, ['audio', 'messages', 'model'])
    || body.model !== E2E_SPEECH_MODEL
    || !Array.isArray(body.messages)
    || body.messages.length < 1
    || body.messages.length > 2
    || !isRecord(body.audio)
    || !hasExactKeys(body.audio, ['format', 'voice'])
    || body.audio.format !== 'wav'
    || body.audio.voice !== E2E_VOICE_ID
  ) {
    throw new ProviderRequestError(422, 'invalid MiMo speech request')
  }
  const messages = body.messages as unknown[]
  messages.forEach(messageText)
  const final = messages.at(-1)
  if (!isRecord(final) || final.role !== 'assistant') {
    throw new ProviderRequestError(422, 'speech text must be an assistant message')
  }
  if (
    messages.length === 2
    && (!isRecord(messages[0]) || messages[0].role !== 'user')
  ) {
    throw new ProviderRequestError(422, 'invalid speech style message')
  }
  return messageText(final)
}

function validateStructuredRequest(body: JsonRecord): string {
  if (
    !hasExactKeys(body, ['messages', 'model', 'response_format'])
    || body.model !== E2E_LLM_MODEL
    || !Array.isArray(body.messages)
    || body.messages.length !== 1
    || !isRecord(body.response_format)
    || body.response_format.type !== 'json_schema'
    || !isRecord(body.response_format.json_schema)
  ) {
    throw new ProviderRequestError(422, 'invalid structured-output request')
  }
  const message = body.messages[0]
  if (!isRecord(message) || message.role !== 'user') {
    throw new ProviderRequestError(422, 'structured prompt must be a user message')
  }
  return messageText(message)
}

function extractSceneWords(prompt: string): Array<{ id: string; text: string }> {
  const match = prompt.match(
    /有序词 ID 与文本：(\[[\s\S]*?\])(?:\r?\n){2}口播语义段：/u,
  )
  if (!match) {
    throw new ProviderRequestError(422, 'scene prompt lacks stable words')
  }
  let value: unknown
  try {
    value = JSON.parse(match[1])
  } catch {
    throw new ProviderRequestError(422, 'scene words are invalid JSON')
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new ProviderRequestError(422, 'scene prompt has no words')
  }
  const words = value.flatMap(item => (
    isRecord(item)
    && typeof item.id === 'string'
    && item.id
    && typeof item.text === 'string'
    && item.text
      ? [{ id: item.id, text: item.text }]
      : []
  ))
  if (words.length !== value.length || new Set(
    words.map(word => word.id),
  ).size !== words.length) {
    throw new ProviderRequestError(422, 'scene prompt words are invalid')
  }
  return words
}

function chatCompletion(model: string, content: unknown, id: string) {
  return {
    id,
    object: 'chat.completion',
    created: 1_700_000_000,
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: JSON.stringify(content),
      },
      finish_reason: 'stop',
    }],
    usage: {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
    },
  }
}

function pcmWav(): Buffer {
  const sampleRate = 44_100
  const sampleCount = 44_100
  const channels = 1
  const bitsPerSample = 16
  const dataBytes = sampleCount * channels * bitsPerSample / 8
  const wav = Buffer.alloc(44 + dataBytes)
  wav.write('RIFF', 0, 'ascii')
  wav.writeUInt32LE(wav.byteLength - 8, 4)
  wav.write('WAVE', 8, 'ascii')
  wav.write('fmt ', 12, 'ascii')
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(channels, 22)
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28)
  wav.writeUInt16LE(channels * bitsPerSample / 8, 32)
  wav.writeUInt16LE(bitsPerSample, 34)
  wav.write('data', 36, 'ascii')
  wav.writeUInt32LE(dataBytes, 40)
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const value = Math.round(
      Math.sin(2 * Math.PI * 440 * sample / sampleRate) * 2_400,
    )
    wav.writeInt16LE(value, 44 + sample * 2)
  }
  return wav
}

type MultipartPart = {
  name: string
  filename?: string
  contentType?: string
  bytes: Buffer
}

function parseMultipart(
  bytes: Buffer,
  contentType: string | undefined,
): MultipartPart[] {
  const boundary = contentType?.match(
    /^multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;\s]+))$/iu,
  )?.slice(1).find(Boolean)
  if (!boundary) {
    throw new ProviderRequestError(422, 'invalid multipart content type')
  }
  const marker = `--${boundary}`
  const source = bytes.toString('latin1')
  const rawParts = source.split(marker).slice(1, -1)
  const parts = rawParts.map(raw => {
    const normalized = raw.startsWith('\r\n') ? raw.slice(2) : raw
    const headerEnd = normalized.indexOf('\r\n\r\n')
    if (headerEnd < 0 || !normalized.endsWith('\r\n')) {
      throw new ProviderRequestError(422, 'invalid multipart part')
    }
    const headerText = normalized.slice(0, headerEnd)
    const payload = normalized.slice(headerEnd + 4, -2)
    const disposition = headerText.match(
      /(?:^|\r\n)content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/iu,
    )
    if (!disposition) {
      throw new ProviderRequestError(422, 'invalid multipart disposition')
    }
    const partContentType = headerText.match(
      /(?:^|\r\n)content-type:\s*([^\r\n]+)/iu,
    )?.[1]?.trim()
    return {
      name: disposition[1],
      ...(disposition[2] === undefined
        ? {}
        : { filename: disposition[2] }),
      ...(partContentType ? { contentType: partContentType } : {}),
      bytes: Buffer.from(payload, 'latin1'),
    }
  })
  if (parts.length !== 4 || new Set(
    parts.map(part => part.name),
  ).size !== parts.length) {
    throw new ProviderRequestError(422, 'invalid multipart fields')
  }
  return parts
}

function partText(part: MultipartPart | undefined): string {
  return part?.bytes.toString('utf8') ?? ''
}

function transcriptionText(
  parts: MultipartPart[],
  latestSpeechText: string,
): string {
  const byName = new Map(parts.map(part => [part.name, part]))
  const file = byName.get('file')
  if (
    partText(byName.get('model')) !== E2E_TRANSCRIPTION_MODEL
    || partText(byName.get('response_format')) !== 'verbose_json'
    || partText(byName.get('timestamp_granularities[]')) !== 'word'
    || !file?.filename
    || file.contentType !== 'audio/mpeg'
    || file.bytes.length === 0
    || !latestSpeechText
  ) {
    throw new ProviderRequestError(422, 'invalid transcription request')
  }
  return latestSpeechText
}

function isCjk(character: string): boolean {
  const codepoint = character.codePointAt(0) ?? 0
  return (
    (codepoint >= 0x2E80 && codepoint <= 0x2FFF)
    || (codepoint >= 0x3040 && codepoint <= 0x30FF)
    || (codepoint >= 0x3400 && codepoint <= 0x9FFF)
    || (codepoint >= 0xF900 && codepoint <= 0xFAFF)
  )
}

function transcriptTokens(text: string): string[] {
  const tokens: string[] = []
  let alphanumeric = ''
  const flush = () => {
    if (alphanumeric) tokens.push(alphanumeric)
    alphanumeric = ''
  }
  for (const character of text) {
    if (isCjk(character)) {
      flush()
      tokens.push(character)
    } else if (/[\p{L}\p{N}]/u.test(character)) {
      alphanumeric += character
    } else {
      flush()
    }
  }
  flush()
  return tokens
}

function verboseTranscription(text: string) {
  const words = transcriptTokens(text)
  if (!words.length) {
    throw new ProviderRequestError(422, 'speech text has no tokens')
  }
  return {
    text,
    language: 'zh',
    duration: 1,
    words: words.map((word, index) => ({
      word,
      start: index / words.length,
      end: (index + 1) / words.length,
    })),
  }
}

export async function startTextVideoProviderServer(
  options: TextVideoProviderServerOptions = {},
): Promise<TextVideoProviderServer> {
  const authToken = options.authToken ?? E2E_PROVIDER_TOKEN
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  if (!authToken || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new Error('invalid E2E provider options')
  }
  const callCounts: Record<ProviderCallKind, number> = {
    speech: 0,
    split: 0,
    scene: 0,
    transcription: 0,
  }
  const requestSummaries: ProviderRequestSummary[] = []
  let latestSpeechText = ''

  const server = createServer(async (request, response) => {
    try {
      const path = new URL(
        request.url ?? '/',
        'http://127.0.0.1',
      ).pathname
      if (path !== CHAT_PATH && path !== TRANSCRIPTION_PATH) {
        json(response, 404, { error: { message: 'unknown path' } })
        return
      }
      if (request.method !== 'POST') {
        json(response, 405, { error: { message: 'method not allowed' } }, {
          Allow: 'POST',
        })
        return
      }
      if (request.headers.authorization !== `Bearer ${authToken}`) {
        json(response, 401, { error: { message: 'invalid dummy bearer' } })
        return
      }
      const bodyBytes = await readBoundedBody(request, maxBodyBytes)

      if (path === TRANSCRIPTION_PATH) {
        const parts = parseMultipart(
          bodyBytes,
          request.headers['content-type'],
        )
        const text = transcriptionText(parts, latestSpeechText)
        callCounts.transcription += 1
        requestSummaries.push({
          kind: 'transcription',
          model: E2E_TRANSCRIPTION_MODEL,
          bytes: parts.find(part => part.name === 'file')?.bytes.length,
        })
        json(response, 200, verboseTranscription(text), {
          'X-Request-Id': `e2e-transcription-request-${callCounts.transcription}`,
        })
        return
      }

      if (request.headers['content-type'] !== 'application/json') {
        throw new ProviderRequestError(422, 'chat content type must be JSON')
      }
      const body = parseJsonBody(bodyBytes)
      if ('audio' in body) {
        const text = validateSpeechRequest(body)
        callCounts.speech += 1
        latestSpeechText = text
        requestSummaries.push({
          kind: 'speech',
          model: E2E_SPEECH_MODEL,
          text,
        })
        await options.ttsLatch?.holdObservedRequest()
        const audio = pcmWav().toString('base64')
        json(response, 200, {
          id: `e2e-speech-request-${callCounts.speech}`,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              audio: { data: audio },
            },
            finish_reason: 'stop',
          }],
        })
        return
      }

      const prompt = validateStructuredRequest(body)
      if (prompt.includes('你是中文口播分段助手')) {
        callCounts.split += 1
        requestSummaries.push({
          kind: 'split',
          model: E2E_LLM_MODEL,
        })
        json(response, 200, chatCompletion(
          E2E_LLM_MODEL,
          { boundaries: [] },
          `e2e-split-request-${callCounts.split}`,
        ))
        return
      }
      if (prompt.includes('你是文字视频分镜导演')) {
        const words = extractSceneWords(prompt)
        const displayText = words.map(word => word.text).join('').trim()
        if (!displayText) {
          throw new ProviderRequestError(422, 'scene display text is empty')
        }
        callCounts.scene += 1
        requestSummaries.push({
          kind: 'scene',
          model: E2E_LLM_MODEL,
          wordIds: words.map(word => word.id),
        })
        json(response, 200, chatCompletion(
          E2E_LLM_MODEL,
          {
            scenes: [{
              id: 'scene-e2e-1',
              fromWordId: words[0].id,
              throughWordId: words.at(-1)!.id,
              displayText,
              highlight: [words[0].text.trim()],
              animation: 'fade-up',
            }],
          },
          `e2e-scene-request-${callCounts.scene}`,
        ))
        return
      }
      throw new ProviderRequestError(422, 'unknown structured prompt class')
    } catch (error) {
      if (response.headersSent) {
        response.end()
        return
      }
      const status = error instanceof ProviderRequestError
        ? error.status
        : 500
      const message = error instanceof Error
        ? error.message.slice(0, 300)
        : 'provider error'
      json(response, status, { error: { message } })
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  const origin = `http://127.0.0.1:${address.port}`
  let closed = false
  return {
    origin,
    baseUrl: `${origin}/v1`,
    callCounts,
    requestSummaries,
    async close() {
      if (closed) return
      closed = true
      options.ttsLatch?.release()
      await new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error) reject(error)
          else resolve()
        })
        server.closeAllConnections()
      })
    },
  }
}
