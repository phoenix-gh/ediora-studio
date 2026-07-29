import pytest


@pytest.mark.parametrize(
    "value",
    ["", "not-a-number", "0", "-1", "nan", "inf", "301"],
)
def test_database_timeout_rejects_invalid_or_excessive_values(value):
    from database import _parse_database_timeout_seconds

    with pytest.raises(ValueError, match="WMS_DATABASE_COMMAND_TIMEOUT_SECONDS"):
        _parse_database_timeout_seconds(value)


def test_database_timeout_accepts_finite_positive_values():
    from database import _parse_database_timeout_seconds

    assert _parse_database_timeout_seconds("0.25") == 0.25
    assert _parse_database_timeout_seconds("300") == 300


def test_database_engine_options_are_driver_specific():
    from database import _database_engine_kwargs

    postgres = _database_engine_kwargs(
        "postgresql+asyncpg://postgres@example.test/wemedia",
        12.5,
    )
    sqlite = _database_engine_kwargs(
        "sqlite+aiosqlite:////tmp/wemedia.db",
        12.5,
    )
    other = _database_engine_kwargs(
        "mysql+aiomysql://root@example.test/wemedia",
        12.5,
    )

    assert postgres["connect_args"] == {"command_timeout": 12.5}
    assert postgres["pool_size"] == 10
    assert postgres["max_overflow"] == 20
    assert sqlite["connect_args"] == {"timeout": 12.5}
    assert "pool_size" not in sqlite
    assert "max_overflow" not in sqlite
    assert "connect_args" not in other
