# X 采集账号池与 Telegram Bot 设置设计

日期：2026-07-25
状态：已由用户逐段确认

## 1. 目标

在「设置 → X / Twitter」中提供可维护的 X 采集账号池和完整的 Telegram Bot 配置体验：

- 支持录入、编辑、启停、测试和删除多个 X 采集账号；
- 所有启用账号组成全局池，feedgrab 遇到 429 时自动轮换；
- X 凭据只写，不通过 API 或前端回显；
- 保留并兼容已有的 feedgrab 外部 session；
- Telegram 保持单 Bot、单 Chat ID，增加测试、清除和最近测试状态；
- 不增加任何自动回复、引用、转发或发布 X 的能力。

## 2. 已确认的产品决策

### 2.1 X 账号用途

多个 X 账号是全局采集账号池，不与单个订阅绑定。所有启用账号都可服务时间线采集和搜索采集。账号被 X 限流后，继续使用 feedgrab 现有的 429 标记、跳过和冷却恢复机制。

### 2.2 X 凭据录入

每个账号包含：

- 账号名称；
- `auth_token`；
- `ct0`；
- 启用状态。

新增时必须同时填写两个凭据。编辑时两个凭据都留空表示保留原值；只填写其中一个时拒绝更新。保存不触发外部请求，账号可以先保存、后测试。

### 2.3 Telegram 范围

第一版只支持一个 Telegram Bot 和一个目标 Chat ID。它们同时服务高价值即时通知和每日摘要，不设计多 Bot 路由。

## 3. 架构

### 3.1 X 账号元数据

新增 `XCredentialAccount` 数据模型，只保存非原始凭据数据：

- `id`：整数主键；
- `name`：账号名称；
- `enabled`：是否加入 feedgrab 账号池；
- `credential_slot`：唯一的正整数文件槽位；
- `auth_token_preview`：掩码预览；
- `ct0_preview`：掩码预览；
- `test_status`：`untested | available | expired | rate_limited | failed`；
- `last_tested_at`：最近测试时间；
- `last_test_error`：经过清理的错误摘要；
- `created_at`、`updated_at`。

凭据文件名由 `credential_slot` 确定：启用时为 `x_<slot>.json`，停用时为 `x_<slot>.disabled.json`。创建账号时同时扫描数据库槽位和 session 目录中已有的 `x_<数字>.json`，分配一个未占用的正整数，确保不会覆盖外部文件。槽位属于服务端实现细节，不通过 API 暴露。

“被限流”等状态明确表示最近一次手动测试结果，不承诺是实时监控状态。全局认证状态可以额外展示 feedgrab 当前可用账号总数。

### 3.2 凭据文件服务

新增边界清晰的 X 凭据服务，独占以下职责：

- 使用 feedgrab 的 `get_cookie_dir()` 获取当前 `FEEDGRAB_DATA_DIR`；
- 写入、替换、启停和删除托管凭据文件；
- 设置 session 目录权限为 `0700`，凭据文件权限为 `0600`；
- 使用同目录临时文件和原子替换，避免半写文件；
- 读取单个托管凭据执行服务端测试；
- 扫描托管文件并检查数据库元数据一致性；
- 识别但不修改外部 session。

凭据文件只包含：

```json
{
  "auth_token": "...",
  "ct0": "..."
}
```

服务不修改 `/workspace/github/feedgrab` 或 site-packages 中的 feedgrab。feedgrab 每次采集时重新扫描 `x.json`、`x_<数字>.json`、`twitter.json` 和 `twitter_<数字>.json`，因此添加、编辑、启停账号后不需要重启后端。

### 3.3 外部 session

通过 `feedgrab login twitter` 生成的 `twitter.json`，以及不是由本功能创建的其他合法 session，继续参与 feedgrab 原生轮换。

设置页将它们汇总显示为“外部 session”，只显示来源文件名和是否可识别，不提供 Token 查看、编辑或删除功能。托管账号的 CRUD 永远不会覆盖或清理外部 session。

### 3.4 Telegram

沿用现有 `app_settings` 中的：

- `telegram_bot_token`；
- `telegram_chat_id`。

新增：

- `telegram_test_status`；
- `telegram_last_tested_at`；
- `telegram_last_test_error`。

