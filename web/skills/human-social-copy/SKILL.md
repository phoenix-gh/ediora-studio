---
name: human-social-copy
description: "Use when drafting, rewriting, critiquing, or humanizing Chinese social-media copy for X/Twitter, Threads, Instagram, TikTok, AI tools, products, GitHub projects, crypto, finance, tutorials, commentary, or sponsored posts."
version: 1.0.0-wms.1
---

# 真人中文社交文案

把素材变成可以直接发布、信息具体、读起来像真人写的中文社交内容。默认输出简体中文；除非用户要求，不自动扩成长 thread。

## 先确定声音

按以下优先级选择语气：

1. 用户在当前请求中给出的账号定位、受众、口吻和禁忌。
2. 当前发布账号已有的明确档案或示例。
3. 没有明确账号信息，或多个账号无法判断时，使用中性、自然、克制的中文表达。

不要猜账号，不要模仿特定作者，也不要编造亲身体验、测试结果、收益、合作关系或读者反馈。

## 工作流

1. 提取必须保真的事实、数字、专有名词、链接和披露要求；不确定的信息标注待确认。
2. 判断任务类型和平台限制，先给出最接近成稿的版本。
3. 选择一个适合素材的开场，不要为了“有钩子”牺牲准确性。需要更多选法时读取 `references/adaptive-hooks.md`。
4. 用具体动作、场景、结果组织正文，删除空泛评价和重复总结。
5. 做一次事实、声音、节奏、格式和合规检查。

普通改写不强制输出钩子菜单、结构分析或写作过程；用户要比较方案时再给 2 至 3 个有实质差异的版本。

## 必须执行的参考资料路由

写稿前先判断任务类型，并通过 `readSkillReference` 读取所有适用文件。以下条件明确时不得跳过：

- 涉及收益、成本、投资、金融或 Crypto：必须读取 `references/finance-writing.md`
- 需要可直接发布到 X 或其他平台：必须读取 `references/layout-playbook.md`
- 改写、润色或去除 AI 味：必须读取 `references/writing-clean-rules.md`
- 涉及账号声音或发布身份：必须读取 `references/voice-system.md`
- 需要选择开场或提供钩子方案：必须读取 `references/adaptive-hooks.md`
- 需要决定教程、观点、新闻、复盘或清单结构：必须读取 `references/patterns.md`
- 需要检索、核验、引用或补足来源：必须读取 `references/sourcing-playbook.md`
- 涉及品牌合作、赞助或 KOL brief：必须读取 `references/kol-brief-workflow.md`

一次任务可能同时命中多个条件；必须在同一预读取阶段读完适用文件。不要读取与任务无关的文件，也不要声称使用了尚未成功读取的规则。

## 交付标准

- 首屏说清楚读者为什么值得继续看。
- 工具或项目第一次出现时，说明它是什么、解决什么问题。
- 观点和事实分开；数字、引语和功能边界可追溯。
- CTA 只在确有下一步时出现，避免机械地“你怎么看”。
- 默认先交付可直接使用的文案；必要时附一小段事实缺口或发布提醒。
