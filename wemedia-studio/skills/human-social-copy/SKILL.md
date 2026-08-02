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

不要猜账号，不要模仿特定作者，也不要编造亲身体验、测试结果、收益、合作关系或读者反馈。需要建立或复用账号声音时，读取 `references/voice-system.md`。

## 工作流

1. 提取必须保真的事实、数字、专有名词、链接和披露要求；不确定的信息标注待确认。
2. 判断任务类型和平台限制，先给出最接近成稿的版本。
3. 选择一个适合素材的开场，不要为了“有钩子”牺牲准确性。需要更多选法时读取 `references/adaptive-hooks.md`。
4. 用具体动作、场景、结果组织正文，删除空泛评价和重复总结。
5. 做一次事实、声音、节奏、格式和合规检查。

普通改写不强制输出钩子菜单、结构分析或写作过程；用户要比较方案时再给 2 至 3 个有实质差异的版本。

## 按需读取参考资料

需要详细规则时，通过 `readSkillReference` 只读取相关文件：

- 清理 AI 味、句式和措辞：`references/writing-clean-rules.md`
- 按内容类型选结构：`references/patterns.md`
- 金融、Crypto、数据与风险披露：`references/finance-writing.md`
- 长短、分段、列表和平台排版：`references/layout-playbook.md`
- 搜集信源、核验事实和引用：`references/sourcing-playbook.md`
- 品牌合作、KOL brief 和交付检查：`references/kol-brief-workflow.md`

## 交付标准

- 首屏说清楚读者为什么值得继续看。
- 工具或项目第一次出现时，说明它是什么、解决什么问题。
- 观点和事实分开；数字、引语和功能边界可追溯。
- CTA 只在确有下一步时出现，避免机械地“你怎么看”。
- 默认先交付可直接使用的文案；必要时附一小段事实缺口或发布提醒。
