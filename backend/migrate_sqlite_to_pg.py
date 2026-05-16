"""One-off: migrate WeMedia Studio data from SQLite (wemedia.db) to PostgreSQL.

Reads from the legacy SQLite file via SQLAlchemy Core using the current models'
table definitions. Type coercion (Bool 0/1↔true/false, JSON text↔jsonb,
datetime text↔timestamptz) happens transparently because we route through the
SQLAlchemy type system.

Run once:  conda run -n wems python migrate_sqlite_to_pg.py
"""

import sys
import time
from sqlalchemy import create_engine, select, insert, func, text, inspect

# Ensure all models are registered on Base.metadata before we enumerate tables
from database import Base  # noqa: F401
import models  # noqa: F401

SQLITE_URL = "sqlite:///./wemedia.db"
PG_URL = "postgresql+psycopg2://postgres:123456@127.0.0.1:5432/wemedia"
BATCH = 2000

# Optional sort order: process smallest tables first for quick failure detection.
# x_post_metrics (500K rows) deliberately last.


def main():
    src_engine = create_engine(SQLITE_URL)
    dst_engine = create_engine(PG_URL)

    src_inspector = inspect(src_engine)
    src_tables = set(src_inspector.get_table_names())

    # Tables defined in the current models (the destination schema)
    model_tables = list(Base.metadata.sorted_tables)

    # Skip tables that no longer have a model (e.g., economic_items — feature removed)
    legacy_tables_in_sqlite = src_tables - {t.name for t in model_tables} - {"sqlite_sequence"}
    if legacy_tables_in_sqlite:
        print(f"⚠ Skipping legacy tables (no longer in models): {sorted(legacy_tables_in_sqlite)}")

    # Compute row counts up front so we can sort small → large and report progress
    counts = {}
    with src_engine.connect() as src:
        for t in model_tables:
            if t.name not in src_tables:
                counts[t] = -1  # absent in source — model was added after SQLite era
                continue
            counts[t] = src.scalar(select(func.count()).select_from(t)) or 0

    # Sort small first
    ordered = sorted(model_tables, key=lambda t: counts[t] if counts[t] >= 0 else 1 << 30)

    grand_total = 0
    t_start = time.time()

    with src_engine.connect() as src, dst_engine.begin() as dst:
        # Truncate destination tables in reverse FK order — safe because we have no real FKs
        # but doing it anyway in case the script is re-run.
        for t in reversed(model_tables):
            dst.execute(text(f'TRUNCATE TABLE "{t.name}" RESTART IDENTITY CASCADE'))
        print("✓ Destination tables truncated")

    for t in ordered:
        n = counts[t]
        if n < 0:
            print(f"  {t.name:30} (not in SQLite — skipping)")
            continue
        if n == 0:
            print(f"  {t.name:30} (empty)")
            continue

        copied = 0
        t0 = time.time()
        with src_engine.connect() as src, dst_engine.begin() as dst:
            offset = 0
            while True:
                rows = src.execute(
                    select(t).limit(BATCH).offset(offset)
                ).mappings().all()
                if not rows:
                    break
                dst.execute(insert(t), [dict(r) for r in rows])
                offset += len(rows)
                copied += len(rows)
                if n > 20000 and copied % (BATCH * 5) == 0:
                    rate = copied / max(0.1, time.time() - t0)
                    eta = (n - copied) / rate if rate else 0
                    print(f"    {t.name} {copied}/{n} ({rate:.0f}/s, ETA {eta:.0f}s)", flush=True)
            # Bump sequence for integer-PK tables so next INSERT doesn't collide.
            pk_cols = [c for c in t.primary_key.columns]
            if len(pk_cols) == 1 and pk_cols[0].type.python_type is int:
                pk = pk_cols[0].name
                dst.execute(text(
                    f"SELECT setval(pg_get_serial_sequence(:tn, :pk), "
                    f"COALESCE((SELECT MAX(\"{pk}\") FROM \"{t.name}\"), 1))"
                ), {"tn": t.name, "pk": pk})

        grand_total += copied
        print(f"  {t.name:30} {copied:>8} rows")

    elapsed = time.time() - t_start
    print(f"\n✓ Migrated {grand_total:,} rows in {elapsed:.1f}s")

    # Verification — compare counts in both DBs
    print("\nVerification (sqlite vs postgres):")
    mismatches = 0
    with src_engine.connect() as src, dst_engine.connect() as dst:
        for t in model_tables:
            if t.name not in src_tables:
                continue
            sn = src.scalar(select(func.count()).select_from(t)) or 0
            pn = dst.scalar(select(func.count()).select_from(t)) or 0
            mark = "✓" if sn == pn else "✗"
            if sn != pn:
                mismatches += 1
            print(f"  {mark} {t.name:30} sqlite={sn:>7}  pg={pn:>7}")

    if mismatches:
        print(f"\n✗ {mismatches} table(s) have mismatched counts")
        sys.exit(1)
    print("\n✓ All row counts match.")


if __name__ == "__main__":
    main()
