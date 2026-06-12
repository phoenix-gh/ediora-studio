# 草稿发布：X 长文预览 + 一键复制 设计

日期：2026-06-12
状态：已批准（方案 A）

## 需求

草稿箱「发布」流程增加对 X 长文（X Articles）的支持。X 没有长文发布 API，链路是
**预览 + 一键复制 → 用户手动粘贴到 x.com 文章编辑器**。

- 入口：现有「发布」按钮打开统一发布弹窗，顶部 tab 切换「公众号 / X 长文」。
- 复制：富文本（text/html，保留粗体/标题/列表/链接）和纯文本（去 markdown 语法）双按钮。
- 预览：仿 X 文章阅读页（居中窄栏、大标题 + 封面图、明/暗主题切换），附「兼容性提示」
  列出草稿中 X 不支持的语法。

## 方案选型

选 **A：发布弹窗重组为壳 + 平台面板**。

- B（在 WechatPublishDialog 里塞 tab 分支）被否：文件已 475 行，两平台 state 混杂。
- C（独立弹窗 + 下拉入口）被否：用户选了 tab 形态。

## 组件结构（app/drafts/）

- `PublishDialog.tsx`（新）：Dialog 壳 + 「公众号 / X 长文」tab。props 与原
  WechatPublishDialog 一致（open/onClose/draftId/title/content/images）。
  记住上次选中的 tab（localStorage `wms-publish-tab`）。
- `WechatPublishPanel.tsx`（平移）：原 WechatPublishDialog 内容区原样搬入，
  去掉 Dialog 壳，逻辑零改动。原文件删除。
- `XArticlePanel.tsx`（新）：
  - 预览：`marked`（已有依赖）md→HTML，React 直接渲染（不用 iframe），
    仿 X 阅读页样式：居中 ~600px 窄栏、大标题、封面图（复用 cover 挑选逻辑）、
    系统字体栈近似 Chirp、明/暗主题切换按钮（仅预览容器局部切换）。
  - 兼容性提示：`scanUnsupported()` 扫描代码块/行内代码/表格/HTML 标签/脚注，
    有则黄色警告条列出「粘贴到 X 后会丢格式」。
  - 复制富文本：clipboard 写 text/html（图片 src 绝对化）+ text/plain；
    失败 fallback writeText（与公众号 handleCopy 同模式）。
  - 复制纯文本：`mdToPlainText()` 输出。
  - 操作提示：标题与封面需在 X 编辑器手动设置；图片粘贴可能不带入需手动上传。
- `DraftsClient.tsx`：import 从 WechatPublishDialog 换成 PublishDialog，props 不变。

## 纯函数（lib/x-article.ts）

- `mdToPlainText(md)`：代码块去围栏留内容、图片移除、链接转 `文字 (url)`、
  去 #/**/_/`/> 前缀符号、列表行保留、折叠 3+ 空行为 2。
- `scanUnsupported(md)`：返回 `{ kind, label, count }[]`，kind ∈
  fenced_code / inline_code / table / html_tag / footnote。

与 UI 解耦，便于将来补测试（前端当前无测试框架）。

## 验证

前端无测试框架：`tsc --noEmit` + eslint（改动文件，对照既存问题）+ `pnpm build`，
起 dev 手动确认弹窗 tab、预览、两个复制按钮。

## 错误处理

- clipboard 写入失败 → 降级 writeText，再失败 toast 报错。
- marked 同步渲染，无网络依赖；渲染异常 try/catch + toast。
