export type XiangongyunInstance = {
  id: string
  create_timestamp?: number
  data_center_name?: string
  name?: string
  public_image?: string
  gpu_model?: string
  gpu_used?: number
  cpu_model?: string
  cpu_core_count?: number
  memory_size?: number
  system_disk_size?: number
  data_disk_size?: number
  expandable_data_disk_size?: number
  data_disk_mount_path?: string
  storage_mount_path?: string
  price_per_hour?: number
  ssh_port?: string
  ssh_user?: string
  jupyter_url?: string
  start_timestamp?: number
  stop_timestamp?: number
  status: string
  ssh_domain?: string
  web_url?: string
  progress?: number
  image_id?: string
  image_type?: string
  image_price?: number
  image_save?: boolean
  base_price?: number
  retain?: number
  retain_price?: number
  retain_size?: number
  [key: string]: unknown
}

export type XiangongyunInstancesResponse = {
  list: XiangongyunInstance[]
  total: number
}

export type XiangongyunConfig = {
  baseUrl: string
  apiToken: string
}

export type EnsureInstanceRunningOptions = {
  pollIntervalMs?: number
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
  checkCancelled?: () => void | Promise<void>
  now?: () => number
}

export class XiangongyunError extends Error {
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
    this.name = 'XiangongyunError'
    this.retryable = input.retryable
    this.code = input.code
    this.status = input.status
  }
}

const TRANSITIONAL_STATUSES = new Set([
  'deploying',
  'booting',
  'shutting_down',
  'saving_image',
  'freezing',
  'replacing_image',
])

const UNAVAILABLE_STATUSES = new Set([
  'destroying',
  'destroyed',
  'freeze',
])

function classifyRetryable(status: number) {
  return status === 408 || status === 429 || status >= 500
}

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/$/, '')
}

function unwrap<T>(payload: unknown): T {
  if (
    payload
    && typeof payload === 'object'
    && 'data' in payload
    && (payload as { data?: unknown }).data !== undefined
  ) {
    return (payload as { data: T }).data
  }
  return payload as T
}

function asInstance(payload: unknown): XiangongyunInstance {
  const instance = unwrap<XiangongyunInstance>(payload)
  if (!instance || typeof instance !== 'object' || typeof instance.id !== 'string') {
    throw new XiangongyunError({
      message: '仙宫云实例响应格式异常',
      retryable: false,
      code: 'invalid_response',
      status: 422,
    })
  }
  return instance
}

function asInstances(payload: unknown): XiangongyunInstancesResponse {
  const result = unwrap<Partial<XiangongyunInstancesResponse>>(payload)
  if (!result || !Array.isArray(result.list)) {
    throw new XiangongyunError({
      message: '仙宫云实例列表响应格式异常',
      retryable: false,
      code: 'invalid_response',
      status: 422,
    })
  }
  return {
    list: result.list as XiangongyunInstance[],
    total: typeof result.total === 'number' ? result.total : result.list.length,
  }
}

