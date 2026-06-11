export const dynamic = 'force-dynamic'

import { getGithubRepos, getTrendingRepos, getGithubReleases } from '@/lib/api/github'
import { GithubClient } from './GithubClient'

export default async function GithubPage() {
  const [repos, trending, releases] = await Promise.all([
    getGithubRepos().catch(() => []),
    getTrendingRepos('daily').catch(() => []),
    getGithubReleases(undefined, 50).catch(() => []),
  ])

  return (
    <GithubClient
      initialRepos={repos}
      initialTrending={trending}
      initialReleases={releases}
    />
  )
}
