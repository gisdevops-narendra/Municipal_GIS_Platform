"""What each layer column means, learned from the data itself.

At every re-index (an upload, delete or rename triggers one) each column of
each layer is profiled with one aggregate query per layer — row count,
distinct values, empty share, text length, min/max — and given:

  * a role:  id | name | category | measure | free_text | date | flag | hidden
  * a unit for measures (from the column name and the value range),
  * aliases (the column name in plain words: bldg_ht -> "building height"),
  * a one-line description.

Results go to `ai_field_metadata`. A row the Owner edited (`source` =
'owner') keeps its role/unit/description/aliases; `learned_aliases` (users'
answers to "which field did you mean?") always survive.

At question time the backend sends each field's role/unit/aliases with the
catalog; `use_layers()` makes them visible to the planner, and `RoleRule`
lets the old column-name patterns step aside wherever the data said
otherwise. A field without metadata falls back to the name pattern.
"""
from __future__ import annotations

import json
import re
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Set

ROLES = ("id", "name", "category", "measure", "free_text", "date", "flag", "hidden")

# Large tables are profiled from a random sample of about this many rows.
_PROFILE_ROWS = 200_000
# A text column with at most this many distinct values is a category.
_CATEGORY_MAX = 50
_FREE_TEXT_LEN = 40

_SYSTEM_COLUMN = re.compile(
    r"^(ogc_fid|fid|gid|objectid|object_id|globalid|gen_id|gis_workspace_id)$|^shape_", re.I
)
_ID_NAME = re.compile(r"(^|_)(id|gisid|uid|uuid|code|fid|gid|key)$", re.I)

# Common abbreviations in GIS column names -> the word users say.
_ABBREVIATIONS = {
    "ht": "height", "hgt": "height", "elev": "elevation", "dia": "diameter", "diam": "diameter",
    "len": "length", "lgth": "length", "wd": "width", "wdth": "width", "dep": "depth", "dpth": "depth",
    "no": "number", "num": "number", "nm": "name", "addr": "address", "typ": "type",
    "cond": "condition", "yr": "year", "dt": "date", "qty": "quantity", "cap": "capacity",
    "pop": "population", "bldg": "building", "bld": "building", "rd": "road", "st": "street",
    "ar": "area", "flr": "floor", "flrs": "floors", "mat": "material", "stat": "status",
    "desc": "description", "rmk": "remark", "loc": "location", "zn": "zone",
}
_UNIT_WORDS = [
    (re.compile(r"(^|_)(sqm|sq_m|area_m2|m2)(_|$)", re.I), "sq m"),
    (re.compile(r"(^|_)(sqft|sq_ft|ft2)(_|$)", re.I), "sq ft"),
    (re.compile(r"(^|_)(ha|hectares?)(_|$)", re.I), "ha"),
    (re.compile(r"(^|_)(km|kms)(_|$)", re.I), "km"),
    (re.compile(r"(^|_)(mm)(_|$)", re.I), "mm"),
    (re.compile(r"(^|_)(cm)(_|$)", re.I), "cm"),
    (re.compile(r"(^|_)(ft|feet)(_|$)", re.I), "ft"),
    (re.compile(r"(^|_)(pct|percent|perc)(_|$)", re.I), "%"),
    (re.compile(r"(^|_)(m|mtr|mtrs|meters?|metres?)(_|$)", re.I), "m"),
    (re.compile(r"area", re.I), "sq m"),
    (re.compile(r"(height|length|width|depth|elev|ht|len|dist)", re.I), "m"),
]


def name_words(field: str) -> List[str]:
    """`BldgHt_m` -> ["building", "height", "m"]."""
    spaced = re.sub(r"([a-z])([A-Z])", r"\1 \2", field)
    parts = [p.lower() for p in re.split(r"[^A-Za-z0-9]+", spaced) if p]
    return [_ABBREVIATIONS.get(p, p) for p in parts if not p.isdigit()]


def _guess_unit(field: str, high: Optional[float]) -> Optional[str]:
    if re.search(r"(^|_)dia", field, re.I):
        # pipe diameters are stored in mm unless the values are tiny
        return "m" if high is not None and high <= 5 else "mm"
    for pattern, unit in _UNIT_WORDS:
        if pattern.search(field):
            return unit
    return None


@dataclass
class Profile:
    role: str
    unit: Optional[str]
    description: str
    aliases: List[str]
    stats: dict


