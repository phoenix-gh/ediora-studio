import pytest


def valid_analysis():
    return {
        "content_value_score": 78,
        "value_dimensions": {
            key: {"score": 70, "reason": "有具体信息"}
            for key in (
                "novelty",
                "practicality",
                "credibility",
                "discussion_value",
                "evergreen_value",
            )
        },
        "summary_cn": "中文摘要",
        "core_thesis": "核心思想",
        "key_points": ["观点"],
        "evidence": [{"text": "证据", "type": "source_claim"}],
        "value_points": ["价值"],
        "risks": [],
        "verification_items": [],
        "personal_angles": ["个人角度"],
        "article_outlines": [],
        "comment_angles": [],
        "recommended_output_types": ["expanded_article"],
        "recommended_action": "expand",
        "recommendation_reason": "值得扩写",
        "account_scores": [],
    }


def test_analysis_contract_requires_all_five_value_dimensions():
    from content_response_service import validate_analysis_payload

    payload = valid_analysis()
    del payload["value_dimensions"]["credibility"]

    with pytest.raises(ValueError, match="value_dimensions"):
        validate_analysis_payload(payload)


def test_low_value_analysis_is_valid_and_kept():
    from content_response_service import validate_analysis_payload

    payload = valid_analysis()
    payload["content_value_score"] = 12

    assert validate_analysis_payload(payload)["content_value_score"] == 12


def test_hard_conflict_account_cannot_be_recommended():
    from content_response_service import validate_analysis_payload

    payload = valid_analysis()
    payload["recommended_publish_account_id"] = "blocked"
    payload["account_scores"] = [{
        "publish_account_id": "blocked",
        "score": 99,
        "rank": 1,
        "fit_reasons": [],
        "audience_value": "",
        "recommended_tone": "",
        "recommended_output_types": ["x_share"],
        "taboo_risks": ["硬冲突"],
        "has_hard_conflict": True,
    }]

    with pytest.raises(ValueError, match="hard conflict"):
        validate_analysis_payload(payload)
