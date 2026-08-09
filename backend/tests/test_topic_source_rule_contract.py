import sys


def test_topic_source_rule_declares_screening_prompt(monkeypatch, postgres_env):
    for module in list(sys.modules):
        if module.startswith(("database", "models")):
            sys.modules.pop(module, None)

    from models import TopicSourceRule

    assert TopicSourceRule.screening_prompt.property.columns[0].default.arg == ""
