from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase

DATABASE_URL = "sqlite+aiosqlite:///./wemedia.db"

engine = create_async_engine(DATABASE_URL, echo=False)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)

class Base(DeclarativeBase):
    pass

async def get_db() -> AsyncSession:
    async with SessionLocal() as session:
        yield session

async def init_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # Migrate: add title column to posts if it doesn't exist yet
        from sqlalchemy import text
        try:
            await conn.execute(text("ALTER TABLE posts ADD COLUMN title TEXT NOT NULL DEFAULT ''"))
        except Exception:
            pass
        for stmt in [
            "ALTER TABLE topics ADD COLUMN cluster_id TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE topics ADD COLUMN cluster_title TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE topics ADD COLUMN cluster_source_count INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE topic_clusters ADD COLUMN embedding JSON NOT NULL DEFAULT '[]'",
            "ALTER TABLE topic_clusters ADD COLUMN embedding_model TEXT NOT NULL DEFAULT ''",
        ]:
            try:
                await conn.execute(text(stmt))
            except Exception:
                pass
