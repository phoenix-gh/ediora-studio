from pipeline_template import GENRE_PROFILES, _genre_profile


def test_four_genres_present():
    assert set(GENRE_PROFILES) == {"commentary", "tutorial", "story", "review"}


def test_commentary_flags():
    p = GENRE_PROFILES["commentary"]
    assert p.first_person is True and p.humanizer is True
    assert p.label == "评论"


def test_tutorial_flags_and_structure():
    p = GENRE_PROFILES["tutorial"]
    assert p.first_person is False and p.humanizer is False
    assert "编号步骤" in p.structure_md
    assert "禁令对本文体作废" in p.structure_md  # 平行结构作废


def test_review_flags():
    p = GENRE_PROFILES["review"]
    assert p.first_person is False and p.humanizer is False


def test_genre_profile_defaults_to_commentary():
    assert _genre_profile({}).key == "commentary"
    assert _genre_profile({"genre": None}).key == "commentary"
    assert _genre_profile({"genre": "nope"}).key == "commentary"
    assert _genre_profile({"genre": "tutorial"}).key == "tutorial"
