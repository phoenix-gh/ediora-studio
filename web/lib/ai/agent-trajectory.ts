export const agentSessionEventTypes = [
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'user/message',
  'assistant/chunk',
  'assistant/message',
  'tool/call',
  'tool/result',
  'request/header',
  'agent/skill',
] as const

export type AgentSessionEventType = (typeof agentSessionEventTypes)[number]

export type AgentSessionEvent = {
  seq: number
  time: number
  type: AgentSessionEventType
  turn: number | null
  step: number | null
  data: Record<string, unknown>
  sourceEventSeqs?: number[]
}

export type TrajectoryStatus = 'running' | 'completed' | 'error' | 'aborted' | 'interrupted' | 'waiting_approval'

export type TrajectoryCell = {
  recordId: string
  kind: 'system' | 'user' | 'context' | 'message' | 'tool' | 'subtool'
  turn: number
  step: number | null
  sourceEventSeqs: number[]
  status: TrajectoryStatus
  timeSeconds: number | null
  title?: string
  text?: string
  thinkingDetail?: string
  inputDetail?: string
  outputDetail?: string
  error?: string
  toolName?: string
  callId?: string
  usage?: Record<string, unknown>
  timing?: Record<string, unknown>
  provider?: string
  model?: string
  data?: Record<string, unknown>
}

export type TrajectoryGroup = {
  recordId: string
  title: string
  kind: 'message' | 'step'
  turn: number
  step: number | null
  phase: string | null
  cells: TrajectoryCell[]
}

export type TrajectoryTurn = {
  recordId: string
  turn: number
  status: TrajectoryStatus
  reason?: Record<string, unknown>
  groups: TrajectoryGroup[]
}

export type PartialAssistant = {
  recordId: string
  kind: 'message'
  turn: number
  step: number | null
  sourceEventSeqs: number[]
  status: TrajectoryStatus
  timeSeconds: number | null
  text?: string
  thinkingDetail?: string
  inputDetail?: string
  data?: Record<string, unknown>
}

export type RunningToolCall = TrajectoryCell & {
  kind: 'tool' | 'subtool'
  status: 'running'
  callId: string
  toolName: string
  timeSeconds: null
}

export type RequestState = {
  recordId: string
  turn: number
  step: number | null
  sourceEventSeqs: number[]
  status: 'completed' | 'running'
  data: Record<string, unknown>
}

export type AgentTurnError = {
  kind: 'error'
  message: string
  turn?: number
  error?: unknown
}

export type AgentTrajectorySnapshot = {
  sessionKey: string
  events: readonly AgentSessionEvent[]
  turns: readonly TrajectoryTurn[]
  partial: PartialAssistant | null
  runningCalls: readonly RunningToolCall[]
  requests: readonly RequestState[]
  isRunning: boolean
  lastError: AgentTurnError | null
  nextSeq: number | null
}

type MutableGroup = TrajectoryGroup & { cells: TrajectoryCell[] }

type MutableTurn = {
  turn: number
  status: TrajectoryStatus
  reason?: Record<string, unknown>
  ended: boolean
  groups: Map<string, MutableGroup>
  groupOrder: string[]
}

type MutableTool = TrajectoryCell & {
  callId: string
  toolName: string
  startedAt: number | null
  endedAt: number | null
}

type MutablePartial = PartialAssistant & {
  textParts?: string[]
  thinkingParts?: string[]
  inputParts?: string[]
}

type MutableRequest = RequestState & { ended: boolean }

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function eventTurn(event: AgentSessionEvent, fallback = 1): number {
  return event.turn ?? numberValue(event.data.turn) ?? fallback
}

function eventStep(event: AgentSessionEvent): number | null {
  return event.step ?? numberValue(event.data.step) ?? null
}

function eventPhase(event: AgentSessionEvent): string | null {
  return stringValue(event.data.phase) ?? null
}

function timestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function secondsBetween(start: number | null, end: number | null): number | null {
  if (start === null || end === null || end < start) return null
  return (end - start) / 1_000
}

function durationSeconds(data: Record<string, unknown>, start: number | null, end: number | null): number | null {
  const durationMs = numberValue(data.durationMs) ?? numberValue(data.duration_ms)
  if (durationMs !== undefined) return durationMs / 1_000
  return secondsBetween(start, end)
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map(item => contentText(item)).filter(Boolean).join('')
  }
  if (isRecord(value)) {
    return stringValue(value.text)
      ?? stringValue(value.content)
      ?? stringValue(value.output)
      ?? stringValue(value.value)
      ?? ''
  }
  return ''
}

