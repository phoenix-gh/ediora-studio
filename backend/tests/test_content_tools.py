def test_cover_step_does_not_receive_publish_tool():
    from content_tools import tools_for_step

    assert "publish_draft" not in tools_for_step("cover")


def test_draft_tools_do_not_include_shell_or_arbitrary_http():
    from content_tools import tools_for_step

    assert set(tools_for_step("draft")).isdisjoint({"shell", "fetch_url", "sql"})