Bot Token 仍是只写字段，设置输出只包含是否已配置和末四位掩码。测试接口只读取服务端已保存的 Token 与 Chat ID。

## 4. API

### 4.1 X 账号池

`GET /api/x/accounts`

返回：

- 托管账号列表；
- 外部 session 摘要；
- 启用账号数；
- feedgrab 当前可识别账号数和可用账号数。

不返回原始 `auth_token`、`ct0`、文件内容或可用于还原凭据的字段。

`POST /api/x/accounts`

创建账号。请求包含 `name`、`auth_token`、`ct0`、`enabled`。名称不能为空，两个凭据必须同时存在。

`PATCH /api/x/accounts/{id}`

允许修改名称、启用状态或同时替换两个凭据。两个凭据都省略时保留原值。

`DELETE /api/x/accounts/{id}`

删除托管账号元数据和对应凭据文件。接口不接受外部 session 目标。

`POST /api/x/accounts/{id}/test`

读取该账号的服务端凭据，通过 X 的轻量认证接口
`https://x.com/i/api/1.1/account/settings.json` 验证认证状态，不触发订阅采集。请求使用 feedgrab 已有的公开 Web Bearer Token，并设置 `auth_token`、`ct0` Cookie、`x-csrf-token` 和正常浏览器 User-Agent；只有 2xx 且 JSON 响应为对象才视为成功：

- 2xx 且响应有效：`available`；
- 401 或 403：`expired`；
- 429：`rate_limited`；
- 超时、连接失败、无效响应或其他错误：`failed`。

测试结果持久化到账号元数据，响应只返回状态、时间和清理后的错误。

`GET /api/x/auth-status`

保持现有 `ready`、`hint` 字段兼容，同时增加托管账号数、外部 session 数、总账号数和当前可用账号数。

### 4.2 Telegram

`PUT /api/settings`

继续负责保存 Telegram Bot Token 和 Chat ID。Token 留空时保留原值。

`POST /api/settings/telegram/test`

只使用已保存配置发送固定中文消息，内容说明“WeMedia Studio Telegram 连接测试成功”并包含北京时间。成功后保存状态和测试时间；失败时保存清理后的错误，不改变 Token 或 Chat ID。

`DELETE /api/settings/telegram`

需要前端二次确认。清除 Token、Chat ID 和全部测试状态，然后返回最新的安全设置输出。

## 5. 设置页设计

「设置 → X / Twitter」分为三个清晰区域。

### 5.1 X 采集账号池

顶部显示：

- 已启用账号数；
- 外部 session 数；
- feedgrab 可识别账号总数；
- 当前可用账号数。

托管账号列表显示：

- 名称；
- 启用开关；
- 两个凭据的掩码；
- 最近测试状态和时间；
- “测试”“编辑”“删除”操作。

新增和编辑使用对话框：

- 新增必须填写名称、`auth_token`、`ct0`；
- 编辑 Token 输入框默认为空，文案明确“留空保留当前凭据”；
- 启停不需要重新输入 Token；
- 删除前显示二次确认；
- 每个异步操作有独立加载态，避免重复提交。

### 5.2 即时响应设置

保留并明确区分：

- 即时响应总开关；
- X 订阅采集间隔；
- “建议使用的发布账号画像”。

“X 采集账号”只负责读取 X；“发布账号画像”只用于生成建议文案，两者不得使用相同的含混标签。

### 5.3 Telegram Bot

显示：

- Token 是否配置及末四位掩码；
- Chat ID；
- 最近测试状态、时间和错误摘要；
- 保存配置；
- 发送测试消息；
- 清除配置。

测试按钮只测试已保存配置。如果表单存在尚未保存的修改，界面先提示保存，避免用户误以为测试了输入框中的新 Token。

## 6. 数据流

### 6.1 创建账号

1. 校验名称和成对凭据；
2. 数据库 `flush` 得到账号 ID；
3. 扫描数据库和 session 目录，分配未占用的 `credential_slot`；
4. 在 session 目录创建临时文件并设为 `0600`；
5. 原子替换为启用或停用文件名；
6. 提交数据库；
7. 返回不含原始凭据的账号数据。

数据库提交失败时删除新文件并回滚。

### 6.2 更新凭据

1. 读取并隔离旧文件；
2. 原子写入新文件；
3. 更新掩码并把测试状态重置为 `untested`；
4. 提交数据库；
5. 提交失败时恢复旧文件。

