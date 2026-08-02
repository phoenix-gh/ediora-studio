---
name: article-drafting
description: "Use when the user asks to research materials and write an article draft (e.g. '帮我收集材料写初稿', '写一篇关于X的文章', 'research and draft'). Covers multi-source research, structured drafting in Chinese, and review-ready output."
version: 1.0.0
author: hermes
license: MIT
metadata:
  hermes:
    tags: [content-creation, article, drafting, research, chinese-content]
    related_skills: [content-ideation, human-social-copy, humanizer]
---

# article-drafting：从素材到初稿的文章写作

帮 MK 收集资料并写出文章初稿。与 `content-ideation`（选题）和 `human-social-copy`（社交文案）互补，覆盖长文写作场景。

---

## 触发判断

当用户表达以下意图时触发：
- 「帮我收集材料写初稿」
- 「写一篇关于 X 的文章」
- 「research + draft an article about X」
- 「整理下素材，我先看看」

如果用户只要选题不要成品文章，转 `content-ideation`。如果用户要的是社交媒体短内容，转 `human-social-copy`。

---

## 工作流

### 第 1 步：并行启动多路搜索

同时发起多组搜索，覆盖不同角度：

1. **核心主题搜索**（英文关键词，即使目标文章是中文）
   - AI/技术话题：英文搜索质量远高于中文，结果更权威
   - 用 2-3 个不同角度的英文 query
2. **行业博客/深度文章搜索**
   - 加 `blog`、`engineering`、`research` 等限定词
   - 优先找一手来源（公司工程博客、研究机构、项目文档）
3. **争议/反面观点搜索**
   - 加 `criticism`、`problems`、`anti-pattern`、`vs` 等
   - 好文章需要正反对比

### 第 2 步：提取关键源文章

**提取策略（按优先级）：**

1. `web_extract` — 适合纯文本站点、文档站点
2. `browser_navigate` + `browser_console(expression="document.querySelector('article').innerText")` — 适合被 web_extract 拦截的站点
3. `browser_navigate` + `browser_console(expression="document.body.innerText.substring(0, 15000)")` — 兜底方案

**已知问题：**
- `web_extract` 对部分站点返回 "Blocked: URL targets a private or internal network address"
- 长文章用 `browser_console` + `innerText` 比 `browser_snapshot` 更完整（snapshot 会被截断）
- 如果 `browser_snapshot` 返回内容被截断（显示 `N more lines truncated`），切换到 `browser_console`

**提取后处理：** 识别文章中的：
- 关键数据/统计数字
- 核心论点/框架
- 引用的名言或权威观点
- 可直接引用的代码示例或表格

### 第 3 步：结构化整理素材

将素材按以下维度归类：

- **核心论点**：文章要回答什么问题？（1-2 个）
- **权威来源**：哪些是一手来源？（公司博客 > 研究论文 > 媒体报道 > 个人博客）
- **关键数据**：有冲击力的数字（提升/降低百分比、用户数、对比数据）
- **框架/模型**：别人提出的分类、原则、检查清单
- **反面观点**：争议点、失败案例、常见误区
- **可引用金句**：名人/权威的原话

### 第 4 步：确定文章结构

**中文技术文章推荐结构（按内容类型选择）：**

**观点型**（最常用，适合 MK 风格）：
1. 开头冲击 — 用数据或反直觉事实抓住注意力
2. 背景铺垫 — 统一认知，定义核心概念
3. 核心框架 — 提出 3-5 个原则/要点（带子标题）
4. 进阶洞察 — 超出基础认知的内容
5. 反面案例 — 常见误区/反模式
6. 检查清单 — 可直接使用的 checklist
7. 结语 — 一句话总结

**对比型**：
1. 问题引入
2. 方案 A vs 方案 B 对比表
3. 各自适用场景
4. 推荐策略

**教程型**：
1. 痛点故事
2. 解决方案揭幕
3. 原理解释
4. 逐步实操
5. 常见坑点
6. 验证清单

### 第 5 步：写初稿

**写作规范：**
- 语言：中文，技术术语保留英文原文（如 Agent Skill、context window）
- 引用格式：用 `— 作者名, 来源, 日期` 格式
- 数据引用：带来源标注
- 代码块：保留原文，标注语言
- 表格：Telegram 不支持表格，用 bullet list 或 `key: value` 格式
- 长度：初稿 3000-5000 字（可调整）

**内容质量标准：**
- 每个论点必须有来源支撑（不能凭空断言）
- 引用的一手来源优先于二手转述
- 数据必须带出处
- 正反观点都要覆盖
- 结尾要有可操作的 checklist 或行动建议

**输出方式：**
- 写入文件保存（`/workspace/hermes-space/draft-<slug>.md`）
- 在聊天中给出结构概览 + 文件路径
- 提示用户审阅后可以调整

---

## 与 pipeline 中其他 skill 的衔接

```
content-ideation（选题）→ article-drafting（素材+初稿）→ humanizer（润色）→ publish
                                                              ↑
                                          human-social-copy（如果是社交短内容）
```

- 如果用户先选题再写文章：`content-ideation` 输出选题 → 用户选择 → 本 skill 执行
- 如果文章需要润色：完成后提示可用 `humanizer` 进一步打磨
- 如果是短内容：直接转 `human-social-copy`

---

## 常见坑点

1. **中文搜索质量差**：用英文 query 搜英文源，再翻译/整合为中文文章。不要依赖中文搜索引擎。
2. **web_extract 被拦截**：切换到 browser_navigate + browser_console，用 `document.querySelector('article').innerText` 提取。
3. **snapshot 截断**：browser_snapshot 超过 8000 字符会被截断，改用 browser_console 的 innerText。
4. **素材太多不知道选什么**：回到核心问题——「这篇文章要回答什么问题？」只留直接支撑论点的素材。
5. **初稿太长**：删掉所有「模型已经知道」的内容。Perplexity 的标准：每句话都要通过「去掉会出错吗？」的检验。
6. **没有反面观点**：好文章不是一边倒。搜索 `problems`、`criticism`、`anti-patterns` 补充反面素材。
