const truthyValues = new Set(['1', 'true', 'yes', 'on'])

export function isDeveloperModeEnabled(value?: string | null) {
  return truthyValues.has((value ?? '').trim().toLowerCase())
}