只修改名称不会重写凭据文件。启停操作只原子重命名文件。

### 6.3 删除账号

1. 将凭据文件原子移动到同目录隔离名；
2. 删除数据库元数据并提交；
3. 提交成功后删除隔离文件；
4. 提交失败时恢复原文件。

### 6.4 采集轮换

采集逻辑不接收账号 ID。feedgrab 从固定 session 目录加载环境变量账号、外部 session 和所有启用的托管 `x_<slot>.json`，按其现有优先级选择账号。收到 429 后由 feedgrab 标记当前账号并选择下一个未限流账号。

## 7. 安全与错误处理

- 完整 X Token 只存在于权限受限的 session 文件；
- 完整 Telegram Token 只存在于服务端设置存储；
- 前端、API 响应、异常详情和 WMS 日志不包含完整凭据；
- 后端日志增加凭据模式脱敏，覆盖 feedgrab 可能输出的 `auth_token` 标识；
- 预览只显示固定末四位，不能用于恢复 Token；
- X 测试与 Telegram 测试都有明确超时；
- 上游错误被映射为有限状态和清理后的中文提示；
- 单账号缺失或损坏只影响该账号，不阻止其他账号采集；
- 启动一致性检查只报告或标记托管文件问题，不自动删除未知文件；
- 清除 Telegram 配置不会修改任何历史响应决策或消息 ID；
- 所有发布行为仍由用户手工完成。

## 8. 部署与兼容

Docker Compose 的 API 服务增加：

- `FEEDGRAB_DATA_DIR=/app/sessions`；
- 持久化卷 `sessions-data:/app/sessions`。

本地开发仍可使用默认 `backend/sessions`，或在启动前设置绝对的 `FEEDGRAB_DATA_DIR`。目录位置在进程启动时确定，不能从设置页动态修改。

数据库初始化增加 `XCredentialAccount` 表。现有 `twitter.json`、现有 Telegram 设置、X 订阅和 X 响应决策不迁移、不删除，旧客户端仍可读取兼容的 `/api/x/auth-status` 字段。

## 9. 测试与验收

### 9.1 后端

- X 账号 CRUD、字段校验和不存在目标；
- 新增、更新、启停、删除对应文件行为；
- 文件目录 `0700`、文件 `0600` 和原子替换；
- 数据库或文件失败时的补偿恢复；
- 编辑时留空保留旧凭据；
- 凭据替换后测试状态重置；
- API、错误和日志不泄露完整凭据；
- 外部 session 被识别但不被修改；
- 已占用的外部 `x_<数字>.json` 槽位不会被托管账号覆盖；
- 认证测试的 2xx、401、403、429、超时和无效响应映射；
- 两个托管账号中第一个模拟 429 后 feedgrab 使用第二个账号；
- 停用账号不参与 feedgrab 加载；
- Telegram Token 只写；
- Telegram 测试只使用已保存配置并发送固定消息；
- Telegram 测试状态持久化；
- Telegram 清除完整移除配置和测试状态。

### 9.2 前端

- 账号池汇总和账号列表；
- 新增、编辑、启停、测试、删除确认；
- Token 输入与掩码状态；
- 成对凭据校验；
- 每个操作的加载和错误状态；
- Telegram 保存、测试、清除和最近测试结果；
- “采集账号”与“发布账号画像”的文案区分；
- 设置输出中不存在原始 Token。

### 9.3 运行验收

1. 在临时 session 目录创建两个托管账号；
2. 确认 feedgrab 识别两个启用账号；
3. 停用其中一个并确认其不参与加载；
4. 模拟第一个账号 429 并验证切换到第二个；
5. 使用受控 Telegram transport 验证固定测试消息；
6. 有真实 Bot 和 Chat ID 时执行一次真实送达测试；
7. 运行完整后端测试、前端测试、类型检查、前端构建、Python 编译、Compose 配置检查和 `git diff --check`。

## 10. 非目标

- 不为 X 订阅绑定固定采集账号；
- 不实现多 Telegram Bot 或多 Chat ID 路由；
- 不从浏览器读取或展示原始 Token；
- 不让设置页动态修改 session 根目录；
- 不重写 feedgrab 的账号轮换算法；
- 不增加自动回复、转发、引用或发布能力。
