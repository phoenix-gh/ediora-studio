# X Article Writing Skill 设计

## 目标

把 `/mnt/d/prompts/prompt_X爆款长文章Article.md` 整理为 WeMediaStudio 内置 Skill，使 Agent 在创作 X/Twitter Article 独立长文章时能够自主发现并加载它。Skill 的系统标识为 `x-article-writing`，标题语义为 “X Article Writing”。

本 Skill 只服务 X/Twitter Article，不覆盖普通中文长推、Thread 或社交媒体短帖；后者继续由 `human-social-copy` 处理。

## 触发边界

Skill 描述必须明确覆盖以下任务：

- 编写或改写 X/Twitter Article；
- 把 X 帖子、研究、产品发布或行业情报扩写为可发布的 X Article；
- 情报中心以 X Article 为目标形态的 `expanded_article` 写作任务。

仅要求普通 X 帖子、Thread、短文案、评论或其他平台社交文案时，不应触发本 Skill。

## 内容结构

采用“精简主 Skill + 按需参考资料”的结构：

- `SKILL.md`：触发后的核心工作流、事实边界、交付契约和参考资料路由；
- `references/article-structure.md`：单一核心判断、前 280 字符、正文结构以及不同 Article 类型的选择；
- `references/hooks-and-layout.md`：开场、移动端排版、信息密度和收藏价值设计；
- `references/quality-check.md`：事实、声音、节奏、AI 痕迹、链接和交付前检查。

不添加脚本、图片资产、README 或与执行无关的说明文件。

## 提示词改进原则

保留原提示词中可复用的 X Article 写作知识：前 280 字符的重要性、一篇只讲一个核心判断、具体证据与场景、SOP/清单/对比表等收藏价值，以及长短句交替的移动端阅读节奏。

删除或改写以下不可靠约束：

- 不把未经核实的算法权重、点击率、互动倍率和个案成绩写成平台事实；
- 不允许编造数据、个人经历、收益、案例、截图或测试结果；
- 不承诺“爆款”或固定传播效果；
- 不强制每篇输出五个标题、固定数量配图、运营建议、评论模板或争议 CTA；
- 配图、备选标题、发布建议和 CTA 仅在当前任务明确需要时提供；
- 写作质量服从事实准确性、来源可追溯和用户当前要求。

## Agent 工作流

加载 Skill 后，Agent 应：

1. 确认目标确实是 X Article，而不是普通长推或 Thread；
2. 提取唯一核心判断、目标读者、事实依据、来源链接和不可推断内容；
3. 按任务类型读取所需参考资料；
4. 设计前 280 字符与完整文章结构；
5. 写出可直接保存的完整中文 Markdown Article；
6. 做事实、结构、节奏和交付契约检查；
7. 使用当前业务流程要求的真实保存工具完成交付，不自行发布。

对于情报中心 `expanded_article`，默认交付一个标题和一篇完整 Markdown 正文，不附加无关的标题菜单、配图方案、运营计划或创作过程。

## 系统接入

Skill 放入 `wemedia-studio/skills/x-article-writing/`，由现有技能注册表自动发现。Skill 采用内置来源，默认启用，可在技能管理页关闭，但不能作为上传 Skill 删除。

`WMS_SKILL.json` 只声明通用执行提示，不预加载全部参考资料，避免每次加载占用不必要上下文；Agent 根据 `SKILL.md` 的可观察条件调用 `readSkillReference`。

## 验证

采用 `#1093` 暴露的问题作为基线：任务明确要求完整 X Article，但旧技能目录没有匹配项，Agent 的审计为零 Skill 引用并直接调用 `save_draft`。

新增自动化测试验证：

- `x-article-writing` 能被技能注册表和 Agent 技能目录发现；
- 描述明确包含 X/Twitter Article 与 `expanded_article`，同时排除普通 Thread/长推；
- 三个参考资料均可读取且内容非空；
- `SKILL.md` 明确要求事实不可编造、情报中心默认只交付完整正文，并包含按需参考资料路由；
- Skill 可以关闭和恢复，且内置 Skill 不可删除。

完成后运行聚焦 Vitest、ESLint 和差异检查。若全量类型检查被仓库现有无关错误阻断，应单独报告，不得把它描述为通过。