function detailText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function blockKind(block: Record<string, unknown>): string {
  return stringValue(block.kind) ?? stringValue(block.type) ?? ''
}

function statusFromReason(reason: unknown): TrajectoryStatus {
  const kind = stringValue(record(reason).kind)
  if (kind === 'error') return 'error'
  if (kind === 'aborted') return 'aborted'
  if (kind === 'interrupted') return 'interrupted'
  if (kind === 'waiting_approval') return 'waiting_approval'
  return 'completed'
}

function terminalReason(data: Record<string, unknown>): Record<string, unknown> {
  return record(data.reason)
}

function terminalError(turn: MutableTurn): AgentTurnError | null {
  if (turn.status !== 'error') return null
  const reason = record(turn.reason)
  const message = stringValue(reason.error)
    ?? stringValue(reason.message)
    ?? 'Agent 运行失败'
  return { kind: 'error', message, turn: turn.turn, error: reason.error ?? reason }
}

function groupKey(step: number | null): string {
  return step === null ? 'message' : `step:${step}`
}

const phaseLabels: Readonly<Record<string, string>> = {
  skill_selection: '技能选择',
  plan: '规划',
  references: '读取参考资料',
  execute: '执行',
  finalize: '收尾',
  validate: '校验',
  revise: '修订',
}

function groupTitle(step: number | null, phase: string | null): string {
  if (step === null) return 'Message'
  const callTitle = `模型调用 ${step}`
  const phaseLabel = phase ? phaseLabels[phase] : undefined
  return phaseLabel ? `${phaseLabel} · ${callTitle}` : callTitle
}

function ensureTurn(turns: Map<number, MutableTurn>, turnNumber: number): MutableTurn {
  const existing = turns.get(turnNumber)
  if (existing) return existing
  const created: MutableTurn = {
    turn: turnNumber,
    status: 'running',
    ended: false,
    groups: new Map(),
    groupOrder: [],
  }
  turns.set(turnNumber, created)
  return created
}

function ensureGroup(turn: MutableTurn, step: number | null, phase: string | null = null): MutableGroup {
  const key = groupKey(step)
  const existing = turn.groups.get(key)
  if (existing) {
    if (phase && existing.phase !== phase) {
      existing.phase = phase
      existing.title = groupTitle(step, phase)
    }
    return existing
  }
  const created: MutableGroup = {
    recordId: `group:${turn.turn}:${key}`,
    title: groupTitle(step, phase),
    kind: step === null ? 'message' : 'step',
    turn: turn.turn,
    step,
    phase,
    cells: [],
  }
  turn.groups.set(key, created)
  turn.groupOrder.push(key)
  return created
}

function toolKey(turn: number, callId: string): string {
  return `${turn}:${callId}`
}

function toolRecordId(turn: number, step: number | null, callId: string) {
  return `tool:${turn}:${step ?? 0}:${callId}`
}

function publicCell(cell: MutableTool): TrajectoryCell {
  const materialized = { ...cell }
  delete (materialized as Partial<MutableTool>).startedAt
  delete (materialized as Partial<MutableTool>).endedAt
  return materialized
}

function publicRequest(request: MutableRequest): RequestState {
  const materialized = { ...request }
  delete (materialized as Partial<MutableRequest>).ended
  return materialized
}

function toolCallData(data: Record<string, unknown>): { callId?: string; name?: string; input?: unknown } {
  return {
    callId: stringValue(data.callId) ?? stringValue(data.toolCallId) ?? stringValue(data.tool_call_id),
    name: stringValue(data.name) ?? stringValue(data.toolName) ?? stringValue(data.tool_name),
    input: data.argsRaw ?? data.arguments ?? data.input ?? data.inputSummary,
  }
}

