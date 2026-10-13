import {
  extractReasoningMiddleware,
  wrapLanguageModel,
} from 'ai'

import { deepSeekReasoningPersistenceMiddleware } from './deepseek-reasoning-compat'

type WrappableLanguageModel = Parameters<typeof wrapLanguageModel>[0]['model']

/** Keep provider reasoning tags out of user-visible Chat text. */
export function chatReasoningModel(model: WrappableLanguageModel) {
  return wrapLanguageModel({
    model,
    middleware: [
      ...(/^deepseek(?:[-/]|$)/i.test(model.modelId)
        ? [deepSeekReasoningPersistenceMiddleware()]
        : []),
      extractReasoningMiddleware({ tagName: 'think' }),
    ],
  })
}
