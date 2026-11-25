import { AfterViewInit, Component, ElementRef, OnDestroy, effect, input, output, viewChild } from '@angular/core';
import type { Completion, CompletionContext } from '@codemirror/autocomplete';
import { PostgreSQL, sql } from '@codemirror/lang-sql';
import { lintGutter, setDiagnostics } from '@codemirror/lint';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { keymap, placeholder } from '@codemirror/view';
import { EditorView, basicSetup } from 'codemirror';
import type { SqlError, SqlTable } from './sql-console.store';

/** Common PostGIS functions offered by autocomplete (with a short hint). */
const POSTGIS: [string, string][] = [
  ['ST_Area', 'area of a polygon'], ['ST_Length', 'length of a line'], ['ST_Perimeter', 'perimeter of a polygon'],
  ['ST_Distance', 'distance between shapes'], ['ST_DWithin', 'within a distance (uses index)'],
  ['ST_Intersects', 'shapes touch or overlap (uses index)'], ['ST_Contains', 'A contains B'], ['ST_Within', 'A inside B'],
  ['ST_Touches', 'share a boundary'], ['ST_Overlaps', 'partly overlap'], ['ST_Crosses', 'cross each other'], ['ST_Disjoint', 'no contact'],
  ['ST_Buffer', 'buffer around a shape'], ['ST_Intersection', 'shared part of two shapes'], ['ST_Union', 'merge shapes (aggregate)'],
  ['ST_Difference', 'A minus B'], ['ST_SymDifference', 'parts not shared'], ['ST_Centroid', 'centre point'],
  ['ST_PointOnSurface', 'point guaranteed inside'], ['ST_Envelope', 'bounding box'], ['ST_ConvexHull', 'convex hull'],
  ['ST_Simplify', 'simplify geometry'], ['ST_Transform', 'reproject to an SRID'], ['ST_SetSRID', 'set the SRID'], ['ST_SRID', 'the SRID'],
  ['ST_X', 'X of a point'], ['ST_Y', 'Y of a point'], ['ST_MakePoint', 'point from X, Y'], ['ST_AsText', 'geometry as WKT'],
  ['ST_AsGeoJSON', 'geometry as GeoJSON'], ['ST_GeometryType', 'geometry type name'], ['ST_NPoints', 'number of vertices'],
  ['ST_IsValid', 'valid geometry?'], ['ST_MakeValid', 'repair geometry'], ['ST_Collect', 'collect shapes (aggregate)'],
  ['ST_ClusterDBSCAN', 'density clusters (window)'], ['ST_ClusterKMeans', 'k-means clusters (window)'],
  ['ST_Extent', 'bounding box (aggregate)'], ['ST_LineMerge', 'merge line parts'], ['ST_StartPoint', 'first point of a line'],
  ['ST_EndPoint', 'last point of a line'], ['ST_ClosestPoint', 'nearest point on A to B'], ['ST_ShortestLine', 'shortest line between'],
  ['ST_Azimuth', 'bearing between points'], ['ST_Segmentize', 'add vertices'], ['ST_Subdivide', 'split big shapes'],
  ['ST_VoronoiPolygons', 'Voronoi polygons'], ['ST_DelaunayTriangles', 'triangulation'], ['ST_HexagonGrid', 'hexagon grid'],
  ['ST_SquareGrid', 'square grid'], ['ST_Force2D', 'drop Z / M'], ['ST_Multi', 'make multi-geometry'], ['ST_Dump', 'split multi-parts']
];

/** CodeMirror 6 SQL editor: PostgreSQL highlighting, completion of layer
 *  aliases / fields / PostGIS functions, and an error underline. */
