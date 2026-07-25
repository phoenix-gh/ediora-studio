from x_credential_store import CredentialFileStore, CredentialPair


def reset_rotation_globals(module):
    module._rate_limited_accounts.clear()
    module._current_account_key = ""


def test_generated_files_rotate_after_first_account_is_rate_limited(
    tmp_path,
    monkeypatch,
):
    from feedgrab.fetchers import twitter_cookies

    reset_rotation_globals(twitter_cookies)
    monkeypatch.delenv("X_AUTH_TOKEN", raising=False)
    monkeypatch.delenv("X_CT0", raising=False)
    monkeypatch.setattr(twitter_cookies, "COOKIE_DIR", tmp_path)
    monkeypatch.setattr(twitter_cookies, "SESSION_DIR", tmp_path)
    monkeypatch.setattr(twitter_cookies, "_LEGACY_COOKIE_DIRS", [])
    monkeypatch.setattr(twitter_cookies, "_LEGACY_SESSION_DIRS", [])
    monkeypatch.setattr(twitter_cookies, "_load_from_chrome_cdp", lambda: {})

    store = CredentialFileStore(tmp_path)
    store.write(
        1,
        True,
        CredentialPair(
            "first-account-auth-token-12345",
            "first-account-csrf-token-12345",
        ),
    )
    store.write(
        2,
        True,
        CredentialPair(
            "second-account-auth-token-67890",
            "second-account-csrf-token-67890",
        ),
    )

    first = twitter_cookies.load_twitter_cookies()
    assert first["auth_token"] == "first-account-auth-token-12345"
    twitter_cookies.mark_cookie_rate_limited(first)
    assert set(twitter_cookies._rate_limited_accounts) == {"first-ac"}
    assert twitter_cookies.count_total_accounts() == 2
    assert twitter_cookies.count_available_accounts() == 1

    second = twitter_cookies.load_twitter_cookies()
    assert second["auth_token"] == "second-account-auth-token-67890"

    store.set_enabled(2, False)
    reset_rotation_globals(twitter_cookies)
    assert twitter_cookies.count_total_accounts() == 1
    assert twitter_cookies.count_available_accounts() == 1