def _num(v) -> Optional[float]:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def classify(field: str, kind: str, stats: dict, samples: List[str]) -> Profile:
    """Role, unit, aliases and description of one column from its stats."""
    rows = stats.get("rows") or 0
    filled = stats.get("filled") or 0
    distinct = stats.get("distinct") or 0
    avg_len = stats.get("avg_len") or 0
    words = name_words(field)
    plain = " ".join(words)
    unique = filled >= 20 and distinct >= 0.95 * filled

    if _SYSTEM_COLUMN.search(field) or kind in ("id", "geometry"):
        role = "hidden"
    elif rows >= 20 and filled <= 0.02 * rows:
        role = "hidden"  # (almost) always empty
    elif kind == "boolean":
        role = "flag"
    elif kind == "date":
        role = "date"
    elif kind in ("integer", "number"):
        if unique and kind == "integer" and _ID_NAME.search(field):
            role = "id"
        elif kind == "integer" and distinct <= _CATEGORY_MAX and not unique and _guess_unit(field, None) is None:
            role = "category"  # ward 1..32, floors 1..12
        else:
            role = "measure"
    else:
        values = {s.strip().lower() for s in samples if s != "…(more)"}
        if values and distinct <= 2 and values <= {"yes", "no", "y", "n", "true", "false", "0", "1"}:
            role = "flag"
        elif avg_len > _FREE_TEXT_LEN:
            role = "free_text"
        elif unique and (_ID_NAME.search(field) or (stats.get("spaced") or 0) < 0.1 and (stats.get("digits") or 0) > 0.8):
            role = "id"  # "WV-0012"
        elif distinct <= _CATEGORY_MAX or (filled and distinct <= 0.2 * filled):
            role = "category"
        else:
            role = "name"

    high = _num(stats.get("max"))
    unit = _guess_unit(field, high) if role == "measure" else None

    aliases: List[str] = []
    if plain and plain != field.lower():
        aliases.append(plain)
    if unit and words and words[-1] in (unit, "m", "mm", "km", "ft", "cm"):
        bare = " ".join(words[:-1])
        if bare and bare not in aliases:
            aliases.append(bare)

    parts = [{
        "id": "Identifier", "name": "Name of each feature", "category": "Category",
        "measure": "Measurement", "free_text": "Free text", "date": "Date",
        "flag": "Yes/No flag", "hidden": "Internal column",
    }[role]]
    if plain:
        parts[0] += f" ({plain})"
    if unit:
        parts.append(f"in {unit}")
    if role in ("measure", "date") and stats.get("min") is not None:
        parts.append(f"from {stats['min']} to {stats['max']}")
    if role in ("category", "name", "flag") and distinct:
        parts.append(f"{distinct} distinct values")
        shown = [s for s in samples if s != "…(more)"][:4]
        if shown:
            parts.append("e.g. " + ", ".join(shown))
    return Profile(role, unit, ", ".join(parts), aliases, stats)


# ---------------------------------------------------------------- profiling

async def _profile_stats(conn, table: str, columns, scope_sql: str, params: list) -> Dict[str, dict]:
    """One aggregate query for every column of a table (sampled if big)."""
    est = await conn.fetchval(
        "SELECT reltuples::bigint FROM pg_class WHERE oid = to_regclass($1)", table
    ) or 0
    sample = ""
    if est > _PROFILE_ROWS:
        sample = f"TABLESAMPLE SYSTEM ({max(0.01, round(100.0 * _PROFILE_ROWS / est, 4))})"
    selects = ["count(*) AS n"]
    for i, c in enumerate(columns):
        q = '"' + c.name.replace('"', '""') + '"'
        selects += [f"count({q}) AS f{i}", f"count(DISTINCT {q}) AS d{i}"]
        if c.kind in ("integer", "number", "date"):
            selects += [f"min({q})::text AS lo{i}", f"max({q})::text AS hi{i}"]
        if c.kind == "text":
            selects += [
                f"avg(length({q}::text)) AS l{i}",
                f"avg(({q}::text ~ '\\s')::int) AS s{i}",
                f"avg(({q}::text ~ '\\d')::int) AS g{i}",
            ]
    row = await conn.fetchrow(
        f'SELECT {", ".join(selects)} FROM "{table}" {sample} {scope_sql}', *params
    )
    out: Dict[str, dict] = {}
    for i, c in enumerate(columns):
        stats = {"rows": row["n"], "filled": row[f"f{i}"], "distinct": row[f"d{i}"]}
        if f"lo{i}" in row.keys():
            stats["min"], stats["max"] = row[f"lo{i}"], row[f"hi{i}"]
        if f"l{i}" in row.keys():
            stats["avg_len"] = float(row[f"l{i}"] or 0)
            stats["spaced"] = float(row[f"s{i}"] or 0)
            stats["digits"] = float(row[f"g{i}"] or 0)
        if sample:
            stats["sampled"] = True
        out[c.name] = stats
    return out


