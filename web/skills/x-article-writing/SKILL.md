---
name: x-article-writing
description: "Use when writing, rewriting, or expanding an independent X/Twitter Article, including an intelligence-center x_article or legacy expanded_article based on an X post, research item, product release, or industry update; not for ordinary X posts, long posts, Threads, replies, or general social copy."
version: 1.0.0-wms.1
---

# X Article Writing

把可靠素材写成一篇适合 X/Twitter Article 独立文章形态的完整中文长文。优先保证事实、判断和阅读价值，再优化开场、节奏与传播性；不得承诺传播结果。

## 适用边界

只在目标产物明确是 X/Twitter Article 时使用，包括情报中心的 `x_article` 和旧版 `expanded_article`。

本 Skill 不适用于普通 X 长帖或 Thread，也不适用于短帖、回复、评论和其他社交文案；这些任务使用 `human-social-copy`。

## 写作流程

1. **确认交付形态**：识别目标是否为独立 X Article、指定语言、读者、篇幅、账号声音和保存方式。没有明确篇幅时，以完整表达核心判断所需的最短长度为准。
2. **建立证据账本**：分开记录已确认事实、来源原话、可解释推论和信息缺口。不得编造数据、经历、收益、案例、截图、测试结果、引语或来源；不能确认的内容删去或明确标记为推论。
3. **只定一个核心判断**：用一句话写清文章希望读者记住什么。删掉不能支撑这句话、也不能帮助读者行动或判断的旁支。
4. **读取适用参考资料**：
   - 选择 Article 形态和正文推进方式时，读取 `references/article-structure.md`。
   - 设计前 280 字符、移动端节奏和信息呈现时，读取 `references/hooks-and-layout.md`。
   - 写完后必须读取 `references/quality-check.md` 并完成交付检查。
   使用 `readSkillReference` 读取需要的文件；不要声称采用尚未成功读取的规则。
5. **先兑现再扩展**：前 280 字符交代主题、核心判断和阅读收益，正文用证据、解释、限制与可执行价值逐层兑现。传播性不能凌驾于准确性。
6. **交付完整成稿**：输出标题和完整 Markdown 正文，而不是提纲、摘要、分析报告、写作建议或待补模板。除非任务明确要求，不附带多个标题、配图方案、发布运营建议、评论模板或创作过程。
7. **按业务工具保存**：使用当前工作流指定的真实保存工具，不自行发布。情报中心 `x_article` 或旧版 `expanded_article` 默认只调用一次 `save_draft`，保存一个标题和一篇完整 Markdown 正文；只有工具返回真实草稿 ID 才算完成。

## 事实与声音

- 当前用户要求高于通用写法；账号档案只在账号明确时使用。
- 事实与观点分开，数字、时间、专有名词和来源链接保持可追溯。
- 没有真实第一人称经历时，不写“我实测”“我的朋友”“我赚到”等叙述。
- 不把未经核实的平台算法权重、互动倍率、点击率或个案成绩写成普遍规律。
- 可以有鲜明判断，但必须给出依据、适用条件或可能失效的边界。

## 完成标准

- 开头在不夸大的前提下说明为什么值得读。
- 全文围绕一个核心判断推进，并有足够事实支撑。
- 文章包含读者可带走的解释、框架、清单、步骤或判断方法，但不机械堆砌。
- 语言像具体的人在解释具体问题，避免模板化排比、空洞升华和重复总结。
- 来源链接与对应事实靠近；推论被明确写成推论。
- 最终内容满足当前工作流的字段、状态和保存工具约束。
