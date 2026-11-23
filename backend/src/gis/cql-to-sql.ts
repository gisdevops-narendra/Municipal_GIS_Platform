import { BadRequestException } from '@nestjs/common';

/**
 * Translates the ECQL the app's own tools emit (Attribute Table search,
 * Query Builder, Selection / Buffer / Statistics tools, map identify) into a
 * parameterised PostGIS WHERE clause, so layer data is read straight from the
 * database instead of GeoServer's WFS.
 *
 * Deliberately strict: only the grammar below is accepted, every column must
 * exist in the layer's table, and every value is a bound parameter — nothing
 * from the filter text is ever pasted into SQL.
 *
 *   expr      := or
 *   or        := and ( OR and )*
 *   and       := not ( AND not )*
 *   not       := NOT not | primary
 *   primary   := '(' expr ')' | INCLUDE | EXCLUDE
 *              | IN '(' 'fid', … ')'                         feature ids
 *              | INTERSECTS|DISJOINT|CONTAINS|WITHIN|TOUCHES|CROSSES|OVERLAPS|EQUALS '(' attr ',' geom ')'
 *              | DWITHIN|BEYOND '(' attr ',' geom ',' number ',' units ')'
 *              | BBOX '(' attr ',' n ',' n ',' n ',' n [ ',' 'EPSG:code' ] ')'
 *              | value ( cmp value | [NOT] LIKE|ILIKE value | [NOT] IN '(' value, … ')'
 *                      | [NOT] BETWEEN value AND value | IS [NOT] NULL )
 *   geom      := [SRID=n;] WKT                                (EPSG:4326 when no SRID)
 */

export interface CqlColumn {
  /** information_schema data_type, e.g. "integer", "character varying". */
  type: string;
}

export interface CqlContext {
  columns: Map<string, CqlColumn>;
  /** Geometry column of the table and its SRID. */
  geometryColumn: string;
  srid: number;
  /** Integer primary key the feature ids (`layer.123`) map to. */
  fidColumn: string;
  /** Table alias the clause is written against. */
  alias: string;
}

export interface SqlFragment {
  sql: string;
  params: unknown[];
}

const MAX_CQL_LENGTH = 20000;
const MAX_IN_LIST = 5000;

type TokKind = 'num' | 'str' | 'qid' | 'word' | 'op' | 'punct' | 'wkt';
interface Tok {
  kind: TokKind;
  text: string;
  pos: number;
}

const SPATIAL: Record<string, string> = {
  INTERSECTS: 'ST_Intersects',
  DISJOINT: 'ST_Disjoint',
  CONTAINS: 'ST_Contains',
  WITHIN: 'ST_Within',
  TOUCHES: 'ST_Touches',
  CROSSES: 'ST_Crosses',
  OVERLAPS: 'ST_Overlaps',
  EQUALS: 'ST_Equals',
};
const WKT_TYPES = /^(POINT|MULTIPOINT|LINESTRING|MULTILINESTRING|POLYGON|MULTIPOLYGON|GEOMETRYCOLLECTION)$/i;
const UNIT_METRES: Record<string, number> = {
  meters: 1,
  metres: 1,
  meter: 1,
  m: 1,
  kilometers: 1000,
  kilometres: 1000,
  km: 1000,
  feet: 0.3048,
  ft: 0.3048,
  'statute miles': 1609.344,
  miles: 1609.344,
  mi: 1609.344,
  'nautical miles': 1852,
};
const NUMERIC_TYPE = /^(smallint|integer|bigint|numeric|real|double precision|decimal)$/;
const TEXT_TYPE = /^(character varying|character|text|name|citext)$/;

class Bad extends BadRequestException {
  constructor(message: string) {
    super(`Filter not understood: ${message}`);
  }
}

