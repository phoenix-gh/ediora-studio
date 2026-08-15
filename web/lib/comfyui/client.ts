export type ComfyUIConfig = {
  baseUrl: string
  authToken?: string
}

export type ComfyUIHistoryItem = {
  status: { completed?: boolean; status_str?: string }
  outputs: Record<string, { images?: Array<{
    filename: string
    subfolder: string
    type: string
  }>; gifs?: Array<{
    filename: string
    subfolder: string
    type: string
  }> }>
}

export class ComfyUIError extends Error {
  retryable: boolean
  code: string
  status: number

  constructor(input: {
    message: string
    retryable: boolean
    code: string
    status: number
  }) {
    super(input.message)
    this.name = 'ComfyUIError'
    this.retryable = input.retryable
    this.code = input.code
    this.status = input.status
  }
}


function classifyRetryable(status: number) {
  return status === 408 || status === 429 || status >= 500
}


export function createComfyUIClient(config: ComfyUIConfig) {
  const baseUrl = config.baseUrl.replace(/\/$/, '')

  function headers(init?: HeadersInit) {
    const next = new Headers(init)
    if (config.authToken) {
      next.set('Authorization', `Bearer ${config.authToken}`)
    }
    return next
  }

  async function request(path: string, init: RequestInit = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: headers(init.headers),
    })
    if (!response.ok) {
      throw new ComfyUIError({
        message: `ComfyUI HTTP ${response.status}`,
        retryable: classifyRetryable(response.status),
        code: response.status === 401 || response.status === 403
          ? 'authentication_failed'
          : 'request_failed',
        status: response.status,
      })
    }
    return response
  }

  async function uploadInput(
    bytes: Uint8Array,
    filename: string,
    overwrite = true,
  ) {
    const body = new FormData()
    const upload = new Uint8Array(bytes.byteLength)
    upload.set(bytes)
    body.set('image', new Blob([upload]), filename)
    body.set('overwrite', overwrite ? 'true' : 'false')
    const response = await request('/upload/image', {
      method: 'POST',
      body,
    })
    return response.json() as Promise<{ name: string; subfolder: string; type: string }>
  }

  return {
    async systemStats() {
      const response = await request('/system_stats')
      return response.json() as Promise<Record<string, unknown>>
    },

    async uploadImage(
      bytes: Uint8Array,
      filename: string,
      overwrite = true,
    ) {
      return uploadInput(bytes, filename, overwrite)
    },

    async uploadAudio(
      bytes: Uint8Array,
      filename: string,
      overwrite = true,
    ) {
      return uploadInput(bytes, filename, overwrite)
    },

    async queuePrompt(prompt: Record<string, unknown>, clientId?: string) {
      const response = await request('/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, client_id: clientId }),
      })
      const data = await response.json() as { prompt_id?: string }
      if (!data.prompt_id) {
        throw new ComfyUIError({
          message: 'ComfyUI 未返回 prompt_id',
          retryable: false,
          code: 'invalid_response',
          status: 422,
        })
      }
      return data.prompt_id
    },

    async getHistory(promptId: string) {
      const response = await request(`/history/${encodeURIComponent(promptId)}`)
      const data = await response.json() as Record<string, ComfyUIHistoryItem>
      return data[promptId] ?? null
    },

    async getQueue() {
      const response = await request('/queue')
      return response.json() as Promise<{
        queue_running: unknown[]
        queue_pending: unknown[]
      }>
    },

    async viewFile(file: {
      filename: string
      subfolder?: string
      type?: string
    }) {
      const params = new URLSearchParams({ filename: file.filename })
      if (file.subfolder) params.set('subfolder', file.subfolder)
      if (file.type) params.set('type', file.type)
      const response = await request(`/view?${params.toString()}`)
      return new Uint8Array(await response.arrayBuffer())
    },
  }
}

export type ComfyUIClient = ReturnType<typeof createComfyUIClient>
