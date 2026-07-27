# YouTube Cookie 设置设计

**日期：** 2026-07-27  
**状态：** 待实现

## 目标

在设置页新增独立的「YouTube」项，让单用户本地部署可以粘贴浏览器导出的 Netscape 格式 `cookies.txt`，供 `yt-dlp` 下载 YouTube 字幕和音频时使用，降低匿名访问触发 429 的概率。

## 范围

- 新增 YouTube Cookie 的保存、状态查询和清除能力。
- 字幕下载、音频下载和视频元数据读取均使用已配置的 Cookie。
- 新增设置页的 YouTube 导航项和 Cookie 编辑卡片。

不包含 Cookie 自动从浏览器读取、账号轮换、代理配置或规避 YouTube 风控的保证。

## 数据与安全边界

- Cookie 原文存入本地 `app_settings` 的 `youtube_cookies` 配置项。
- `GET /api/settings` 只返回 `youtube_cookies_set: boolean`，绝不回传 Cookie 原文或预览。
- `PUT /api/settings` 接收 `youtube_cookies`；空内容表示清除现有 Cookie。
- 服务端仅接受 Netscape Cookie 文件格式；普通 HTTP `Cookie:` 请求头返回 422。
- Cookie 不写入日志、异常信息、Git、Docker 镜像或持久化临时文件。
- 每次调用 `yt-dlp` 时，后端在受限临时目录中创建 Cookie 文件，追加 `--cookies <临时路径>`，命令完成后由临时目录清理。

## 后端流程

1. 设置更新请求校验并保存 Cookie 原文。
2. `extract_youtube_transcript` 读取配置中的 Cookie。
3. `yt-dlp` 命令构建函数仅在 Cookie 已配置时创建临时文件并追加 `--cookies`。
4. 元数据、字幕和音频三个 `yt-dlp` 调用复用同一次提取流程中的 Cookie 文件。
5. 无 Cookie 时维持当前匿名行为；上游 429 继续标记为可重试失败。

## 前端交互

- 设置侧栏新增「YouTube」，说明为「Cookie · 字幕下载稳定性」。
- 页面展示 Cookie 是否已配置。
- 多行输入框用于粘贴完整 Netscape `cookies.txt`。
- 保存后清空输入框，只刷新配置状态；不会回显机密内容。
- 提供「清除 Cookie」按钮并在操作后刷新状态。
- 展示简短导出说明：从已登录 YouTube 的浏览器导出 Netscape 格式 Cookie 文件。

## 验收与测试

- 后端测试：Cookie 保存后状态为已配置、读取接口不泄露原文、空值清除、非 Netscape 格式被拒绝。
- 转录测试：已配置 Cookie 时三个 `yt-dlp` 调用均带 `--cookies`；未配置时不带该参数；临时 Cookie 文件在调用期间内容正确。
- 前端测试：YouTube 设置项可见、保存请求带 Cookie、配置状态与清除操作正确更新。
- 手工验证：设置有效 Cookie 后，对失败视频执行一次字幕重试；若 YouTube 未限流，确认 `zh-Hans` 字幕可入库。429 仍属于上游限制，不作为 Cookie 配置有效性的唯一判断。
