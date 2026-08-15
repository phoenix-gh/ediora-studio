export type CreationRulePromptBuilder = {
  assetType: 'article' | 'media'
  directories: string[]
  targetCount: number
  lookbackDays: number
  accountId: string | null
  skillMode: 'auto' | 'manual'
  skillName: string | null
  instructions: string
}

export function buildCreationRulePrompt(input: CreationRulePromptBuilder) {
  const directories = input.directories
    .map(directory => directory.trim())
    .filter(Boolean)
  const assetLabel = input.assetType === 'article' ? '文章素材' : '媒体素材'
  const lines = [
    `从${assetLabel}目录 ${directories.join('、') || '由你自行判断的可用素材'} 中，创作 ${input.targetCount || 1} 条中文 X 短帖。`,
  ]

  const accountId = input.accountId?.trim()
  if (accountId) {
    lines.push(`创作时读取并遵循发布账号 ${accountId} 的定位、语气和受众，并自行判断需要的工作流。`)
  }

  const skillName = input.skillName?.trim()
  if (input.skillMode === 'manual' && skillName) {
    lines.push(`可优先使用 Skill ${skillName}，但仍应根据上下文自行判断所需工具和工作流。`)
  } else {
    lines.push('根据上下文自行选择相关 Skill，并使用工具读取真实素材，不要编造来源。')
  }

  if (input.lookbackDays > 0) {
    lines.push(`检查最近 ${input.lookbackDays} 天的内容使用记录，不要复用仍在去重期内的创作资产。`)
  }

  lines.push('每条完成后调用 save_draft 保存到草稿箱，参数必须使用 status="drafting"、draft_type="x"。')
  lines.push('generateImage 会同步生成并保存 CreativeAsset；生成结果已经是本地图片，不要再调用 upload_image_from_url 或 upload_image_from_path 重复上传。')
  lines.push('save_draft 返回草稿 id 后，如正文包含生成图片，使用对应的 asset_id 调用 attach_creative_asset_to_draft 关联到草稿图片库。')
  lines.push('仅在 save_draft 成功并返回真实草稿 id 后，调用 record_content_usage 记录该草稿实际使用的素材。')

  const instructions = input.instructions.trim()
  if (instructions) lines.push('', '附加要求：', instructions)

  return lines.join('\n').trim()
}
