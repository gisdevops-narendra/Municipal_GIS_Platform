import { BadRequestException } from '@nestjs/common';

/**
 * Field Calculator expressions → SQL. A tiny, whitelisted language — never
 * raw SQL from the user:
 *
 *   "field name" or field_name     a column of the layer
 *   12.5, 'text'                   literals (strings become bind params)
 *   + - * / ( )   ||               arithmetic, text concatenation
 *   $area $length $perimeter       geodesic m² / m (from the geometry)
 *   $x $y $id                      lon / lat of a point on the feature, ogc_fid
 *   round(x[, digits]) abs ceil floor sqrt upper lower trim
 *   coalesce(a, b, …) concat(a, b, …) substr(text, start[, len]) nullif(a, b)
 *
 * Division is null-safe (`x / 0` → NULL).
 */

type Token =
  | { kind: 'num'; value: string }
  | { kind: 'str'; value: string }
  | { kind: 'ident'; value: string }
  | { kind: 'var'; value: string }
  | { kind: 'op'; value: string };

const GEOG = `ST_Transform(t.geom, 4326)::geography`;
const VARIABLES: Record<string, string> = {
  area: `ST_Area(${GEOG})`,
  length: `ST_Length(${GEOG})`,
  perimeter: `ST_Perimeter(${GEOG})`,
  x: `ST_X(ST_Transform(ST_PointOnSurface(t.geom), 4326))`,
  y: `ST_Y(ST_Transform(ST_PointOnSurface(t.geom), 4326))`,
  id: `t.ogc_fid`,
};

/** name → [min args, max args, SQL builder]. */
const FUNCTIONS: Record<string, [number, number, (args: string[]) => string]> = {
  round: [1, 2, (a) => `round((${a[0]})::numeric${a[1] ? `, (${a[1]})::int` : ''})`],
  abs: [1, 1, (a) => `abs(${a[0]})`],
  ceil: [1, 1, (a) => `ceil(${a[0]})`],
  floor: [1, 1, (a) => `floor(${a[0]})`],
  sqrt: [1, 1, (a) => `sqrt(${a[0]})`],
  upper: [1, 1, (a) => `upper((${a[0]})::text)`],
  lower: [1, 1, (a) => `lower((${a[0]})::text)`],
  trim: [1, 1, (a) => `trim((${a[0]})::text)`],
  coalesce: [2, 8, (a) => `coalesce(${a.join(', ')})`],
  concat: [2, 8, (a) => `concat(${a.join(', ')})`],
  substr: [2, 3, (a) => `substr((${a[0]})::text, (${a[1]})::int${a[2] ? `, (${a[2]})::int` : ''})`],
  nullif: [2, 2, (a) => `nullif(${a[0]}, ${a[1]})`],
};

export interface CompiledExpression {
  sql: string;
  params: string[];
}

