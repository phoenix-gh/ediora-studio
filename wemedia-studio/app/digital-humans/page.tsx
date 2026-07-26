import {
  listDigitalHumans,
  listTalkingVideos,
} from '@/lib/api/digital-humans'

import { DigitalHumansClient } from './DigitalHumansClient'


export const dynamic = 'force-dynamic'


export default async function DigitalHumansPage() {
  const [roles, projects] = await Promise.all([
    listDigitalHumans(),
    listTalkingVideos(),
  ])
  return (
    <DigitalHumansClient
      initialRoles={roles}
      initialProjects={projects}
    />
  )
}
