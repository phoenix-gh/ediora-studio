# WMS Worker Token 本机持久化设计

## 目标

将当前 Docker 运行环境中 API、Worker 和 Web 共用的
`WMS_WORKER_TOKEN` 持久化到项目根目录 `.env`，确保以后直接执行
Docker Compose 重建或重启时仍使用同一个有效 token。

## 当前状态

- 当前 API 容器持有一个长度为 64 的有效 token。
- 当前 Worker 已使用同一个 token 恢复运行。
- 项目根目录 `.env` 不存在，因此脱离原启动 shell 后执行
  `docker compose up` 会把 Worker token 解析为空值。
- 根目录 `.gitignore` 已忽略 `.env`，`.env.example` 已保留空的
  `WMS_WORKER_TOKEN=` 配置示例。

## 设计

1. 从当前健康 API 容器的环境变量读取现有 token。
2. 验证 token 长度至少为 32 个字符；验证失败时不创建文件。
3. 在项目根目录创建 `.env`，仅写入：

   ```dotenv
   WMS_WORKER_TOKEN=<current-runtime-token>
   ```

4. 文件权限设置为 `600`，只允许当前用户读写。
5. 不打印 token，不把 token 写入设计文档、命令输出、测试快照或 Git。
6. 不生成新 token，不重启当前正常运行的 API、Worker 或 Web。

## 验证

- `git check-ignore -v .env` 必须确认 `.env` 被根目录
  `.gitignore` 忽略。
- 读取 `.env` 时只报告变量是否存在和字符长度，不输出值。
- 使用 `docker compose config` 的解析结果验证 API、Worker 和 Web
  获得长度一致的 token；验证过程不得打印解析后的密钥。
- `git status --short` 不得出现 `.env`。
- 当前 API、Worker 和 Web 必须继续保持运行。

## 非目标

- 不修改 Docker Compose 服务结构。
- 不增加 Docker Secret、命名卷或自动 token 初始化服务。
- 不轮换 token。
- 不把其他 API Key 或数据库密码迁移到 `.env`。
