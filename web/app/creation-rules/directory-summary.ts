export function summarizeDirectories(directories: string[], fallback: string) {
  const names = directories.length > 0 ? directories : fallback ? [fallback] : []
  if (names.length === 0) return '未选择目录'
  if (names.length === 1) return names[0]
  return `${names[0]} 等 ${names.length} 个目录`
}