async def learn_layers(conn, municipality_id: str, layers) -> None:
    """Profiles every column of `layers` (catalog.LayerCatalog), stores the
    result, and puts the merged metadata (Owner edits and learned aliases
    included) back on each catalog Column for the index documents."""
    for layer in layers:
        cols = [c for c in layer.columns if c.kind != "geometry"]
        if not cols:
            continue
        scope, params = ("WHERE gis_workspace_id = $1", [layer.workspace_id]) if layer.is_demo else ("", [])
        try:
            stats = await _profile_stats(conn, layer.table, cols, scope, params)
        except Exception:
            stats = {}
        for c in cols:
            p = classify(c.name, c.kind, stats.get(c.name, {}), c.sample_values)
            await conn.execute(
                """
                INSERT INTO ai_field_metadata
                    (layer_id, field, municipality_id, role, unit, description, aliases, stats, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now())
                ON CONFLICT (layer_id, field) DO UPDATE SET
                    municipality_id = EXCLUDED.municipality_id,
                    stats = EXCLUDED.stats,
                    updated_at = now(),
                    role = CASE WHEN ai_field_metadata.source = 'owner' THEN ai_field_metadata.role ELSE EXCLUDED.role END,
                    unit = CASE WHEN ai_field_metadata.source = 'owner' THEN ai_field_metadata.unit ELSE EXCLUDED.unit END,
                    description = CASE WHEN ai_field_metadata.source = 'owner' THEN ai_field_metadata.description ELSE EXCLUDED.description END,
                    aliases = CASE WHEN ai_field_metadata.source = 'owner' THEN ai_field_metadata.aliases ELSE EXCLUDED.aliases END
                """,
                layer.layer_id, c.name, municipality_id, p.role, p.unit, p.description,
                p.aliases, json.dumps(p.stats, default=str),
            )
        # columns dropped from the table
        await conn.execute(
            "DELETE FROM ai_field_metadata WHERE layer_id = $1 AND NOT (field = ANY($2::text[]))",
            layer.layer_id, [c.name for c in cols],
        )
    # layers deleted since the last re-index
    await conn.execute(
        "DELETE FROM ai_field_metadata WHERE municipality_id = $1 AND NOT (layer_id = ANY($2::text[]))",
        municipality_id, [l.layer_id for l in layers],
    )

    rows = await conn.fetch(
        "SELECT layer_id, field, role, unit, description, aliases, learned_aliases "
        "FROM ai_field_metadata WHERE municipality_id = $1",
        municipality_id,
    )
    meta = {(r["layer_id"], r["field"]): r for r in rows}
    for layer in layers:
        for c in layer.columns:
            r = meta.get((layer.layer_id, c.name))
            if r:
                c.role, c.unit, c.description = r["role"], r["unit"], r["description"]
                c.aliases = list(dict.fromkeys([*(r["learned_aliases"] or []), *(r["aliases"] or [])]))


# ----------------------------------------------------- question-time roles

_ROLES: ContextVar[Dict[str, str]] = ContextVar("field_roles", default={})
_ALIASES: ContextVar[Dict[str, List[str]]] = ContextVar("field_aliases", default={})


def use_layers(layers: Iterable) -> None:
    """Makes the request's field roles/aliases visible to the planner."""
    roles: Dict[str, str] = {}
    aliases: Dict[str, List[str]] = {}
    for layer in layers:
        for f in layer.fields:
            if getattr(f, "role", None):
                roles.setdefault(f.name.lower(), f.role)
            if getattr(f, "aliases", None):
                aliases.setdefault(f.name.lower(), list(f.aliases))
    _ROLES.set(roles)
    _ALIASES.set(aliases)


def role_of(field: str) -> Optional[str]:
    return _ROLES.get().get(field.lower())


def alias_words(field) -> Set[str]:
    """Words users may use for a field: its aliases (from metadata) and its
    name with abbreviations spelled out."""
    name = field if isinstance(field, str) else field.name
    own = getattr(field, "aliases", None) if not isinstance(field, str) else None
    out: Set[str] = set(name_words(name))
    for a in own or _ALIASES.get().get(name.lower(), []):
        out.update(w for w in re.split(r"[^a-z0-9]+", a.lower()) if w)
    return {w for w in out if len(w) >= 3}


def alias_phrases(field) -> List[str]:
    name = field if isinstance(field, str) else field.name
    own = getattr(field, "aliases", None) if not isinstance(field, str) else None
    return [a.lower() for a in (own or _ALIASES.get().get(name.lower(), []))]


class RoleRule:
    """A column-name pattern that defers to the profiled role: a role in
    `yes` matches, a role in `no` does not, anything else (or no metadata)
    falls back to the name pattern."""

    def __init__(self, pattern: "re.Pattern[str]", yes: Iterable[str], no: Iterable[str]):
        self.pattern = pattern
        self.yes = set(yes)
        self.no = set(no)

    def search(self, field: str):
        role = role_of(field)
        if role in self.yes:
            return True
        if role in self.no:
            return None
        return self.pattern.search(field)
