def _ctx():
    return {
        "date_str": "2026-06-12",
        "plan_id": 7,
        "accounts_md": "### 号一（account_id: acc1 / wechat）\n- 今日配额 daily_quota：{\"long\": 1}",
        "recent_titles_md": "- 昨天写过的标题",
    }


def test_daily_plan_blueprint_registered_single_step():
    from pipeline_template import get_pipeline
    steps = get_pipeline("daily_plan")
    assert len(steps) == 1
    assert steps[0].role == "planner"
    assert steps[0].assignee == "wms_scout"


def test_daily_plan_body_contains_inputs_and_workflow():
    from pipeline_template import get_pipeline
    step = get_pipeline("daily_plan")[0]
    title = step.title(_ctx())
    body = step.body(_ctx())
    assert "2026-06-12" in title
    # 输入注入
    assert "acc1" in body
    assert "昨天写过的标题" in body
    # 工作流硬指令
    assert "get_topic_candidates" in body
    assert "save_daily_plan(plan_id=7" in body
    assert "group_key" in body
    assert "is_primary" in body
    assert "kanban_complete" in body
