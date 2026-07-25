import type { TopicSuggestion } from '@/lib/api/topic-generator'


export interface ConvertedResponseSource {
  id: number
  summary_cn: string
  reason: string
  username: string
  post_content: string
  post_url: string
}

export function mergeConvertedResponses(
  responses: ConvertedResponseSource[],
  cachedTopics: TopicSuggestion[],
): TopicSuggestion[] {
  const converted: TopicSuggestion[] = responses.map(response => ({
    title: response.summary_cn,
    angle: response.reason,
    type: 'share',
    source_posts: [{
      username: response.username.startsWith('@')
        ? response.username
        : `@${response.username}`,
      content: response.post_content,
      url: response.post_url,
    }],
  }))
  const seen = new Set<string>()
  return [...converted, ...cachedTopics].filter(topic => {
    const key = topic.source_posts[0]?.url || topic.title
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
