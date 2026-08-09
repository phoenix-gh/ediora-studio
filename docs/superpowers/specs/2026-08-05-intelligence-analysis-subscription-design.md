# 情报分析订阅开关设计

## 目标

移除已废弃的 X“即时响应”功能，将订阅级开关改为“情报分析”。只有明确开启情报分析的订阅，其开启之后采集到的新帖子才会进入情报站分析。

## 设计决定

- `XSubscription` 使用 `intelligence_enabled` 和 `intelligence_enabled_at` 表示情报分析开关及生效时间。
- 已有订阅迁移后默认关闭情报分析，避免升级后未配置的订阅继续产生分析任务。
- 时间线订阅和搜索订阅都可以启用情报分析；回复帖仍由现有情报入站规则排除。
- 采集器在创建统一情报记录和分析任务前检查订阅是否启用、情报分析是否启用，以及帖子是否在开关生效之后采集。
- `ContentResponseItem` 保存可选的 `subscription_id`，X 情报记录可以追溯到订阅；非 X 来源保持为空。
- 现有情报分析记录、价值分类和创作资产流转数据保留，不因为删除旧功能而删除。
- 移除“即时响应”开关、旧 X 响应路由/前端/Worker 入口和运行时依赖；数据库升级保留必要的历史迁移兼容逻辑，但新模型和业务代码不再使用旧字段。
- 旧 `/x-responses` 页面保留轻量重定向到统一情报站，避免历史书签失效；页面不再展示即时响应语义。

## 数据流

```text
XSubscription(intelligence_enabled)
        -> X collector
        -> gate: enabled + intelligence_enabled + intelligence_enabled_at
        -> ContentResponseItem(subscription_id)
        -> ContentAnalysisRun / content job
        -> 情报站
```

## 验收标准

1. 新建订阅默认 `intelligence_enabled=false`。
2. 开启情报分析后，只有之后采集到的新帖子会创建情报分析记录和任务。
3. 未开启、已禁用或开启前的帖子不会创建情报分析记录。
4. 时间线和搜索订阅都遵循同一开关规则。
5. 订阅接口和 X 订阅界面只出现“情报分析”，不再出现“即时响应”。
6. 旧情报分析记录仍能在情报站查看，且 X 情报能够显示来源订阅。
7. 旧即时响应 API、Worker 和 Telegram 响应流程不再被采集链路调用。

## 风险与边界

- 旧数据库中已存在的 `ContentResponseItem` 没有订阅归属时保持为空，不伪造来源。
- 旧 `notify_new_posts` 为真的订阅不会自动迁移为情报分析开启，全部采用关闭默认值。
- 本次不清理已有情报记录；如需删除历史误入数据，另行按订阅和时间范围执行可审计清理。
