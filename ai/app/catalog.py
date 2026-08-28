"""Read-only catalog inspection.

Resolves, for one municipality, which PostGIS tables back its GIS layers
and what real columns/values they contain. Used only to build the RAG
index — this module issues plain SELECTs against catalog views and, for
low-cardinality text columns, a bounded `SELECT DISTINCT` against the
layer's own table. It never runs anything derived from an LLM.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional

from . import config, db

# Canonical demo layers share these tables (see the Task 6 migration); they
# are filtered by gis_workspace_id rather than owning a per-layer table.
DEMO_TABLE_BY_CODE = {
    "MUNICIPAL_BOUNDARY": "gis_demo_municipal_boundary",
    "WARDS": "gis_demo_wards",
    "ROADS": "gis_demo_roads",
}

_NUMERIC = {"smallint", "integer", "bigint", "numeric", "decimal", "real",
            "double precision", "money"}
_INTEGERISH = {"smallint", "integer", "bigint"}
_TEXTISH = {"character varying", "character", "text", "name", "uuid", "citext"}
_INTERNAL_COLUMNS = {"ogc_fid", "fid", "gis_workspace_id", "id"}


@dataclass
class Column:
    name: str
    data_type: str
    kind: str                       # text|integer|number|date|boolean|id|geometry
    sample_values: List[str] = field(default_factory=list)


@dataclass
class LayerCatalog:
    layer_id: str
    code: str
    name: str
    description: Optional[str]
    geometry_type: Optional[str]
    table: str
    geom_column: str
    pk_column: str
    srid: int
    is_demo: bool
    workspace_id: str
    columns: List[Column] = field(default_factory=list)


def _classify(data_type: str) -> str:
    t = data_type.lower()
    if "geometry" in t or "geography" in t:
        return "geometry"
    if t in _INTEGERISH:
        return "integer"
    if t in _NUMERIC:
        return "number"
    if "bool" in t:
        return "boolean"
    if "date" in t or "time" in t:
        return "date"
    if t in _TEXTISH:
        return "text"
    return "text"


async def load_municipality_catalog(municipality_id: str) -> List[LayerCatalog]:
    async with db.acquire() as conn:
        workspace = await conn.fetchrow(
            "SELECT id, default_crs FROM gis_workspaces WHERE municipality_id = $1",
            municipality_id,
        )
        if workspace is None:
            return []
        ws_id = workspace["id"]
        try:
            ws_srid = int(str(workspace["default_crs"]).split(":")[-1])
        except (ValueError, AttributeError):
            ws_srid = 32643

        layer_rows = await conn.fetch(
            """
            SELECT id, code, name, description, geometry_type, postgis_table,
                   ownership_type
            FROM gis_layers
            WHERE gis_workspace_id = $1 AND status = 'ACTIVE'
            ORDER BY display_order
            """,
            ws_id,
        )

        out: List[LayerCatalog] = []
        for row in layer_rows:
            table = row["postgis_table"] or DEMO_TABLE_BY_CODE.get(row["code"])
            if not table:
                continue
            is_demo = row["postgis_table"] is None

            exists = await conn.fetchval(
                "SELECT to_regclass($1)", f"{config.DB_SCHEMA}.{table}"
            )
            if exists is None:
                continue

            col_rows = await conn.fetch(
                """
                SELECT column_name, data_type
                FROM information_schema.columns
                WHERE table_schema = $1 AND table_name = $2
                ORDER BY ordinal_position
                """,
                config.DB_SCHEMA,
                table,
            )

            geom_column = "geom"
            srid = ws_srid
            geom_meta = await conn.fetchrow(
                """
                SELECT f_geometry_column, srid, type
                FROM geometry_columns
                WHERE f_table_schema = $1 AND f_table_name = $2
                LIMIT 1
                """,
                config.DB_SCHEMA,
                table,
            )
            if geom_meta:
                geom_column = geom_meta["f_geometry_column"] or "geom"
                if geom_meta["srid"]:
                    srid = int(geom_meta["srid"])

            pk_column = "id" if is_demo else "ogc_fid"
            columns: List[Column] = []
            for c in col_rows:
                kind = _classify(c["data_type"])
                if c["column_name"] == geom_column or kind == "geometry":
                    continue
                col = Column(
                    name=c["column_name"],
                    data_type=c["data_type"],
                    kind="id"
                    if c["column_name"] in (pk_column, "gen_id")
                    else kind,
                )
                if kind == "text" and c["column_name"] not in _INTERNAL_COLUMNS:
                    col.sample_values = await _sample_distinct(
                        conn, table, c["column_name"], is_demo, ws_id
                    )
                columns.append(col)

            out.append(
                LayerCatalog(
                    layer_id=row["id"],
                    code=row["code"],
                    name=row["name"],
                    description=row["description"],
                    geometry_type=row["geometry_type"],
                    table=table,
                    geom_column=geom_column,
                    pk_column=pk_column,
                    srid=srid,
                    is_demo=is_demo,
                    workspace_id=ws_id,
                    columns=columns,
                )
            )
        return out


async def _sample_distinct(conn, table, column, is_demo, ws_id) -> List[str]:
    scope = "WHERE gis_workspace_id = $1" if is_demo else ""
    params = [ws_id] if is_demo else []
    limit = config.INDEX_DISTINCT_SAMPLE
    # identifiers come from information_schema (not user/LLM input); still
    # double-quote them defensively.
    q = (
        f'SELECT DISTINCT "{column}"::text AS v FROM "{table}" {scope} '
        f'{"AND" if scope else "WHERE"} "{column}" IS NOT NULL '
        f"ORDER BY 1 LIMIT {limit + 1}"
    )
    try:
        rows = await conn.fetch(q, *params)
    except Exception:
        return []
    vals = [r["v"] for r in rows if r["v"] is not None]
    if len(vals) > limit:
        return vals[:limit] + ["…(more)"]
    return vals
