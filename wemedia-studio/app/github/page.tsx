export const dynamic = 'force-dynamic'

import { getGithubRepos, getTrendingRepos, getGithubIssues, getPainPoints, getGithubReleases } from '@/lib/api/github'
import { GithubClient } from './GithubClient'

export default async function GithubPage() {
  const [repos, trending, issues, painPoints, releases] = await Promise.all([
    getGithubRepos().catch(() => []),
    getTrendingRepos('daily').catch(() => []),
    getGithubIssues(undefined, 100).catch(() => []),
    getPainPoints().catch(() => []),
    getGithubReleases(undefined, 50).catch(() => []),
  ])

  return (
    <GithubClient
      initialRepos={repos}
      initialTrending={trending}
      initialIssues={issues}
      initialPainPoints={painPoints}
      initialReleases={releases}
    />
  )
}