export function createXiangongyunClient(config: XiangongyunConfig) {
  const baseUrl = normalizeBaseUrl(config.baseUrl)

  function safeMessage(message: string) {
    return config.apiToken
      ? message.split(config.apiToken).join('***').slice(0, 500)
      : message.slice(0, 500)
  }

  async function request<T>(path: string, init: RequestInit = {}) {
    if (!config.apiToken.trim()) {
      throw new XiangongyunError({
        message: '仙宫云 API Token 未配置',
        retryable: false,
        code: 'missing_api_token',
        status: 422,
      })
    }

    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${config.apiToken}`)
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }

    let response: Response
    try {
      response = await fetch(`${baseUrl}${path}`, {
        ...init,
        method: init.method ?? 'GET',
        headers,
      })
    } catch {
      throw new XiangongyunError({
        message: '无法连接到仙宫云',
        retryable: true,
        code: 'network_error',
        status: 0,
      })
    }

    if (!response.ok) {
      throw new XiangongyunError({
        message: `仙宫云 HTTP ${response.status}`,
        retryable: classifyRetryable(response.status),
        code: response.status === 401 || response.status === 403
          ? 'authentication_failed'
          : response.status === 404
            ? 'instance_not_found'
            : 'request_failed',
        status: response.status,
      })
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new XiangongyunError({
        message: '仙宫云响应格式异常',
        retryable: false,
        code: 'invalid_response',
        status: 422,
      })
    }

    if (
      payload
      && typeof payload === 'object'
      && ('success' in payload || 'code' in payload)
      && (
        (payload as { success?: unknown }).success === false
        || (
          typeof (payload as { code?: unknown }).code === 'number'
          && (payload as { code: number }).code !== 0
        )
      )
    ) {
      const record = payload as { code?: number | string; msg?: unknown; message?: unknown }
      const detail = typeof record.msg === 'string'
        ? record.msg
        : typeof record.message === 'string'
          ? record.message
          : '未知错误'
      throw new XiangongyunError({
        message: safeMessage(`仙宫云操作失败：${detail}`),
        retryable: false,
        code: String(record.code ?? 'provider_error'),
        status: 400,
      })
    }

    return payload as T
  }

  async function getInstances() {
    return asInstances(await request('/open/instances'))
  }

  async function getInstance(instanceId: string) {
    return asInstance(await request(`/open/instance/${encodeURIComponent(instanceId)}`))
  }

  async function bootInstance(instanceId: string) {
    return request<{ code?: number; msg?: string; success?: boolean }>(
      '/open/instance/boot',
      {
        method: 'POST',
        body: JSON.stringify({ id: instanceId }),
      },
    )
  }

  async function shutdownInstance(instanceId: string) {
    return request<{ code?: number; msg?: string; success?: boolean }>(
      '/open/instance/shutdown',
      {
        method: 'POST',
        body: JSON.stringify({ id: instanceId }),
      },
    )
  }

  async function ensureInstanceRunning(
    instanceId: string,
    options: EnsureInstanceRunningOptions = {},
  ) {
    const pollIntervalMs = options.pollIntervalMs ?? 5_000
    const timeoutMs = options.timeoutMs ?? 5 * 60_000
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
    const checkCancelled = options.checkCancelled ?? (() => undefined)
    const now = options.now ?? (() => Date.now())
    const startedAt = now()
    let bootRequested = false

    while (true) {
      await checkCancelled()
      if (now() - startedAt >= timeoutMs) {
        throw new XiangongyunError({
          message: '仙宫云实例启动超时（5 分钟）',
          retryable: true,
          code: 'instance_start_timeout',
          status: 408,
        })
      }

      const instance = await getInstance(instanceId)
      await checkCancelled()

      if (instance.status === 'running') {
        return instance
      }

      if (UNAVAILABLE_STATUSES.has(instance.status)) {
        throw new XiangongyunError({
          message: `仙宫云实例当前不可启动：${instance.status}`,
          retryable: false,
          code: 'instance_unavailable',
          status: 422,
        })
      }

      if (instance.status === 'shutdown' && !bootRequested) {
        await checkCancelled()
        await bootInstance(instanceId)
        bootRequested = true
      } else if (instance.status !== 'shutdown' && !TRANSITIONAL_STATUSES.has(instance.status)) {
        throw new XiangongyunError({
          message: `仙宫云实例状态不可用：${instance.status || 'unknown'}`,
          retryable: false,
          code: 'instance_status_unsupported',
          status: 422,
        })
      }

      await checkCancelled()
      if (now() - startedAt >= timeoutMs) {
        throw new XiangongyunError({
          message: '仙宫云实例启动超时（5 分钟）',
          retryable: true,
          code: 'instance_start_timeout',
          status: 408,
        })
      }
      await sleep(pollIntervalMs)
    }
  }

  return {
    getInstances,
    getInstance,
    bootInstance,
    shutdownInstance,
    ensureInstanceRunning,
  }
}

export type XiangongyunClient = ReturnType<typeof createXiangongyunClient>
