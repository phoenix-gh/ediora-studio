# 述策助手 Chrome 自动发布 MVP 设计

日期：2026-08-08
状态：已批准

## 目标

在项目根目录新增一个独立的 Chrome Manifest V3 插件，显示名称为“述策助手”。第一版用于验证浏览器内自动发布 X 帖子的可行性，不连接 Ediora 后端，也不轮询发布任务。

用户登录 X 后，在开发者控制台调用 `Shuce.publish()`：

```js
await Shuce.publish({
  text: '帖子内容',
  scheduledAt: '2026-08-08 20:30',
})
```

- 不传 `scheduledAt`：立即发布单条帖子。
- 传入 `scheduledAt`：按浏览器本地时区，使用 X 自己的“安排表”完成定时发布。
- 可传 `dryRun: true`：完成内容填充及定时参数设置，但不点击最终提交按钮。

第一版只支持单条帖子，不支持 Thread、投票、媒体上传、X Article 或后端任务领取。

## 方案选择

采用页面注入命令 API 的临时方案：插件在 X 页面暴露 `window.Shuce`，方便用户直接从开发者控制台验证发布效果。

该入口明确是临时开发适配层。正式版不得向页面 `window` 挂载任何对象；正式接入系统时，由 Manifest V3 Service Worker 通过 Chrome 消息调用 isolated-world content script。发布内核不能依赖 `window.Shuce`，以便删除临时入口时无需改写发布逻辑。

未采用的方案：

- 直接让控制台通过 `window.postMessage` 拼装底层调用：调试接口不直观，错误反馈分散。
- 在插件弹窗中提供命令输入框：偏离当前先验证控制台自动发布的目标。

## 项目结构

```text
chrome-extension/
├── manifest.json
├── README.md
├── THIRD_PARTY_NOTICES.md
├── background/
│   └── service-worker.js
├── content/
│   ├── bridge.js
│   └── publisher.js
├── injected/
│   └── console-api.js
├── icons/
└── tests/
```

### 组件职责

- `manifest.json`：Manifest V3 配置，只声明 X/Twitter 页面所需的最小权限。
- `background/service-worker.js`：记录插件启动、最近执行状态和错误。MVP 不请求 Ediora，也不创建轮询定时器。
- `injected/console-api.js`：临时暴露 `Shuce.publish()`，生成请求 ID，通过页面消息发送请求并等待对应结果。
- `content/bridge.js`：校验消息来源、请求结构和请求 ID，将请求交给发布内核，并把结构化结果返回给控制台调用方。
- `content/publisher.js`：执行页面识别、内容填充、立即发布、原生定时发布、成功确认和错误分类。它运行在 Chrome isolated world，不导出页面全局对象。
- `THIRD_PARTY_NOTICES.md`：记录借鉴的 XActions 文件、固定提交版本和许可证。

## 命令契约

```ts
type PublishRequest = {
  text: string
  scheduledAt?: string
  dryRun?: boolean
}

type PublishResult = {
  ok: boolean
  action: 'published' | 'scheduled' | 'dry-run'
  scheduledAt?: string
  error?: {
    code: string
    message: string
    details?: Record<string, unknown>
  }
}
```

`scheduledAt` 只接受 `YYYY-MM-DD HH:mm` 或 `YYYY-MM-DDTHH:mm`，两种格式都解释为浏览器本地时间，不接受带时区或秒的小数格式。返回值中的时间转换为带本地时区偏移的 ISO 字符串。空内容、无效时间和已经过去的时间在操作页面前直接拒绝。

同一标签页同一时间只允许一个发布请求。并发调用返回 `BUSY`，不能覆盖正在编辑的帖子。

## 立即发布流程

1. 确认当前主机是 `x.com` 或 `twitter.com`，并检查用户可以打开帖子编辑器。
2. 打开 X 帖子编辑器；若编辑器已经打开，则拒绝覆盖非空的现有草稿。
3. 通过 `beforeinput`、`input` 和 `execCommand('insertText')` 的兼容路径写入内容。
4. 重新读取编辑器文本，确认与请求内容一致。
5. `dryRun` 时停止并返回，不点击最终按钮。
6. 点击 X 的发布按钮。
7. 以编辑器关闭或 X 成功反馈作为提交成功证据；超时则返回“提交结果未确认”，不能误报成功。

## X 原生安排表流程

1. 完成立即发布流程中的页面检查、打开编辑器、填充和内容校验。
2. 将 `scheduledAt` 按浏览器本地时区解析并确认是未来时间。
3. 打开 X 原生安排表。优先使用稳定的 `data-testid`，并保留已知选择器降级列表。
4. 按安排表实际控件设置年、月、日、小时、分钟和 AM/PM；每次设置后读取控件状态进行核验。
5. 点击安排表对话框的确认操作，返回帖子编辑器。
6. 检查编辑器已显示目标安排时间。
7. `dryRun` 时在此停止，不点击最终“安排”按钮。
8. 点击编辑器最终“安排”按钮。
9. 以编辑器关闭、安排成功反馈或计划时间确认信息消失作为提交证据；无法确认时返回错误。