// ---------------------------------------------------------------- tokenizer

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const start = i;
    if (c === "'") {
      let s = '';
      i++;
      for (;;) {
        if (i >= src.length) throw new Bad('unterminated text value');
        if (src[i] === "'") {
          if (src[i + 1] === "'") {
            s += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        s += src[i++];
      }
      out.push({ kind: 'str', text: s, pos: start });
      continue;
    }
    if (c === '"') {
      const end = src.indexOf('"', i + 1);
      if (end < 0) throw new Bad('unterminated column name');
      out.push({ kind: 'qid', text: src.slice(i + 1, end), pos: start });
      i = end + 1;
      continue;
    }
    const num = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(src.slice(i));
    if (num && (c !== '-' || !out.length || ['op', 'punct', 'word'].includes(out[out.length - 1].kind))) {
      out.push({ kind: 'num', text: num[0], pos: start });
      i += num[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '<>' || two === '!=') {
      out.push({ kind: 'op', text: two === '!=' ? '<>' : two, pos: start });
      i += 2;
      continue;
    }
    if (c === '=' || c === '<' || c === '>') {
      out.push({ kind: 'op', text: c, pos: start });
      i++;
      continue;
    }
    if (c === '(' || c === ')' || c === ',' || c === ';') {
      out.push({ kind: 'punct', text: c, pos: start });
      i++;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_.:]*/.exec(src.slice(i));
    if (word) {
      // SRID=4326;POLYGON((…)) / bare POLYGON((…)): grab the whole geometry
      // literal as one token (validated later).
      if (/^SRID$/i.test(word[0]) || WKT_TYPES.test(word[0])) {
        const wkt = readWkt(src, i);
        if (wkt) {
          out.push({ kind: 'wkt', text: wkt.text, pos: start });
          i = wkt.end;
          continue;
        }
      }
      out.push({ kind: 'word', text: word[0], pos: start });
      i += word[0].length;
      continue;
    }
    throw new Bad(`unexpected "${c}"`);
  }
  return out;
}

/** Reads `[SRID=n;]TYPE ( … )` or `TYPE EMPTY` starting at i. */
function readWkt(src: string, i: number): { text: string; end: number } | null {
  let j = i;
  let prefix = '';
  const srid = /^SRID\s*=\s*(\d+)\s*;\s*/i.exec(src.slice(j));
  if (srid) {
    prefix = `SRID=${srid[1]};`;
    j += srid[0].length;
  }
  const type = /^([A-Za-z]+)\s*/.exec(src.slice(j));
  if (!type || !WKT_TYPES.test(type[1])) return null;
  j += type[0].length;
  const zm = /^(Z|M|ZM)\s*/i.exec(src.slice(j));
  if (zm) j += zm[0].length;
  if (/^EMPTY\b/i.test(src.slice(j))) {
    return { text: `${prefix}${type[1].toUpperCase()} EMPTY`, end: j + 5 };
  }
  if (src[j] !== '(') return null;
  let depth = 0;
  const begin = j;
  for (; j < src.length; j++) {
    const ch = src[j];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) {
        j++;
        break;
      }
    } else if (!/[-0-9.eE+,\s]/.test(ch) && !/[A-Za-z]/.test(ch)) {
      throw new Bad('invalid geometry');
    }
  }
  if (depth !== 0) throw new Bad('unbalanced geometry');
  const body = src.slice(begin, j);
  // Nested parts may name their own type (GEOMETRYCOLLECTION(POINT(…)…)).
  for (const w of body.match(/[A-Za-z]+/g) ?? []) {
    if (!WKT_TYPES.test(w) && !/^(e|E|Z|M|ZM|EMPTY)$/.test(w)) throw new Bad('invalid geometry');
  }
  return { text: `${prefix}${type[1].toUpperCase()}${body}`, end: j };
}

// ------------------------------------------------------------------- parser