function addOrUpdateTool(
  turn: MutableTurn,
  group: MutableGroup,
  tools: Map<string, MutableTool>,
  event: AgentSessionEvent,
  callId: string,
  toolName: string,
  input: unknown,
  startedAt: number | null,
) {
  const key = toolKey(group.turn, callId)
  const existing = tools.get(key)
  if (existing) {
    if (group.step !== null && existing.step === null) {
      const previousGroupKey = groupKey(existing.step)
      const previousGroup = turn.groups.get(previousGroupKey)
      if (previousGroup) {
        previousGroup.cells = previousGroup.cells.filter(cell => cell !== existing)
        if (previousGroup.cells.length === 0) {
          turn.groups.delete(previousGroupKey)
          turn.groupOrder = turn.groupOrder.filter(item => item !== previousGroupKey)
        }
      }
      existing.step = group.step
      existing.recordId = toolRecordId(group.turn, group.step, callId)
      if (!group.cells.includes(existing)) group.cells.push(existing)
      if (startedAt !== null) existing.startedAt = startedAt
    } else if (group.step === null && existing.step !== null && group.cells.length === 0) {
      const emptyGroupKey = groupKey(group.step)
      turn.groups.delete(emptyGroupKey)
      turn.groupOrder = turn.groupOrder.filter(item => item !== emptyGroupKey)
    }
    if (toolName && (toolName !== 'Tool' || existing.toolName === 'Tool')) {
      existing.toolName = toolName
    }
    existing.title = existing.toolName
    if (input !== undefined) existing.inputDetail = detailText(input)
    existing.sourceEventSeqs = Array.from(new Set([...existing.sourceEventSeqs, event.seq]))
    if (startedAt !== null && existing.startedAt === null) existing.startedAt = startedAt
    return existing
  }
  const created: MutableTool = {
    recordId: toolRecordId(group.turn, group.step, callId),
    kind: 'tool',
    turn: eventTurn(event),
    step: eventStep(event),
    sourceEventSeqs: [event.seq],
    status: 'running',
    timeSeconds: null,
    title: toolName || 'Tool',
    toolName: toolName || 'Tool',
    callId,
    inputDetail: detailText(input),
    startedAt,
    endedAt: null,
  }
  group.cells.push(created)
  tools.set(key, created)
  return created
}

function appendBlockText(target: { textParts?: string[]; thinkingParts?: string[]; inputParts?: string[] }, block: Record<string, unknown>) {
  const kind = blockKind(block)
  const text = contentText(block.text ?? block.content ?? block.delta ?? block.value)
  if (!text) return
  if (kind === 'reasoning' || kind === 'thinking') (target.thinkingParts ??= []).push(text)
  else if (kind === 'tool-input' || kind === 'tool-input-delta') (target.inputParts ??= []).push(text)
  else (target.textParts ??= []).push(text)
}

function assistantMessageCell(
  event: AgentSessionEvent,
  turn: MutableTurn,
  step: number | null,
  recordId = `message:${event.seq}`,
): TrajectoryCell {
  const data = event.data
  const blocks = Array.isArray(data.blocks) ? data.blocks.filter(isRecord) : []
  const reasoning = blocks.filter(block => ['reasoning', 'thinking'].includes(blockKind(block))).map(block => contentText(block.text ?? block.content)).filter(Boolean).join('')
  const text = blocks.filter(block => ['text', 'output', 'message'].includes(blockKind(block))).map(block => contentText(block.text ?? block.content)).filter(Boolean).join('')
  const timing = record(data.timing)
  const startedAt = timestamp(timing.stepStartTime ?? timing.step_start_time)
  const completedAt = timestamp(timing.completedTime ?? timing.completed_time) ?? event.time
  return {
    recordId,
    kind: 'message',
    turn: turn.turn,
    step,
    sourceEventSeqs: [event.seq],
    status: data.interrupted === true ? 'interrupted' : 'completed',
    timeSeconds: durationSeconds(data, startedAt, completedAt),
    title: 'Assistant',
    text: text || undefined,
    thinkingDetail: reasoning || undefined,
    usage: isRecord(data.usage) ? data.usage : undefined,
    timing: Object.keys(timing).length > 0 ? timing : undefined,
    provider: stringValue(data.provider),
    model: stringValue(data.model),
    data,
  }
}

export function mergeAgentSessionEvents(
  previous: readonly AgentSessionEvent[],
  incoming: readonly AgentSessionEvent[],
): AgentSessionEvent[] {
  const bySeq = new Map<number, AgentSessionEvent>()
  for (const item of previous) bySeq.set(item.seq, item)
  for (const item of incoming) bySeq.set(item.seq, item)
  return Array.from(bySeq.values()).sort((left, right) => left.seq - right.seq)
}

