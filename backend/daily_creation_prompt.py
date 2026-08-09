from collections.abc import Mapping


def build_legacy_creation_prompt(rule: Mapping[str, object]) -> str:
    raw = rule.get("directories")
    directories = [
        str(item).strip() for item in raw if str(item).strip()
    ] if isinstance(raw, list) else []
    fallback = str(rule.get("directory") or "").strip()
    if not directories and fallback:
        directories = [fallback]
    count = int(rule.get("target_count") or 1)
    lookback = int(rule.get("lookback_days") or 0)
    asset_label = (
        "媒体素材" if str(rule.get("asset_type") or "").strip() == "media"
        else "文章素材"
    )
    lines = [
        f"从{asset_label}目录 {'、'.join(directories) or '由你自行判断的可用素材'} 中，创作 {count} 条中文 X 短帖。",
    ]
    account_id = str(rule.get("account_id") or "").strip()
    if account_id:
        lines.append(
            f"创作时读取并遵循发布账号 {account_id} 的定位、语气和受众，"
            "并自行判断需要的工作流。"
        )
    skill_name = str(rule.get("skill_name") or "").strip()
    if str(rule.get("skill_mode") or "auto") == "manual" and skill_name:
        lines.append(
            f"可优先使用 Skill {skill_name}，但仍应根据上下文自行判断所需工具和工作流。"
        )
    else:
        lines.append(
            "根据上下文自行选择相关 Skill，并使用工具读取真实素材，不要编造来源。"
        )
    if lookback > 0:
        lines.append(
            f"检查最近 {lookback} 天的内容使用记录，不要复用仍在去重期内的创作资产。"
        )
    lines.append(
        '每条完成后调用 save_draft 保存到草稿箱，参数必须使用 '
        'status="drafting"、draft_type="x"。'
    )
    lines.append(
        "仅在 save_draft 成功并返回真实草稿 id 后，调用 "
        "record_content_usage 记录该草稿实际使用的素材。"
    )
    extra = str(rule.get("instructions") or "").strip()
    if extra:
        lines.extend(["", "附加要求：", extra])
    return "\n".join(lines).strip()
