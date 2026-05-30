from pipeline_template import resolve_effective_design


def test_plan_overrides_one_account_cover_key():
    cover, image = resolve_effective_design(
        {"type": "hero", "palette": "warm"}, "acc-img",
        {"palette": "cool"}, "",
    )
    assert cover == {"type": "hero", "palette": "cool"}
    assert image == "acc-img"


def test_task_overrides_plan_and_account():
    cover, image = resolve_effective_design(
        {"type": "hero"}, "acc",
        {"type": "scene"}, "plan-img",
        {"type": "minimal"}, "task-img",
    )
    assert cover["type"] == "minimal"
    assert image == "task-img"


def test_empty_layers_fall_through():
    cover, image = resolve_effective_design(
        {"type": "hero"}, "acc", {}, "", None, None,
    )
    assert cover == {"type": "hero"}
    assert image == "acc"


def test_empty_string_does_not_override():
    cover, image = resolve_effective_design(
        {"type": "hero"}, "acc",
        {"type": ""}, "",   # 空值不覆盖
    )
    assert cover["type"] == "hero"
    assert image == "acc"
