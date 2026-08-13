# Chrome 插件长文章预览滚动设计

## 背景与根因

Chrome 插件发布指挥台的正文节点 `.sw-preview-content` 已声明 `overflow-y: auto`，但它的直接父节点 `<article data-role="preview">` 仍是普通块级元素，没有继承右侧预览栏的可用高度，也不是纵向 flex 容器。长文章因此把 `<article>` 撑高；外层面板的 `overflow: hidden` 再把超出部分和底部操作栏一起裁掉，正文自身不会形成滚动区域。

## 目标行为

1. 标题区和底部“复制内容 / 发布并下一条”操作栏始终保留在预览容器内。
2. 只有正文区域在文章超长时纵向滚动。
3. 滚动正文时底部操作栏位置不变。
4. 短文章、空状态、复制和发布行为保持不变。
5. 桌面布局和窄屏布局使用同一套高度约束，不增加绝对定位或遮挡补偿。

## 设计

给预览 `<article>` 增加独立类名，并将其设为占满剩余空间的纵向 flex 容器：`display: flex; flex-direction: column; min-height: 0; flex: 1; overflow: hidden`。显式保留 `[hidden]` 时的隐藏行为。

正文继续使用 `min-height: 0; flex: 1; overflow-y: auto`，成为唯一可滚动区域。标题区、分隔线和底部操作栏使用 `flex-shrink: 0`，避免长内容或较低视口压缩操作区域。

不使用 `position: fixed` 或 `position: absolute`：操作栏固定在插件面板内部，而不是固定到浏览器视口，也不需要给正文增加容易失配的底部留白。

## 验证

新增 Chromium 布局回归测试，真实加载插件模块、注入一篇超长草稿并打开指挥台，验证：

- 正文 `scrollHeight > clientHeight`；
- 底部操作栏位于预览容器可视范围内；
- 正文滚动后操作栏纵向位置不变；
- 页面没有相关 console error 或 warning。

同时运行插件全部 Node 测试、所有 manifest JavaScript 的语法检查和 `git diff --check`。