export function trajectoryRecordId(cell: { recordId: string }): string {
  return cell.recordId
}

export function deriveAgentTrajectory(
  events: readonly AgentSessionEvent[],
  sessionKey = '',
): AgentTrajectorySnapshot {
  const turns = new Map<number, MutableTurn>()
  const tools = new Map<string, MutableTool>()
  const partials = new Map<string, MutablePartial>()
  const requests = new Map<string, MutableRequest>()
  let currentTurn = 1
  let lastError: AgentTurnError | null = null

  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    const turnNumber = eventTurn(event, currentTurn)
    currentTurn = turnNumber
    const step = eventStep(event)
    const turn = ensureTurn(turns, turnNumber)

    if (event.type === 'turn/start') {
      turn.status = 'running'
      turn.ended = false
      continue
    }

    if (event.type === 'turn/end') {
      const reason = terminalReason(event.data)
      turn.reason = reason
      turn.status = statusFromReason(reason)
      turn.ended = true
      const error = terminalError(turn)
      if (error) lastError = error
      continue
    }

    if (event.type === 'request/header') {
      const request: MutableRequest = {
        recordId: `request:${event.seq}`,
        turn: turnNumber,
        step,
        sourceEventSeqs: [event.seq],
        status: 'running',
        data: event.data,
        ended: false,
      }
      requests.set(request.recordId, request)
      continue
    }

    if (event.type === 'step/start') {
      ensureGroup(turn, step, eventPhase(event))
      continue
    }

    if (event.type === 'step/end') {
      for (const request of requests.values()) {
        if (request.turn === turnNumber && request.step === step) {
          request.status = 'completed'
          request.ended = true
        }
      }
      continue
    }

    if (event.type === 'user/message') {
      const group = ensureGroup(turn, step)
      const content = event.data.content
      group.cells.push({
        recordId: `user:${event.seq}`,
        kind: 'user',
        turn: turnNumber,
        step,
        sourceEventSeqs: [event.seq],
        status: 'completed',
        timeSeconds: null,
        title: stringValue(record(event.data.source).kind) === 'context' ? 'Context' : 'User',
        text: contentText(content),
        data: event.data,
      })
      continue
    }

    if (event.type === 'assistant/chunk') {
      const chunk = record(event.data.chunk)
      const key = `${turnNumber}:${step ?? 0}`
      const existing = partials.get(key) ?? {
        recordId: `partial:${turnNumber}:${step ?? 0}`,
        kind: 'message',
        turn: turnNumber,
        step,
        sourceEventSeqs: [],
        status: 'running',
        timeSeconds: null,
        textParts: [],
        thinkingParts: [],
        inputParts: [],
        data: event.data,
      }
      appendBlockText(existing, chunk)
      existing.sourceEventSeqs = Array.from(new Set([...existing.sourceEventSeqs, event.seq]))
      existing.data = { ...existing.data, lastChunk: chunk }
      partials.set(key, existing)
      continue
    }

    if (event.type === 'assistant/message') {
      const group = ensureGroup(turn, step)
      const partialKey = `${turnNumber}:${step ?? 0}`
      const partial = partials.get(partialKey)
      const message = assistantMessageCell(event, turn, step, partial?.recordId)
      if (partial) {
        message.sourceEventSeqs = Array.from(new Set([...partial.sourceEventSeqs, event.seq]))
      }
      const existingIndex = group.cells.findIndex(cell => cell.recordId === message.recordId)
      if (existingIndex >= 0) group.cells[existingIndex] = message
      else group.cells.push(message)
      partials.delete(partialKey)

      const blocks = Array.isArray(event.data.blocks) ? event.data.blocks.filter(isRecord) : []
      for (const block of blocks) {
        if (!['tool-call', 'tool', 'tool_use'].includes(blockKind(block))) continue
        const callId = stringValue(block.callId) ?? stringValue(block.toolCallId) ?? stringValue(block.id)
        if (!callId) continue
        const toolName = stringValue(block.name) ?? stringValue(block.toolName) ?? 'Tool'
        addOrUpdateTool(
          turn, group, tools, event, callId, toolName,
          block.argsRaw ?? block.arguments ?? block.input,
          timestamp(record(event.data.timing).stepStartTime),
        )
      }
      continue
    }

    if (event.type === 'tool/call') {
      const callData = toolCallData(event.data)
      if (!callData.callId) continue
      const group = ensureGroup(turn, step)
      addOrUpdateTool(
        turn, group, tools, event, callData.callId,
        callData.name ?? 'Tool', callData.input, event.time,
      )
      continue
    }

    if (event.type === 'tool/result') {
      const callId = stringValue(event.data.callId) ?? stringValue(event.data.toolCallId) ?? stringValue(event.data.tool_call_id)
      if (!callId) continue
      const group = ensureGroup(turn, step)
      const existing = addOrUpdateTool(
        turn, group, tools, event, callId,
        stringValue(event.data.name) ?? 'Tool', undefined, null,
      )
      existing.sourceEventSeqs = Array.from(new Set([...existing.sourceEventSeqs, event.seq]))
      existing.endedAt = event.time
      const output = event.data.output ?? event.data.content ?? event.data.result
      existing.outputDetail = Array.isArray(output) ? contentText(output) : detailText(output)
      existing.error = stringValue(event.data.error) ?? (event.data.isError === true ? contentText(event.data.content) : undefined)
      existing.status = event.data.isError === true || existing.error ? 'error' : 'completed'
      existing.timeSeconds = durationSeconds(event.data, existing.startedAt, existing.endedAt)
      continue
    }
  }

  for (const partial of partials.values()) {
    partial.text = partial.textParts?.join('') || undefined
    partial.thinkingDetail = partial.thinkingParts?.join('') || undefined
    partial.inputDetail = partial.inputParts?.join('') || undefined
    delete partial.textParts
    delete partial.thinkingParts
    delete partial.inputParts
    const turn = ensureTurn(turns, partial.turn)
    const group = ensureGroup(turn, partial.step)
    const partialCell: TrajectoryCell = {
      recordId: partial.recordId,
      kind: 'message',
      turn: partial.turn,
      step: partial.step,
      sourceEventSeqs: partial.sourceEventSeqs,
      status: turn.ended ? turn.status : partial.status,
      timeSeconds: partial.timeSeconds,
      title: 'Assistant',
      text: partial.text,
      thinkingDetail: partial.thinkingDetail,
      inputDetail: partial.inputDetail,
      data: partial.data,
    }
    const existingIndex = group.cells.findIndex(cell => cell.recordId === partial.recordId)
    if (existingIndex >= 0) group.cells[existingIndex] = partialCell
    else group.cells.push(partialCell)
  }

  const materializedTurns = Array.from(turns.values()).sort((left, right) => left.turn - right.turn).map(turn => ({
    recordId: `turn:${turn.turn}`,
    turn: turn.turn,
    status: turn.status,
    reason: turn.reason,
    groups: turn.groupOrder.map(key => turn.groups.get(key)!).map(group => ({
      recordId: group.recordId,
      title: group.title,
      kind: group.kind,
      turn: group.turn,
      step: group.step,
      phase: group.phase,
      cells: group.cells.map(cell => publicCell(cell as MutableTool)),
    })),
  }))

  const runningCalls = Array.from(tools.values())
    .filter((call): call is MutableTool & RunningToolCall => call.status === 'running')
    .map(call => ({
      ...publicCell(call),
      status: 'running' as const,
      timeSeconds: null,
    }) as RunningToolCall)
  const partialValues = Array.from(partials.values())
  const latestPartial = partialValues.at(-1) ?? null
  const partialTurn = latestPartial ? turns.get(latestPartial.turn) : undefined
  const partial = latestPartial
    ? {
        ...latestPartial,
        status: partialTurn?.ended ? partialTurn.status : latestPartial.status,
      }
    : null
  const isRunning = materializedTurns.some(turn => turn.status === 'running')
    || (partial !== null && partial.status === 'running')
    || runningCalls.some(call => turns.get(call.turn)?.status === 'running')
  if (!lastError) {
    const errorTurn = Array.from(turns.values()).filter(turn => turn.status === 'error').at(-1)
    if (errorTurn) lastError = terminalError(errorTurn)
  }

  const maxSeq = events.reduce((max, event) => Math.max(max, event.seq), 0)
  return {
    sessionKey,
    events,
    turns: materializedTurns,
    partial,
    runningCalls,
    requests: Array.from(requests.values()).map(publicRequest),
    isRunning,
    lastError,
    nextSeq: maxSeq > 0 ? maxSeq : null,
  }
}
