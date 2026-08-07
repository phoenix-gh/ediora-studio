"""Safe lifecycle helpers for isolated PostgreSQL test databases."""

import re

import asyncpg
from sqlalchemy.engine import make_url


TEST_DATABASE_PATTERN = re.compile(r"^wemedia_test_[0-9a-f]{12}$")


def validate_test_database_name(name: str) -> str:
    if not TEST_DATABASE_PATTERN.fullmatch(name):
        raise ValueError(f"unsafe PostgreSQL test database: {name!r}")
    return name


def replace_database_name(url: str, database_name: str) -> str:
    validate_test_database_name(database_name)
    parsed = make_url(url)
    if parsed.drivername != "postgresql+asyncpg":
        raise ValueError(
            "WMS_TEST_DATABASE_ADMIN_URL must use postgresql+asyncpg"
        )
    return parsed.set(database=database_name).render_as_string(
        hide_password=False,
    )


def _admin_dsn(admin_url: str, database_name: str) -> str:
    parsed = make_url(admin_url)
    if parsed.drivername != "postgresql+asyncpg":
        raise ValueError(
            "WMS_TEST_DATABASE_ADMIN_URL must use postgresql+asyncpg"
        )
    if parsed.database == database_name:
        raise ValueError("administrative database cannot be the cleanup target")
    return parsed.set(drivername="postgresql").render_as_string(
        hide_password=False,
    )


async def create_test_database(admin_url: str, database_name: str) -> None:
    name = validate_test_database_name(database_name)
    connection = await asyncpg.connect(_admin_dsn(admin_url, name))
    try:
        await connection.execute(f'CREATE DATABASE "{name}"')
    finally:
        await connection.close()


async def drop_test_database(
    admin_url: str,
    database_name: str,
    *,
    missing_ok: bool = False,
) -> None:
    name = validate_test_database_name(database_name)
    connection = await asyncpg.connect(_admin_dsn(admin_url, name))
    try:
        await connection.execute(
            "SELECT pg_terminate_backend(pid) "
            "FROM pg_stat_activity "
            "WHERE datname=$1 AND pid <> pg_backend_pid()",
            name,
        )
        clause = "IF EXISTS " if missing_ok else ""
        await connection.execute(f'DROP DATABASE {clause}"{name}"')
    finally:
        await connection.close()