type Operand =
  | { kind: 'col'; name: string; type: string }
  | { kind: 'num'; value: number }
  | { kind: 'str'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' };

class Parser {
  private i = 0;
  readonly params: unknown[] = [];

  constructor(
    private readonly toks: Tok[],
    private readonly ctx: CqlContext,
  ) {}

  parse(): string {
    const sql = this.or();
    if (this.i < this.toks.length) throw new Bad(`unexpected "${this.peek()!.text}"`);
    return sql;
  }

  // ---- helpers
  private peek(o = 0): Tok | undefined {
    return this.toks[this.i + o];
  }
  private isWord(w: string, o = 0): boolean {
    const t = this.peek(o);
    return !!t && t.kind === 'word' && t.text.toUpperCase() === w;
  }
  private take(): Tok {
    const t = this.toks[this.i++];
    if (!t) throw new Bad('the filter ends too early');
    return t;
  }
  private expect(text: string): void {
    const t = this.take();
    if (t.text.toUpperCase() !== text) throw new Bad(`expected "${text}" near "${t.text}"`);
  }
  private param(v: unknown): string {
    this.params.push(v);
    return `$${this.params.length}`;
  }
  private col(name: string): string {
    return `${this.ctx.alias}."${name.replace(/"/g, '""')}"`;
  }

  // ---- grammar
  private or(): string {
    const parts = [this.and()];
    while (this.isWord('OR')) {
      this.i++;
      parts.push(this.and());
    }
    return parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`;
  }

  private and(): string {
    const parts = [this.not()];
    while (this.isWord('AND')) {
      this.i++;
      parts.push(this.not());
    }
    return parts.length === 1 ? parts[0] : `(${parts.join(' AND ')})`;
  }

  private not(): string {
    if (this.isWord('NOT')) {
      this.i++;
      return `(NOT ${this.not()})`;
    }
    return this.primary();
  }

  private primary(): string {
    const t = this.peek();
    if (!t) throw new Bad('the filter ends too early');
    if (t.kind === 'punct' && t.text === '(') {
      this.i++;
      const inner = this.or();
      this.expect(')');
      return `(${inner})`;
    }
    if (t.kind === 'word') {
      const w = t.text.toUpperCase();
      if (w === 'INCLUDE') {
        this.i++;
        return 'TRUE';
      }
      if (w === 'EXCLUDE') {
        this.i++;
        return 'FALSE';
      }
      const next = this.peek(1);
      const call = next?.kind === 'punct' && next.text === '(';
      if (call && w === 'IN') return this.featureIds();
      if (call && SPATIAL[w]) return this.spatial(SPATIAL[w]);
      if (call && (w === 'DWITHIN' || w === 'BEYOND')) return this.distance(w === 'BEYOND');
      if (call && w === 'BBOX') return this.bbox();
    }
    return this.predicate();
  }

  /** IN ('roads.1', 'roads.7') — WFS feature ids. */
  private featureIds(): string {
    this.i++;
    this.expect('(');
    const ids: number[] = [];
    for (;;) {
      const t = this.take();
      if (t.kind !== 'str' && t.kind !== 'num') throw new Bad('feature ids must be quoted');
      const n = Number(String(t.text).split('.').pop());
      if (!Number.isSafeInteger(n)) throw new Bad(`"${t.text}" is not a feature id`);
      ids.push(n);
      if (ids.length > MAX_IN_LIST) throw new Bad('too many feature ids');
      const sep = this.take();
      if (sep.text === ')') break;
      if (sep.text !== ',') throw new Bad('expected "," between feature ids');
    }
    return `${this.col(this.ctx.fidColumn)} = ANY(${this.param(ids)}::bigint[])`;
  }

  private geomColumn(): string {
    const t = this.take();
    const name = t.kind === 'qid' || t.kind === 'word' ? t.text : '';
    if (name !== this.ctx.geometryColumn && name.toLowerCase() !== 'the_geom' && name.toLowerCase() !== 'geom') {
      throw new Bad(`"${t.text}" is not the geometry column`);
    }
    return this.col(this.ctx.geometryColumn);
  }

  private geometry(): string {
    const t = this.take();
    if (t.kind !== 'wkt') throw new Bad('expected a geometry (WKT)');
    const ewkt = /^SRID=/i.test(t.text) ? t.text : `SRID=4326;${t.text}`;
    return `ST_Transform(ST_GeomFromEWKT(${this.param(ewkt)}), ${this.ctx.srid})`;
  }

  private spatial(fn: string): string {
    this.i++;
    this.expect('(');
    const col = this.geomColumn();
    this.expect(',');
    const g = this.geometry();
    this.expect(')');
    return `${fn}(${col}, ${g})`;
  }

  /** DWITHIN(geom, POINT(…), 50, meters) — true ground distance. */
  private distance(beyond: boolean): string {
    this.i++;
    this.expect('(');
    const col = this.geomColumn();
    this.expect(',');
    const g = this.geometry();
    this.expect(',');
    const d = this.take();
    if (d.kind !== 'num') throw new Bad('expected a distance');
    this.expect(',');
    let unit = '';
    while (this.peek() && this.peek()!.text !== ')') unit += (unit ? ' ' : '') + this.take().text;
    this.expect(')');
    const factor = UNIT_METRES[unit.toLowerCase().replace(/^'|'$/g, '')];
    if (!factor) throw new Bad(`unknown distance unit "${unit}"`);
    const metres = this.param(Number(d.text) * factor);
    const exact = `ST_DWithin(ST_Transform(${col}, 4326)::geography, ST_Transform(${g}, 4326)::geography, ${metres})`;
    if (beyond) return `(NOT ${exact})`;
    // Bounding-box pre-check on the raw column first, so the spatial index
    // narrows the rows before the exact (geography) distance test.
    const box = `ST_Transform(ST_Envelope(ST_Buffer(ST_Transform(${g}, 4326)::geography, ${metres})::geometry), ${this.ctx.srid})`;
    return `(${col} && ${box} AND ${exact})`;
  }

  /** BBOX(geom, minx, miny, maxx, maxy[, 'EPSG:4326']). */
  private bbox(): string {
    this.i++;
    this.expect('(');
    const col = this.geomColumn();
    const n: number[] = [];
    for (let k = 0; k < 4; k++) {
      this.expect(',');
      const t = this.take();
      if (t.kind !== 'num') throw new Bad('BBOX needs four numbers');
      n.push(Number(t.text));
    }
    let srid = 4326;
    if (this.peek()?.text === ',') {
      this.i++;
      const crs = this.take();
      const m = /(\d+)$/.exec(crs.text);
      if (!m) throw new Bad('BBOX CRS must be EPSG:<code>');
      srid = Number(m[1]);
    }
    this.expect(')');
    const env = `ST_Transform(ST_MakeEnvelope(${n.map((v) => this.param(v)).join(', ')}, ${this.param(srid)}::int), ${this.ctx.srid})`;
    return `ST_Intersects(${col}, ${env})`;
  }

  private operand(): Operand {
    const t = this.take();
    if (t.kind === 'num') return { kind: 'num', value: Number(t.text) };
    if (t.kind === 'str') return { kind: 'str', value: t.text };
    if (t.kind === 'qid' || t.kind === 'word') {
      const u = t.text.toUpperCase();
      if (t.kind === 'word' && (u === 'TRUE' || u === 'FALSE')) return { kind: 'bool', value: u === 'TRUE' };
      if (t.kind === 'word' && u === 'NULL') return { kind: 'null' };
      const column = this.ctx.columns.get(t.text);
      if (!column) throw new Bad(`unknown column "${t.text}"`);
      return { kind: 'col', name: t.text, type: column.type };
    }
    throw new Bad(`unexpected "${t.text}"`);
  }

  /** SQL for an operand compared against `other` (casts literals to the
   *  column's type; numbers against text columns compare numerically). */
  private value(o: Operand, other: Operand | null, numericText: boolean): string {
    switch (o.kind) {
      case 'col': {
        const c = this.col(o.name);
        return numericText && TEXT_TYPE.test(o.type)
          ? `(CASE WHEN ${c} ~ '^\\s*-?[0-9]+(\\.[0-9]+)?\\s*$' THEN ${c}::numeric END)`
          : c;
      }
      case 'num':
        return `${this.param(o.value)}::numeric`;
      case 'bool':
        return `${this.param(o.value)}::boolean`;
      case 'null':
        return 'NULL';
      case 'str': {
        const type = other?.kind === 'col' && !TEXT_TYPE.test(other.type) && /^[a-z ]+$/.test(other.type) ? other.type : 'text';
        return `CAST(${this.param(o.value)} AS ${type})`;
      }
    }
  }

  private predicate(): string {
    const left = this.operand();
    let negate = false;
    if (this.isWord('NOT')) {
      negate = true;
      this.i++;
    }
    const t = this.peek();
    if (!t) throw new Bad('incomplete condition');
    const u = t.text.toUpperCase();
    let sql: string;

    if (t.kind === 'op') {
      if (negate) throw new Bad('NOT cannot be used here');
      this.i++;
      const right = this.operand();
      const numeric = left.kind === 'num' || right.kind === 'num';
      sql = `${this.value(left, right, numeric)} ${t.text} ${this.value(right, left, numeric)}`;
      return sql;
    }
    if (t.kind === 'word' && (u === 'LIKE' || u === 'ILIKE')) {
      this.i++;
      const right = this.operand();
      if (right.kind !== 'str') throw new Bad(`${u} needs a text pattern`);
      const l = left.kind === 'col' ? `${this.col(left.name)}::text` : this.value(left, null, false);
      sql = `${l} ${u} ${this.param(right.value)}`;
    } else if (t.kind === 'word' && u === 'IN') {
      this.i++;
      this.expect('(');
      const items: Operand[] = [];
      for (;;) {
        items.push(this.operand());
        if (items.length > MAX_IN_LIST) throw new Bad('too many values in IN');
        const sep = this.take();
        if (sep.text === ')') break;
        if (sep.text !== ',') throw new Bad('expected "," in IN list');
      }
      const numeric = items.some((x) => x.kind === 'num');
      sql = `${this.value(left, items[0], numeric)} IN (${items.map((x) => this.value(x, left, numeric)).join(', ')})`;
    } else if (t.kind === 'word' && u === 'BETWEEN') {
      this.i++;
      const lo = this.operand();
      if (!this.isWord('AND')) throw new Bad('BETWEEN needs AND');
      this.i++;
      const hi = this.operand();
      const numeric = lo.kind === 'num' || hi.kind === 'num';
      sql = `${this.value(left, lo, numeric)} BETWEEN ${this.value(lo, left, numeric)} AND ${this.value(hi, left, numeric)}`;
    } else if (t.kind === 'word' && u === 'IS') {
      if (negate) throw new Bad('NOT cannot be used here');
      this.i++;
      let not = false;
      if (this.isWord('NOT')) {
        not = true;
        this.i++;
      }
      this.expect('NULL');
      const v = left.kind === 'col' ? this.col(left.name) : this.value(left, null, false);
      return `${v} IS ${not ? 'NOT ' : ''}NULL`;
    } else {
      throw new Bad(`unexpected "${t.text}"`);
    }
    return negate ? `(NOT ${sql})` : sql;
  }
}

/** Parses `cql` into a WHERE clause; parameters are numbered from
 *  `firstParam` so the caller can put its own before them. */
export function cqlToSql(cql: string, ctx: CqlContext, firstParam = 1): SqlFragment {
  const text = cql.trim();
  if (!text) return { sql: 'TRUE', params: [] };
  if (text.length > MAX_CQL_LENGTH) throw new BadRequestException('The filter is too long.');
  const parser = new Parser(tokenize(text), ctx);
  const sql = parser.parse();
  if (firstParam === 1) return { sql, params: parser.params };
  // Renumber $n → $(n + firstParam - 1), highest first so $1 doesn't eat $10.
  const shifted = sql.replace(/\$(\d+)/g, (_, n: string) => `$${Number(n) + firstParam - 1}`);
  return { sql: shifted, params: parser.params };
}

export function isNumericType(type: string): boolean {
  return NUMERIC_TYPE.test(type);
}
