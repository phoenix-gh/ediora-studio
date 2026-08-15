import { listTextVideoProjects } from '@/lib/api/text-videos'

import { TextVideoProjectsClient } from './TextVideoProjectsClient'

export const dynamic = 'force-dynamic'

export default async function TextVideoPage() {
  const projects = await listTextVideoProjects().catch(() => [])
  return <TextVideoProjectsClient initialProjects={projects} />
}
