# Twitter / X 高级搜索语法参考

来源：https://github.com/igorbrigadir/twitter-advanced-search

> 这些算子适用于 Web / Mobile / TweetDeck 搜索，以及兼容的第三方 API（如 twitterapi.io）。
> 注意：官方 Twitter API v1.1 / v2 / Premium 搜索的支持程度可能不同，需实测。

---

## 内容匹配

| 算子 | 含义 | 示例 |
|------|------|------|
| `word1 word2` | 同时包含两词（空格 = AND） | `AI 大模型` |
| `word1 OR word2` | 任意一词（OR 必须大写） | `LLM OR GPT` |
| `"exact phrase"` | 精确短语 | `"state of the art"` |
| `"the * model"` | 带通配符的短语 | `"the * model"` |
| `-word` | 排除词 | `AI -招聘` |
| `#tag` | 话题标签 | `#人工智能` |
| `$CASHTAG` | 股票代码标签 | `$NVDA` |
| `lang:zh` | 指定语言（中文）| `AI lang:zh` |
| `lang:en` | 英文 | `LLM lang:en` |
| `url:domain.com` | 包含指定域名链接 | `url:arxiv.org` |

**括号组合示例：**
```
(GPT OR Claude OR Gemini) 大模型 -filter:retweets lang:zh
```

---

## 用户过滤

| 算子 | 含义 |
|------|------|
| `from:username` | 来自某账号 |
| `to:username` | 回复某账号 |
| `@username` | 提及某账号（加 `-from:username` 可得纯提及） |
| `filter:verified` | 仅蓝标认证账号 |
| `filter:blue_verified` | Twitter Blue 付费认证 |
| `filter:follows` | 仅你关注的账号（不可取反） |

---

## 互动量过滤

| 算子 | 含义 |
|------|------|
| `min_faves:1000` | 至少 1000 个赞 |
| `min_retweets:100` | 至少 100 次转发 |
| `min_replies:50` | 至少 50 条回复 |
| `-min_faves:500` | 最多 500 个赞（取反作上限） |
| `filter:has_engagement` | 有任意互动 |

---

## 推文类型过滤

| 算子 | 含义 |
|------|------|
| `-filter:retweets` | 排除转发（常用） |
| `-filter:replies` | 排除回复 |
| `filter:replies` | 仅回复 |
| `filter:self_threads` | 仅长串（自回复线程）|
| `filter:quote` | 包含引用推文 |
| `conversation_id:id` | 某对话串内的所有推文 |

---

## 媒体过滤

| 算子 | 含义 |
|------|------|
| `filter:media` | 任意媒体 |
| `filter:images` | 含图片 |
| `filter:videos` | 含视频 |
| `filter:links` | 含链接（含媒体）|
| `filter:news` | 链接到新闻网站 |
| `-filter:media` | 纯文字（无媒体）|

---

## 时间过滤

| 算子 | 含义 |
|------|------|
| `since:2024-01-01` | 该日期之后（含）|
| `until:2024-12-31` | 该日期之前（不含）|
| `since:2024-01-01_00:00:00_UTC` | 精确到时分秒 |
| `within_time:24h` | 最近 N 小时/分钟/秒（d/h/m/s）|
| `since_time:1700000000` | Unix 时间戳之后 |
| `until_time:1700000000` | Unix 时间戳之前 |

---

## 实用查询模板

### 高质量中文 AI 讨论（排除转发和广告）
```
(AI OR 人工智能 OR 大模型 OR LLM) lang:zh -filter:retweets min_faves:10
```

### 英文 AI 热门帖子
```
(AI OR LLM OR "large language model") lang:en -filter:retweets min_faves:100 -filter:replies
```

### 特定账号的原创内容
```
from:OpenAI -filter:retweets -filter:replies
```

### 最近 24 小时内的讨论
```
大模型 within_time:24h -filter:retweets
```

### AI 产品发布（含链接）
```
(AI OR LLM) launch OR release filter:links -filter:retweets lang:en
```

### 寻找高粉丝原创内容（用于发现博主）
```
(AI OR 大模型) lang:zh -filter:retweets filter:has_engagement min_faves:50
```

---

## 注意事项

- **最多约 22-23 个算子**组合使用
- `OR` 必须大写，`AND` 用空格代替
- 括号可嵌套：`(word1 OR word2) (word3 OR word4)`
- `filter:follows` 依赖登录态，第三方 API 通常不支持
- `card_name:` 类算子只对近 7-8 天有效
- 带连字符的词用下划线代替：`url:t_mobile.com`
- 时间算子需配合其他算子才生效
- `queryType: "Latest"` 返回最新推文；`"Top"` 返回热门推文

---

## 在 Ediora 中的用法

`设置 → X → 搜索关键词` 字段支持完整的高级搜索语法，每个条目用逗号分隔。每个条目会作为独立查询发送。

**推荐配置示例：**
```
(AI OR 大模型 OR LLM) lang:zh -filter:retweets min_faves:5,
AI agent lang:en -filter:retweets min_faves:20,
OpenAI OR Anthropic OR Google Gemini lang:en -filter:retweets
```
