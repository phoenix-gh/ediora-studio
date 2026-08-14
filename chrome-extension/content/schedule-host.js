import { createScheduleMemory } from './schedule-memory.js'
import {
  SCHEDULE_MESSAGE_TYPES,
  handleScheduleHostMessage,
} from './schedule-bridge.js'

export function startScheduleHost({ document, window, chromeApi = globalThis.chrome }) {
  const runtime = chromeApi?.runtime
  const memory = createScheduleMemory({
    document,
    window,
    onChange(selection) {
      Promise.resolve(runtime?.sendMessage?.({
        type: SCHEDULE_MESSAGE_TYPES.CHANGED,
        selection,
        autoFillEnabled: memory.readAutoFillEnabled(),
        available: true,
      })).catch(() => {})
    },
  })
  memory.start()

  const onMessage = (message, _sender, sendResponse) => {
    const result = handleScheduleHostMessage(message, memory)
    if (!result) return false
    sendResponse(result)
    return true
  }
  runtime?.onMessage?.addListener(onMessage)

  return {
    destroy() {
      memory.stop()
      runtime?.onMessage?.removeListener?.(onMessage)
    },
  }
}
