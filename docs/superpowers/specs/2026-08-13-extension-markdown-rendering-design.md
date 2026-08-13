# Chrome 插件 Markdown 文章展示设计

## 背景

述策 Chrome 插件当前在预览区用 `<pre>` 原样展示草稿正文。这样可以保留换行和 Markdown 源文，但标题、列表、链接和正文中的图片都不会被渲染，长文章也缺少可读的内容层次。

## 目标

1. 在插件文章预览区渲染常用 Markdown，包括标题、段落、列表、引用、代码块、链接、强调和图片。
2. 正文中的 `![alt](url)` 图片在预览区显示，并适配当前插件 API 地址下的 `/api/uploads/...` 本地资源。
3. “复制 Markdown”继续把原始 Markdown 写入 `text/plain`；浏览器支持富文本剪贴板时，额外写入渲染后的 `text/html`，让支持富文本的目标应用能够带图粘贴。
4. 保持预览区和底部操作区的独立滚动，超长文章不遮挡复制、发布按钮。

## 非目标

- 不改后端草稿接口、Markdown 存储格式或发布流程。
- 不把 Markdown 中的原始 HTML 当作可执行或可渲染 HTML。
- 不把图片二进制下载后写入剪贴板；富文本剪贴板使用可访问的图片 URL，纯文本降级始终保留 Markdown 图片语法。
- 不在插件运行时依赖 CDN 或远程脚本。

## 方案

### 独立的安全渲染器

在 `chrome-extension/content/markdown-renderer.js` 增加无外部依赖的渲染模块。模块接收 Markdown 和 API 基址，返回渲染后的 DOM 片段及可用于剪贴板的 HTML 字符串。

渲染器使用 DOM API 创建节点，不把正文直接作为 `innerHTML` 插入。块级解析覆盖标题、段落、无序/有序列表、引用、水平线和围栏代码；行内解析覆盖代码、粗体、斜体、删除线、链接和图片。链接和图片 URL 只接受 `http:`、`https:`，本地 `/api/uploads/...` 路径按当前 API 地址补全；其他协议显示为不可点击的文本或跳过图片。

图片节点使用懒加载、最大宽度和等比缩放样式。加载失败时保留图片替代文本和地址提示，不让单张图片破坏整篇预览。

### 预览区

将预览正文容器从 `<pre>` 改为普通内容容器。`renderPreview` 清空容器后调用渲染器，字符统计仍读取原始 Markdown。现有独立滚动容器和固定底部操作区保持不变。

### 剪贴板

增加 Markdown 专用复制函数：

1. 优先调用 `navigator.clipboard.write`，写入一个 `ClipboardItem`，其 `text/plain` 是原始 Markdown，`text/html` 是渲染结果。
2. `write` 或 `ClipboardItem` 不可用、被浏览器拒绝时，退回现有 `writeText`/DOM 复制路径，只复制原始 Markdown。
3. 复制按钮文案改为“复制 Markdown”，成功和失败提示明确说明复制的是原文格式。

### 清单与资源

将渲染器加入 Manifest V3 的 `web_accessible_resources`。更新插件 README，说明预览会渲染 Markdown，复制仍保留原始 Markdown，并在富文本目标中尽力携带图片。

## 安全与兼容性

- 正文中的 HTML 标签、脚本、事件属性不会执行。
- `javascript:`、`data:` 等不安全协议不能生成链接或图片请求。
- API 地址仍由现有设置和白名单控制；Markdown 只能引用当前浏览器可访问的 HTTP(S) 资源。
- 富文本剪贴板是增强能力，失败不影响纯 Markdown 复制。

## 验证

- 单元测试：Markdown 块和图片渲染、本地资源 URL 补全、不安全 URL 拦截。
- 单元测试：富文本剪贴板同时写入 `text/plain` 和 `text/html`，以及不支持富文本时的纯文本降级。
- 插件布局端到端测试：长文章仍可滚动，底部复制/发布操作保持可见，文章图片节点可见。
- 运行插件测试、相关端到端测试、JavaScript 语法检查和 `git diff --check`。

## 验收标准

打开一条包含标题、段落、列表和 `/api/uploads/...` 图片 Markdown 的草稿时，插件预览区显示结构化内容和图片；向纯文本目标复制时得到未改写的完整 Markdown，向支持富文本的目标复制时同时得到格式化内容和图片；超长正文滚动到底部后，复制和发布按钮仍可操作。
