import { listDigitalHumans } from '@/lib/api/digital-humans'

import { DigitalHumansClient } from './DigitalHumansClient'


export const dynamic = 'force-dynamic'


export default async function DigitalHumansPage() {
  return (
    <DigitalHumansClient initialRoles={await listDigitalHumans()} />
  )
}
