# 第三方归属说明

述策助手的 X 页面交互选择器和安排表操作设计参考了 XActions：

- 项目：`https://github.com/nirholas/XActions`
- 作者：nich（`@nichxbt`）
- 参考提交：`3c0d8d335fe4bc8a81f5093155e4e60c33dd8312`

本项目只采用了下列文件中的相关 DOM 选择器、输入事件和 X 原生安排表交互思路，并进行了修改：

- `scripts/postThread.js` — Apache License, Version 2.0
- `scripts/twitter/schedule-post.js` — Apache License, Version 2.0
- `src/schedulePosts.js` — MIT License

XActions 仓库中的 Apache License, Version 2.0 和 MIT License 文本及完整版权声明以其参考提交中的原始文件为准。本仓库没有复制 XActions 的完整运行时，也没有引入其网络服务、任务调度、登录凭据处理或线程发布功能。

述策助手的实现是经过修改的、范围受限的独立 Manifest V3 插件：内部 X DOM 驱动保留了安排表选择器和输入回读校验思路，但当前版本不加载页面桥接、不注入控制台 API，也不创建 `window.Shuce`。插件不读取 Cookie/Token，不访问第三方 API；草稿读取仅通过用户配置的本机 Ediora API 完成。
