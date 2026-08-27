import {
  extractReasoningMiddleware,
  wrapLanguageModel,
} from 'ai'

type WrappableLanguageModel = Parameters<typeof wrapLanguageModel>[0]['model']

/** Keep provider reasoning tags out of user-visible Chat text. */
export function chatReasoningModel(model: WrappableLanguageModel) {
  return wrapLanguageModel({
    model,
    middleware: extractReasoningMiddleware({ tagName: 'think' }),
  })
}
