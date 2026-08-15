import { getSettings } from '@/lib/api/settings'
import { SettingsClient } from './SettingsClient'

export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  let settings = null
  try {
    settings = await getSettings()
  } catch {
    // Backend may not be running; SettingsClient handles null gracefully
  }
  return <SettingsClient initialSettings={settings} />
}
