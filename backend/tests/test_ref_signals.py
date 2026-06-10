from ref_signals import engagement_score


def test_zero_engagement_is_zero():
    assert engagement_score(0, 0, 0, 0) == 0


def test_monotonic_in_likes():
    low = engagement_score(100, 0, 0, 0)
    high = engagement_score(10_000, 0, 0, 0)
    assert 0 < low < high


def test_anchor_points_default_scale():
    # 纯 likes 单维锚点：1 千赞 ≈ 57，1 万赞 ≈ 76（容差 ±3）
    assert abs(engagement_score(1_000, 0, 0, 0) - 57) <= 3
    assert abs(engagement_score(10_000, 0, 0, 0) - 76) <= 3


def test_capped_at_100():
    assert engagement_score(10**9, 10**9, 10**9, 10**9) == 100


def test_views_dampened():
    # views 单独贡献远小于同数值的 likes
    assert engagement_score(0, 0, 0, 10_000) < engagement_score(10_000, 0, 0, 0)


def test_negative_inputs_treated_as_zero():
    assert engagement_score(-5, -1, -1, -100) == 0


def test_scale_configurable():
    assert engagement_score(1_000, 0, 0, 0, scale=10.0) < engagement_score(1_000, 0, 0, 0, scale=18.5)
