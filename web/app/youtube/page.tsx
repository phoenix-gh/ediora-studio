export const dynamic = 'force-dynamic'

import { getYoutubeChannels, getYoutubeVideos } from '@/lib/api/youtube'
import { YoutubeClient } from './YoutubeClient'

export default async function YoutubePage() {
  const [channels, videos] = await Promise.all([
    getYoutubeChannels().catch(() => []),
    getYoutubeVideos({ days: 30, limit: 200 }).catch(() => []),
  ])

  return <YoutubeClient initialChannels={channels} initialVideos={videos} />
}
