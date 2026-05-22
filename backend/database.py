import os
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase

DATABASE_URL = os.getenv(
    "WMS_DATABASE_URL",
    "postgresql+asyncpg://postgres:123456@127.0.0.1:5432/wemedia",
)

engine = create_async_engine(
    DATABASE_URL,
    echo=False,
    pool_pre_ping=True,
    pool_size=10,
    max_overflow=20,
)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)

class Base(DeclarativeBase):
    pass

async def get_db() -> AsyncSession:
    async with SessionLocal() as session:
        yield session

async def init_db():
    from sqlalchemy import text
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
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
