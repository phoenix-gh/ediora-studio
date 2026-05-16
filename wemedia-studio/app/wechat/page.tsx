export const dynamic = 'force-dynamic'

import { getWechatArticles } from '@/lib/api/wechat'
import { WechatClient } from './WechatClient'

export default async function WechatPage() {
  const articles = await getWechatArticles({ limit: 200 }).catch(() => [])
  return <WechatClient initialArticles={articles} />
}