XActions 的 `src/schedulePosts.js` 提供了安排表入口与部分选择器，但没有完整设置日期/时间，也没有覆盖返回编辑器后的最终提交。述策助手只借鉴其 DOM 交互思路和选择器线索，并补全控件赋值、状态核验及最终安排提交。

## 错误处理

错误使用稳定代码，控制台同时显示可读中文信息：

- `UNSUPPORTED_PAGE`：不在 X/Twitter 页面。
- `NOT_LOGGED_IN`：无法进入帖子编辑器。
- `EMPTY_TEXT`：内容为空。
- `INVALID_SCHEDULE_TIME`：定时时间格式无效。
- `SCHEDULE_TIME_IN_PAST`：定时时间不在未来。
- `COMPOSER_NOT_FOUND`：编辑器未出现。
- `EXISTING_DRAFT`：检测到非空的现有草稿，拒绝覆盖。
- `TEXT_MISMATCH`：写入后内容核验失败。
- `SCHEDULER_UNAVAILABLE`：当前账号或页面没有原生安排表入口。
- `SCHEDULE_CONTROLS_CHANGED`：安排表控件无法识别或设置后核验失败。
- `SUBMIT_NOT_CONFIRMED`：已点击最终按钮，但没有观察到可靠成功证据。
- `BUSY`：当前标签页已有发布请求在执行。

任何失败都保留当前页面状态供用户检查，不自动刷新页面，也不重复点击最终发布按钮。

## 权限与安全边界

- Host permissions 仅允许 `https://x.com/*` 和 `https://twitter.com/*`。
- 不读取、导出或保存 X Cookie、Token 和页面私密数据。
- 不访问 Ediora、本地网络或第三方服务。
- 页面消息必须带固定来源标识、随机请求 ID，并由 bridge 校验结构；结果只响应当前页面发起的已登记请求。
- 日志不得包含 Cookie、Authorization 信息；帖子正文只在当前页面内处理。
- 临时 `window.Shuce` 入口在正式版中整体删除。正式版只保留后台消息、isolated-world bridge 和 publisher 内核。

## XActions 复用与许可证

参考仓库：`https://github.com/nirholas/XActions`
核对提交：`3c0d8d335fe4bc8a81f5093155e4e60c33dd8312`

主要参考：

- `scripts/postThread.js`：打开编辑器、输入和提交的基础流程，Apache-2.0 声明。
- `scripts/twitter/schedule-post.js`：安排表选择器和日期选择思路，Apache-2.0 声明。
- `src/schedulePosts.js`：原生安排表入口与选择器线索，文件声明为 MIT。
- `extension/`：Manifest V3 的 service worker、content script 与页面消息分层，仓库整体声明 Apache-2.0。

实现不整份复制 XActions 插件，只重写当前 MVP 所需逻辑。`THIRD_PARTY_NOTICES.md` 保留原作者、仓库链接、参考文件、提交号和适用许可证；改写文件注明已修改。

## 测试与验收

自动测试覆盖：

- 请求结构与空内容校验。
- 本地时间解析、过去时间拒绝和带时区结果格式。
- 同标签页并发锁。
- 页面与编辑器选择器降级。
- 非空现有草稿保护。
- 内容写入后的文本核验。
- 安排表各控件的设置与回读核验。
- `dryRun` 不点击最终按钮。
- 成功证据、超时和结构化错误映射。
- Manifest 权限和禁止非 X host 的静态检查。

真实浏览器验收按顺序执行：

1. 在 `chrome://extensions/` 以开发者模式加载 `chrome-extension/`。
2. 登录 X，执行立即发布的 `dryRun`，确认内容正确且未提交。
3. 执行一条真实立即发布命令，确认帖子出现在账号页面。
4. 执行一条原生定时发布的 `dryRun`，确认安排表和最终安排时间正确。
5. 执行一条真实定时发布命令，在 X 的 Scheduled posts 中确认任务存在。
6. 验证空内容、过去时间、未登录和安排表不可用时不会产生发布。

涉及真实公开发布的两项验收必须由用户在已登录账号中主动执行；自动测试不得自行发布外部内容。

## 后续正式接入

本 MVP 验证通过后，再单独设计 Ediora 对接：后台服务领取具有租约和幂等键的发布任务，通过 Chrome 消息触发 publisher，最后回写可审计的状态和证据。该阶段删除 `injected/console-api.js`、web-accessible console 资源及所有 `window.Shuce` 相关代码，不沿用页面全局接口。