@Component({
  selector: 'app-sql-editor',
  standalone: true,
  template: `<div #host class="sqe"></div>`,
  styles: `
    :host { display: block; min-height: 0; }
    .sqe { height: 100%; }
    .sqe ::ng-deep .cm-editor { height: 100%; border: 1px solid var(--color-line); border-radius: 10px; overflow: hidden;
      background: var(--color-surface); font-size: 12.5px; }
    .sqe ::ng-deep .cm-editor.cm-focused { outline: none; border-color: var(--color-primary-600);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-primary-600) 18%, transparent); }
    .sqe ::ng-deep .cm-scroller { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; line-height: 1.6; }
    .sqe ::ng-deep .cm-gutters { border-right: 1px solid var(--color-line); background: color-mix(in srgb, var(--color-ink-900) 3%, var(--color-surface));
      color: var(--color-ink-500); }
    .sqe ::ng-deep .cm-activeLineGutter { background: color-mix(in srgb, var(--color-primary-600) 10%, transparent); }
    .sqe ::ng-deep .cm-placeholder { color: var(--color-ink-500); }
    .sqe ::ng-deep .cm-tooltip-autocomplete { border-radius: 8px; overflow: hidden; }
    .sqe ::ng-deep .cm-completionDetail { margin-left: 10px; font-style: normal; opacity: .65; font-size: 11px; }
  `
})
export class SqlEditorComponent implements AfterViewInit, OnDestroy {
  readonly value = input('');
  readonly tables = input<SqlTable[]>([]);
  readonly error = input<SqlError | null>(null);
  readonly valueChange = output<string>();
  readonly run = output<void>();
  readonly formatRequest = output<void>();

  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private view: EditorView | null = null;
  private readonly langSlot = new Compartment();
  private readonly themeSlot = new Compartment();
  private themeObserver?: MutationObserver;

  constructor() {
    // Outside changes (tab switch, example, format) replace the text.
    effect(() => {
      const v = this.value();
      const view = this.view;
      if (view && v !== view.state.doc.toString()) {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } });
      }
    });
    effect(() => {
      const t = this.tables();
      this.view?.dispatch({ effects: this.langSlot.reconfigure(this.language(t)) });
    });
    effect(() => {
      const err = this.error();
      const view = this.view;
      if (!view) return;
      const len = view.state.doc.length;
      if (!err || err.position === undefined || err.position === null) {
        view.dispatch(setDiagnostics(view.state, []));
        return;
      }
      const from = Math.min(Math.max(err.position, 0), len);
      const word = /^[\w.]+/.exec(view.state.doc.sliceString(from, Math.min(len, from + 80)))?.[0].length ?? 1;
      view.dispatch(setDiagnostics(view.state, [{ from, to: Math.min(len, from + Math.max(word, 1)), severity: 'error', message: err.message }]));
    });
  }

  ngAfterViewInit(): void {
    this.view = new EditorView({
      parent: this.host().nativeElement,
      state: EditorState.create({
        doc: this.value(),
        extensions: [
          basicSetup,
          this.langSlot.of(this.language(this.tables())),
          lintGutter(),
          placeholder('SELECT … FROM layer_name'),
          EditorView.lineWrapping,
          this.themeSlot.of(this.isDark() ? oneDark : []),
          Prec.highest(
            keymap.of([
              { key: 'Mod-Enter', preventDefault: true, run: () => (this.run.emit(), true) },
              { key: 'Shift-Alt-f', preventDefault: true, run: () => (this.formatRequest.emit(), true) }
            ])
          ),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) this.valueChange.emit(u.state.doc.toString());
          })
        ]
      })
    });
    this.themeObserver = new MutationObserver(() =>
      this.view?.dispatch({ effects: this.themeSlot.reconfigure(this.isDark() ? oneDark : []) })
    );
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  ngOnDestroy(): void {
    this.themeObserver?.disconnect();
    this.view?.destroy();
  }

  /** Inserts text at the caret (layer / field picked in the browser). */
  insert(text: string): void {
    const view = this.view;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
    view.focus();
  }

  focus(): void {
    this.view?.focus();
  }

  private language(tables: SqlTable[]) {
    const schema: Record<string, Completion[]> = {};
    for (const t of tables) {
      schema[t.alias] = t.fields.map((f) => ({ label: f.name, type: 'property', detail: f.type }));
    }
    const lang = sql({
      dialect: PostgreSQL,
      upperCaseKeywords: true,
      schema,
      tables: tables.map((t) => ({ label: t.alias, type: 'type', detail: t.name, boost: 10 }))
    });
    const fnSource = (ctx: CompletionContext) => {
      const word = ctx.matchBefore(/[Ss][Tt]_\w*/);
      if (!word || (word.from === word.to && !ctx.explicit)) return null;
      return {
        from: word.from,
        options: POSTGIS.map(([label, detail]) => ({ label, detail, type: 'function', apply: `${label}(` })),
        validFor: /^\w*$/
      };
    };
    return [lang, lang.language.data.of({ autocomplete: fnSource })];
  }

  private isDark(): boolean {
    return document.documentElement.getAttribute('data-theme') === 'dark';
  }
}