export function compileFieldExpression(
  source: string,
  columns: string[],
  firstParam: number,
): CompiledExpression {
  const tokens = tokenize(source);
  const params: string[] = [];
  let pos = 0;

  const peek = () => tokens[pos];
  const fail = (message: string): never => {
    throw new BadRequestException(`Expression error: ${message}`);
  };
  const expectOp = (op: string) => {
    const t = tokens[pos++];
    if (!t || t.kind !== 'op' || t.value !== op) fail(`expected "${op}"`);
  };

  const expr = (): string => {
    let left = term();
    for (let t = peek(); t?.kind === 'op' && ['+', '-', '||'].includes(t.value); t = peek()) {
      pos++;
      const right = term();
      left = t.value === '||' ? `((${left})::text || (${right})::text)` : `(${left} ${t.value} ${right})`;
    }
    return left;
  };
  const term = (): string => {
    let left = factor();
    for (let t = peek(); t?.kind === 'op' && ['*', '/'].includes(t.value); t = peek()) {
      pos++;
      const right = factor();
      left = t.value === '/' ? `(${left} / NULLIF(${right}, 0))` : `(${left} * ${right})`;
    }
    return left;
  };
  const factor = (): string => {
    const t = tokens[pos++];
    if (!t) return fail('unexpected end');
    if (t.kind === 'op' && t.value === '-') return `(-${factor()})`;
    if (t.kind === 'op' && t.value === '(') {
      const inner = expr();
      expectOp(')');
      return `(${inner})`;
    }
    if (t.kind === 'num') return t.value;
    if (t.kind === 'str') {
      params.push(t.value);
      return `$${firstParam + params.length - 1}::text`;
    }
    if (t.kind === 'var') {
      const sql = VARIABLES[t.value.toLowerCase()];
      return sql ?? fail(`unknown variable $${t.value}`);
    }
    if (t.kind === 'ident') {
      const next = peek();
      if (next?.kind === 'op' && next.value === '(') {
        const fn = FUNCTIONS[t.value.toLowerCase()];
        if (!fn) return fail(`unknown function ${t.value}()`);
        pos++;
        const args: string[] = [];
        if (!(peek()?.kind === 'op' && peek()!.value === ')')) {
          args.push(expr());
          while (peek()?.kind === 'op' && peek()!.value === ',') {
            pos++;
            args.push(expr());
          }
        }
        expectOp(')');
        if (args.length < fn[0] || args.length > fn[1]) fail(`wrong number of arguments for ${t.value}()`);
        return fn[2](args);
      }
      const column = columns.find((c) => c === t.value) ?? columns.find((c) => c.toLowerCase() === t.value.toLowerCase());
      if (!column) return fail(`unknown field "${t.value}"`);
      return `t."${column.replace(/"/g, '""')}"`;
    }
    return fail(`unexpected "${t.value}"`);
  };

  if (!tokens.length) fail('empty expression');
  const sql = expr();
  if (pos < tokens.length) fail(`unexpected "${tokens[pos].value}"`);
  return { sql, params };
}

function tokenize(source: string): Token[] {
  if (source.length > 1000) throw new BadRequestException('Expression is too long.');
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) {
      i++;
    } else if (/[0-9.]/.test(c)) {
      const m = /^\d*\.?\d+(?:[eE][-+]?\d+)?/.exec(source.slice(i));
      if (!m) throw new BadRequestException(`Expression error: bad number at ${i + 1}`);
      tokens.push({ kind: 'num', value: m[0] });
      i += m[0].length;
    } else if (c === "'") {
      let value = '';
      i++;
      for (;;) {
        if (i >= source.length) throw new BadRequestException('Expression error: unclosed text');
        if (source[i] === "'" && source[i + 1] === "'") {
          value += "'";
          i += 2;
        } else if (source[i] === "'") {
          i++;
          break;
        } else value += source[i++];
      }
      tokens.push({ kind: 'str', value });
    } else if (c === '"') {
      const end = source.indexOf('"', i + 1);
      if (end < 0) throw new BadRequestException('Expression error: unclosed field name');
      tokens.push({ kind: 'ident', value: source.slice(i + 1, end) });
      i = end + 1;
    } else if (c === '$' || /[A-Za-z_]/.test(c)) {
      const m = /^\$?[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i))!;
      tokens.push(m[0].startsWith('$') ? { kind: 'var', value: m[0].slice(1) } : { kind: 'ident', value: m[0] });
      i += m[0].length;
    } else if (source.startsWith('||', i)) {
      tokens.push({ kind: 'op', value: '||' });
      i += 2;
    } else if ('+-*/(),'.includes(c)) {
      tokens.push({ kind: 'op', value: c });
      i++;
    } else {
      throw new BadRequestException(`Expression error: unexpected "${c}"`);
    }
  }
  return tokens;
}

/** Minimal RFC 4180 CSV parser (quoted fields, "" escapes, CRLF / LF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const body = text.replace(/^\uFEFF/, '');
  // Semicolon-separated files (Excel in many locales) — decided by the header.
  const header = body.split('\n', 1)[0];
  const delimiter = (header.match(/;/g)?.length ?? 0) > (header.match(/,/g)?.length ?? 0) ? ';' : ',';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && body[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v !== '')) rows.push(row);
  return rows;
}
