const truthyValues = new Set(['1', 'true', 'yes', 'on'])

export function isDeveloperModeEnabled(value = process.env.NEXT_PUBLIC_DEVELOPER_MODE) {
  return truthyValues.has((value ?? '').trim().toLowerCase())
}
