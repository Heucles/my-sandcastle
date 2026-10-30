#!/usr/bin/env python3
"""Strip view definitions that reference schemas absent from the dump.

mysqldump emits a view as a multi-line statement:

    /*!50001 CREATE ALGORITHM=UNDEFINED */
    /*!50013 DEFINER=`root`@`%` SQL SECURITY DEFINER */
    /*!50001 VIEW `name` AS select ... */;

plus a single-line stand-in (`CREATE VIEW `name` AS SELECT 1 AS ...`) earlier
in the file. When a view selects from a schema that wasn't dumped, importing
fails with "Unknown database". This buffers the dump statement-by-statement
(a statement ends on a line terminating with ';') and drops every CREATE VIEW
statement — stand-in or final — for views whose definition references a
missing schema.

usage: strip_cross_schema_views.py <dump.sql> <missing-schema> [...]
Rewrites <dump.sql> in place (via a .tmp file); prints what was removed.
"""
import re
import sys
from pathlib import Path

if len(sys.argv) < 3:
    sys.exit("usage: strip_cross_schema_views.py <dump.sql> <missing-schema> [...]")

dump = Path(sys.argv[1])
missing = sys.argv[2:]
missing_re = re.compile("|".join(rf"`{re.escape(s)}`\." for s in missing))
view_name_re = re.compile(r"VIEW `([^`]+)`")


def statements(path: Path):
    """Yield the dump as (statement_text, is_view_create) chunks."""
    buf: list[str] = []
    with path.open(encoding="utf-8", errors="replace") as f:
        for line in f:
            buf.append(line)
            if line.rstrip().endswith(";"):
                yield "".join(buf)
                buf = []
    if buf:
        yield "".join(buf)


def is_view_create(stmt: str) -> str | None:
    """Return the view name when stmt creates a view (stand-in or final)."""
    if "CREATE" not in stmt or "VIEW" not in stmt or "DROP VIEW" in stmt:
        return None
    m = view_name_re.search(stmt)
    return m.group(1) if m else None


# Pass 1: names of views whose definition references a missing schema.
doomed: set[str] = set()
for stmt in statements(dump):
    name = is_view_create(stmt)
    if name and missing_re.search(stmt):
        doomed.add(name)
print(f"views referencing missing schemas: {sorted(doomed) or 'none'}")

# Pass 2: drop every CREATE VIEW statement (stand-in + final) for those views.
tmp = dump.with_suffix(".tmp")
removed = 0
with tmp.open("w", encoding="utf-8") as out:
    for stmt in statements(dump):
        name = is_view_create(stmt)
        if name and name in doomed:
            removed += 1
            continue
        out.write(stmt)
tmp.replace(dump)
print(f"removed {removed} CREATE VIEW statements from {dump}")
