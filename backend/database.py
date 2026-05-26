import os
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase

DATABASE_URL = os.getenv(
    "WMS_DATABASE_URL",
    "postgresql+asyncpg://postgres:123456@127.0.0.1:5432/wemedia",
)

_engine_kwargs: dict = dict(echo=False, pool_pre_ping=True)
if not DATABASE_URL.startswith("sqlite"):
    _engine_kwargs.update(pool_size=10, max_overflow=20)

engine = create_async_engine(DATABASE_URL, **_engine_kwargs)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)

class Base(DeclarativeBase):
    pass

async def get_db() -> AsyncSession:
    async with SessionLocal() as session:
        yield session

async def init_db():
    from sqlalchemy import text
    async with engine.begin() as conn:
        # Drop legacy X tables (replaced by new schema). Dev DB only.
        # NOTE: x_posts is no longer dropped here — we keep collected data
        # across restarts and migrate the schema via ALTER TABLE below.
        await conn.execute(text("DROP TABLE IF EXISTS x_post_metrics CASCADE"))
        await conn.execute(text("DROP TABLE IF EXISTS x_blogger_candidates CASCADE"))
        await conn.run_sync(Base.metadata.create_all)
        # x_posts column additions (idempotent)
        await conn.execute(text(
            "ALTER TABLE x_posts ADD COLUMN IF NOT EXISTS author_avatar VARCHAR NOT NULL DEFAULT ''"
        ))
        await conn.execute(text(
            "ALTER TABLE x_posts ADD COLUMN IF NOT EXISTS cover_image VARCHAR NOT NULL DEFAULT ''"
        ))
        # Lightweight in-place migrations for columns added after the original
        # table creation. PostgreSQL only — ADD COLUMN IF NOT EXISTS is no-op
        # when the column is already present.
        await conn.execute(text(
            "ALTER TABLE wechat_articles ADD COLUMN IF NOT EXISTS content TEXT NOT NULL DEFAULT ''"
        ))
        await conn.execute(text(
            "ALTER TABLE writer_personas ADD COLUMN IF NOT EXISTS model VARCHAR NOT NULL DEFAULT ''"
        ))
        await conn.execute(text(
            "ALTER TABLE publish_accounts ADD COLUMN IF NOT EXISTS voice_samples JSON NOT NULL DEFAULT '[]'::json"
        ))
        await conn.execute(text(
            "ALTER TABLE publish_accounts ADD COLUMN IF NOT EXISTS style_rules JSON NOT NULL DEFAULT '[]'::json"
        ))
        await conn.execute(text(
            "ALTER TABLE publish_accounts ADD COLUMN IF NOT EXISTS cover_style JSON NOT NULL DEFAULT '{}'::json"
        ))
