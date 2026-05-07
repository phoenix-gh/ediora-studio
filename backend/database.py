from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase

DATABASE_URL = "sqlite+aiosqlite:///./wemedia.db"

engine = create_async_engine(
    DATABASE_URL,
    echo=False,
    connect_args={"timeout": 30},  # wait up to 30s for write lock
)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)

class Base(DeclarativeBase):
    pass

async def get_db() -> AsyncSession:
    async with SessionLocal() as session:
        yield session

async def init_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        from sqlalchemy import text
        # WAL mode: allows concurrent reads while writing, reduces lock contention
        await conn.execute(text("PRAGMA journal_mode=WAL"))
        await conn.execute(text("PRAGMA busy_timeout=30000"))
        # Migrate: add title column to posts if it doesn't exist yet
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
            "ALTER TABLE keywords ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE keywords ADD COLUMN source TEXT NOT NULL DEFAULT 'auto'",
        ]:
            try:
                await conn.execute(text(stmt))
            except Exception:
                pass
