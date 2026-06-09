# Agent Skill 设计：权威来源速查

用于撰写 AI Agent Skill 相关文章时的参考素材。从 Block Engineering、Perplexity Research、arXiv 论文等一手来源整理。

---

## Block Engineering — 3 Principles for Designing Agent Skills
- **来源**: https://engineering.block.xyz/blog/3-principles-for-designing-agent-skills
- **作者**: Angie Jones (AI Enablement Lead, Block)
- **日期**: 2026-02-15

### 核心框架
1. **Know What the Agent Should NOT Decide** — 需要确定性的操作放进脚本，不要留给模型
   - 同样的输入必须产生同样的输出（评分、CLI 命令、SQL 查询）
   - 用二元 pass/fail + 固定分值，拒绝「部分得分」
2. **Know What the Agent SHOULD Decide** — 解读、创建、对话是 Agent 的强项
   - 两区架构：规则+执行 → 脚本；解读+行动 → Agent
3. **Write a Constitution, Not a Suggestion** — SKILL.md 是合同，不是建议
   - 防御 Agent 的「讨好型人格」：不要软化坏消息、不要跳过步骤
4. **Bonus: Design for the Arc** — 好 Skill 是对话弧，不是一次性工具
   - 脚本输出 → Agent 输入 → 用户追问 → 迭代改进

### 关键引言
- "Making devs finally write docs by calling them 'skills' is a great arb..." — @mitch_troy (3.7K likes)
- "Documentation goes from something you read to something your agent can execute."
- "A script gives you a diagnosis. A skill gives you a diagnosis and a doctor who can treat you on the spot."
- Block 内部有 100+ skills，按角色打包（frontend, android, iOS）

---

## Perplexity Research — Designing, Refining, and Maintaining Agent Skills
- **来源**: https://research.perplexity.ai/articles/designing-refining-and-maintaining-agent-skills-at-perplexity
- **日期**: 2026-05-01

### Zen of Skills（vs Zen of Python）
| Zen of Python | Zen of Skills |
|---|---|
| Simple is better than complex | A Skill is a folder, not a file. Complexity is the feature. |
| Explicit is better than implicit | Activation is implicit pattern matching. Progressive disclosure. |
| Sparse is better than dense | Context is expensive. Maximum signal per token. |
| Special cases aren't special enough to break the rules | Gotchas ARE the special cases (highest-value content). |
| If the implementation is easy to explain, it may be a good idea | If it's easy to explain, the model already knows it. Delete it. |

### 三层上下文成本（Skill 税理论）
| 层级 | 加载内容 | 预算 | 何时付费 |
|---|---|---|---|
| Index | name + description | ~100 tokens/Skill | 每次会话，每个用户 |
| Load | SKILL.md 正文 | ~5,000 tokens | 加载时 |
| Runtime | scripts/, references/ 等 | 不限 | Agent 实际读取时 |

### 关键原则
- **Every Skill is a tax** — 每句话都要通过「去掉会出错吗？」检验
- **Self-generated Skills provide no benefit** — 模型不能可靠地编写自己需要的程序性知识
- **Focused Skills (2-3 modules) outperform comprehensive documentation**
- **Description 是路由触发器，不是文档** — 以 "Load when" 开头，不是 "This Skill does"
- **先写 evals (Step 0)** — 至少覆盖「该加载时加载」「不该加载时不加载」
- **写 Skill 不能用 LLM 一键生成** — 需要注入人的判断力

### 税务 Skill 案例
- 用三层嵌套目录组织 1,945 个美国税法条目
- 直接把全部内容扔给模型的效果比不加载 Skill 还差
- 需要额外的搜索工具和快速参考指南辅助模型导航

---

## SkillsBench 论文
- **来源**: arXiv (SkillsBench: Benchmarking How Well Agent Skills Work Across Diverse Tasks)
- **数据**: 86 tasks, 11 domains, 7 agent-model configs, 7,308 trajectories

### 核心数据
- Curated Skills 平均提升 pass rate **16.2pp**
- 效果因领域差异大：Software Engineering +4.5pp vs Healthcare +51.9pp
- **84 个任务中 16 个加 Skill 后变差**（负面效果）
- **Self-generated Skills 平均无收益**
- 小模型 + Skills 可以匹配大模型 without Skills

---

## HackerNoon — Read This Before You Write Another Agent Skill
- **来源**: https://hackernoon.com/read-this-before-you-write-another-agent-skill
- **作者**: Anson
- **日期**: 2026-03-02

### 核心观点
- **Skill 反模式**：让 Agent 写自己不擅长的东西的 Skill = 重新发明 thinking blocks
- 「我 Agent 这个做不好，所以我让 Agent 写个 Skill」是常见错误
- 类比：让不会做饭的人写菜谱 — 看起来像那么回事，但关键细节全是猜的
- SkillsBench 论文的 "self-generated" 定义有问题：只是让模型在解题前写点东西 = thinking blocks
