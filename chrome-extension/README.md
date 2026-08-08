# 述策助手

这是一个独立的 Manifest V3 Chrome 插件，用于在已经登录的 X 页面中发布一条帖子。当前版本只支持单条文字帖子：立即发布，或使用 X 的原生安排表发布。

插件暂时不连接 WeMediaStudio、不轮询后台任务，也不读取 Cookie、Token 或其他登录凭据。正式接入任务系统时，发布器仍应保持在隔离环境中运行。

## 加载插件

1. 打开 `chrome://extensions/`。
2. 打开右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本目录：`chrome-extension/`。
5. 打开 X 并确认已经登录；修改源码后先点击插件卡片上的“重新加载”，再刷新 X 页面。

插件只匹配 `https://x.com/*` 和 `https://twitter.com/*`。

## 控制台命令

在 X 页面打开 DevTools Console，先确认：

```js
typeof Shuce.publish === 'function'
```

立即发布：

```js
await Shuce.publish({ text: '述策助手立即发布测试' })
```

安排表 dry-run：

```js
await Shuce.publish({
  text: '述策助手定时发布测试',
  scheduledAt: '2026-08-08 20:30',
  dryRun: true,
})
```

安排表正式执行：

```js
await Shuce.publish({
  text: '述策助手定时发布测试',
  scheduledAt: '2026-08-08 20:30',
})
```

示例时间仅作格式示范；实际执行时必须换成浏览器本地时区下的未来时间。

`scheduledAt` 只接受 `YYYY-MM-DD HH:mm` 或 `YYYY-MM-DDTHH:mm`，不接受秒数、时区后缀或已经过去的时间。省略它就是立即发布。浏览器本地时区由 X 安排表使用。

## dry-run 行为

- 立即发布 dry-run 会打开/使用编辑器并写入文字，但不会点击最终“发布”按钮。
- 安排表 dry-run 会打开安排表、写入日期和时间、确认安排表对话框，但不会点击最终“发布/安排”按钮。
- 插件会先回读编辑器内容；如果编辑器已有非空草稿，或者回读内容和请求不一致，会停止执行，不覆盖原内容。
- 同一个 X 标签页一次只允许一个发布命令。

建议先清空编辑器，运行 dry-run，确认文字和时间正确后，再运行不带 `dryRun: true` 的命令。正式命令会产生 X 账号上的外部状态，需由用户明确执行。

## 返回值和常见错误

成功返回类似：

```js
{ ok: true, action: 'published' }
{ ok: true, action: 'scheduled', scheduledAt: '2026-08-08T20:30:00+08:00' }
```

失败返回 `{ ok: false, error: { code, message } }`。常见 `code`：

| code | 含义 |
| --- | --- |
| `INVALID_REQUEST` | 参数不是对象，或 `dryRun` 不是布尔值 |
| `EMPTY_TEXT` | 帖子内容为空 |
| `INVALID_SCHEDULE_TIME` | 定时时间格式或日期不存在 |
| `SCHEDULE_TIME_IN_PAST` | 定时时间不是未来时间 |
| `EXISTING_DRAFT` | 编辑器中已有内容，插件不会覆盖 |
| `TEXT_MISMATCH` | 写入后回读内容不一致 |
| `SCHEDULER_UNAVAILABLE` | 当前账号或当前页面没有可用的 X 原生安排表 |
| `SCHEDULE_CONTROLS_CHANGED` | 安排表控件无法识别、回读失败或时间未被确认 |
| `SUBMIT_NOT_CONFIRMED` | 未观察到 X 的发布成功证据 |
| `BUSY` | 当前标签页已有发布任务执行中 |
| `UNSUPPORTED_PAGE` | 当前页面不是 X |

## 查看执行状态

插件只在扩展的 service worker 中保存最近一次执行的状态摘要，不保存帖子正文：`requestId`、成功状态、动作、错误码和结束时间。

在 `chrome://extensions/` 的插件卡片中点击“Service worker”或“检查视图”，然后执行：

```js
chrome.storage.local.get('lastExecution').then(console.log)
```

## 限制和故障排查

- 当前不支持线程、图片、视频、投票、X Articles 或多条队列。
- X 页面 DOM 变化、账号权限、Premium/安排表资格和产品策略都可能导致选择器失效或安排表不可用。
- 如果 `Shuce` 不存在，重新加载插件并刷新 X 页面；如果编辑器已经打开，先清空已有内容。
- 真实发布与真实定时发布不应作为自动化测试的一部分；请使用 dry-run 验证后，再由用户在自己的登录账号中执行。

