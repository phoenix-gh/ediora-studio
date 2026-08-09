# 全局主题与页面头部一致性设计

## 背景

应用当前同时存在两套视觉实现：基础布局和部分新页面使用 `background`、`surface`、`muted`、`popover` 等语义 token；GitHub、X、公众号、写作模板、Chat 等页面仍直接使用 `bg-white`、`bg-zinc-*`、`text-zinc-*` 和 `border-zinc-*`。原生 `<select>` 也由各页面自行拼接样式，导致浅色/深色主题下出现白底灰字、黑底黑字和边框层级不一致。

页面顶部同样缺少统一契约：侧栏品牌区使用固定 padding，通用 `PageHeader` 和各业务页自定义 header 使用不同的内容高度。现状渲染审计记录到品牌区约 65px，而首页、任务看板、资产、设置等标题区分别约 116px、56px、52px、98px。

## 目标

1. 所有页面的页面背景、面板、弱背景、控件和弹层使用同一套主题语义色，并在浅色/深色主题下保持可读性。
2. 所有原生下拉框的触发器和 option 使用主题背景、前景、边框和 `color-scheme`，不再出现白底灰字或黑底黑字。
3. 侧栏 Logo 品牌区、通用页面标题区和主要业务页面头部采用统一的顶部高度变量；业务页仍可保留自己的工具栏内容，但不再改变首行基准高度。
4. 保留红、黄、绿、蓝、紫等状态和业务语义色，不用中性色迁移覆盖它们。
5. 用组件测试、静态 token 检查和 Playwright 渲染审计覆盖浅色/深色、桌面/窄屏和代表性页面。

## 非目标

- 不重做各业务页面的信息架构、交互流程或数据请求。
- 不替换 Base UI 的 Select/Popover/Dialog 实现。
- 不把代码块、媒体占位、状态徽章等具有明确语义的深色或彩色区域强行改成普通面板色。
- 不增加新的第三方 UI 依赖。

## 设计

### 1. 语义主题层

继续以 `app/globals.css` 的 token 为唯一颜色来源，补充控件和布局契约：

- `--control`：表单控件默认背景，使用 `surface`。
- `--control-hover`：控件 hover/展开背景，使用 `surface-muted`。
- `--app-header-height`：应用主区域顶部基准高度，设为 72px。

页面背景使用 `background`，普通面板使用 `surface`，列表/侧栏/弱分区使用 `surface-muted` 或 `muted`，浮层使用 `popover`。旧页面仅迁移中性色表面和文字层级；状态色仍使用现有红/黄/绿/蓝/紫 token 或 Tailwind 语义色。

### 2. 原生下拉框

新增 `components/ui/native-select.tsx`，导出 `NativeSelect` 和 `nativeSelectClass`。组件保留原生 `<select>` 的可访问性和键盘行为，统一：

- `background-color: var(--control)`、`color: var(--foreground)`、`border-color: var(--input)`；
- 浅色/深色 `color-scheme`；
- placeholder、focus ring、disabled 状态；
- `option` 使用 `surface/foreground`。

所有应用内原生 `<select>` 迁移到该组件；Base UI Select 的 `SelectTrigger` 同步使用 `control`/`control-hover`，其 popup 继续使用 `popover`。

### 3. 顶部高度契约

- Sidebar 品牌区改为 `h-[var(--app-header-height)]`、垂直居中，Logo 使用固定 24px mark。
- `PageHeader` 改为 `data-slot="page-header"`、最小高度为 `var(--app-header-height)`、内容垂直居中；有描述或额外 eyebrow 时允许自然增高，但首行仍以该变量为基准。
- 资产、GitHub、X、公众号、论文、YouTube、掘金、36 氪、Product Hunt、V2EX、Chat、情报中心、任务看板、数字人口播、写作模板等自定义页面头部添加同一 `data-slot` 和高度 class；其内部工具栏不再通过额外 padding 改变品牌首行的对齐基准。

### 4. 页面迁移策略

先迁移共享布局、原生控件和所有页面根部/首屏 header，再迁移各页面中影响整体观感的中性色表面：`white/zinc-50/zinc-100/zinc-200` 映射到语义 surface/muted，配套 neutral text/border 映射到 foreground/muted-foreground/border。代码块、图片占位和状态徽章保留专用颜色。

## 验收标准

- `app/globals.css` 在 light/dark 均定义并使用新的 control/header token。
- 应用内原生 `<select>` 均通过统一组件或统一 `data-slot="native-select"` 样式渲染；浅色 computed `color-scheme` 为 `light`，深色为 `dark`，背景和文字分别来自 control/foreground。
- 品牌区和 `data-slot="page-header"` 首行高度均为 72px；需要描述的页面只允许内容向下扩展，不得使 Logo 区改变高度。
- 代表性路由 `/`、`/assets`、`/settings`、`/github`、`/writing-plans`、`/creation-rules`、`/x`、`/wechat` 在浅色/深色下无明显白底灰字、黑底黑字、错位或横向溢出。
- 相关 Vitest、静态 token 检查和 Playwright 渲染审计通过；既有无关基线错误单独记录。
