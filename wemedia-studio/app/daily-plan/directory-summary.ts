export function summarizeDirectories(directories: string[] = [], legacyDirectory = '') {
  const values = directories.length ? directories : legacyDirectory ? [legacyDirectory] : []
  const normalized = [...new Set(values.map(value => value.trim()).filter(Boolean))]
  const preview = normalized.slice(0, 3).join('、')
  return normalized.length > 3 ? `${preview}等 ${normalized.length} 个目录` : preview
}
