import {
  ERROR_CODES,
  failureResult,
  scheduleParts,
  successResult,
  validatePublishRequest,
} from './contracts.js'

function normalizeComposerText(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim()
}

function toFailureResult(error) {
  return failureResult(
    typeof error?.code === 'string' ? error.code : ERROR_CODES.INTERNAL_ERROR,
    error instanceof Error ? error.message : '述策助手执行失败',
    error?.details,
  )
}

async function runScheduled({ driver, request }) {
  await driver.openScheduler()
  await driver.setScheduleFields(scheduleParts(request.scheduledAt))
  await driver.confirmScheduleDialog()

  if (!await driver.verifyComposerSchedule(request.scheduledAt)) {
    return failureResult(ERROR_CODES.SCHEDULE_CONTROLS_CHANGED, 'X 页面没有确认请求的安排时间')
  }
  if (request.dryRun) return successResult('dry-run', request.scheduledAt)

  await driver.clickFinalSubmit('scheduled')
  if (!await driver.waitForSubmissionEvidence('scheduled')) {
    return failureResult(ERROR_CODES.SUBMIT_NOT_CONFIRMED, '未观察到 X 的定时发布成功证据')
  }
  return successResult('scheduled', request.scheduledAt)
}

export function createPublisher({ driver, now = () => new Date() }) {
  let busy = false

  return async function publish(rawRequest) {
    if (busy) return failureResult(ERROR_CODES.BUSY, '当前标签页已有发布任务正在执行')
    busy = true

    try {
      const request = validatePublishRequest(rawRequest, now())
      await driver.assertSupportedPage()
      await driver.ensureComposer()

      const existing = normalizeComposerText(await driver.readComposerText())
      if (existing) {
        return failureResult(ERROR_CODES.EXISTING_DRAFT, '编辑器中已有未提交内容')
      }

      await driver.writeComposerText(request.text)
      if (normalizeComposerText(await driver.readComposerText()) !== request.text) {
        return failureResult(ERROR_CODES.TEXT_MISMATCH, '写入后的帖子内容与请求不一致')
      }

      if (request.scheduledAt) return await runScheduled({ driver, request })
      if (request.dryRun) return successResult('dry-run')

      await driver.clickFinalSubmit('published')
      if (!await driver.waitForSubmissionEvidence('published')) {
        return failureResult(ERROR_CODES.SUBMIT_NOT_CONFIRMED, '未观察到 X 的发布成功证据')
      }
      return successResult('published')
    } catch (error) {
      return toFailureResult(error)
    } finally {
      busy = false
    }
  }
}

let defaultPublisher

export async function publish(rawRequest) {
  if (!defaultPublisher) {
    const { createXDomDriver } = await import('./x-dom-driver.js')
    defaultPublisher = createPublisher({
      driver: createXDomDriver(document, window),
    })
  }
  return defaultPublisher(rawRequest)
}

export { normalizeComposerText }
