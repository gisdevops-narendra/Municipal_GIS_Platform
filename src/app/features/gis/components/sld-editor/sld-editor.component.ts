import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnDestroy,
  Output,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { MenuModule } from 'primeng/menu';
import { TooltipModule } from 'primeng/tooltip';
import type { MenuItem } from 'primeng/api';
import { EditorView, basicSetup } from 'codemirror';
import { Compartment, EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { xml } from '@codemirror/lang-xml';
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint';
import { oneDark } from '@codemirror/theme-one-dark';
import { LayerStyleService } from '../../../../core/services/layer-style.service';
import { NotificationService } from '../../../../core/services/notification.service';
import type { StyleGeometry, StyleTargetRef } from '../../../../core/models/layer-style.model';
import { formatXml, sldTemplate, xmlProblem, type SldTemplateKind } from './sld-utils';

type Status = 'loading' | 'saved' | 'dirty' | 'checking' | 'valid' | 'invalid' | 'saving';

interface Finding {
  severity: 'error' | 'warning';
  message: string;
  line?: number;
}

/**
 * SLD (XML) styling for a published layer: edit the layer's current style
 * as SLD in a code editor, validate it (XML, platform rules, GeoServer's
 * parser, attribute names), preview it on the map without changing the
 * layer, and save it as the layer's style.
 */
@Component({
  selector: 'app-sld-editor',
  standalone: true,
  imports: [ButtonModule, MenuModule, TooltipModule],
  templateUrl: './sld-editor.component.html',
  styleUrl: './sld-editor.component.scss',
})
export class SldEditorComponent implements AfterViewInit, OnDestroy {
  @Input({ required: true }) target!: StyleTargetRef;
  @Input({ required: true }) geometry!: StyleGeometry;
  @Input() layerName = '';
  /** Saved as the layer's style. */
  @Output() saved = new EventEmitter<{ styleName: string }>();
  /** Draft style to render on the map, or null to end the preview. */
  @Output() preview = new EventEmitter<string | null>();

  @ViewChild('host', { static: true }) host!: ElementRef<HTMLDivElement>;

  private readonly api = inject(LayerStyleService);
  private readonly notify = inject(NotificationService);

  readonly status = signal<Status>('loading');
  readonly findings = signal<Finding[]>([]);
  /** The map is showing the draft; `stale` once edited since. */
  readonly previewing = signal<'off' | 'live' | 'stale'>('off');
  readonly cursor = signal('Ln 1, Col 1');

  readonly errorCount = computed(() => this.findings().filter((f) => f.severity === 'error').length);
  readonly warningCount = computed(() => this.findings().filter((f) => f.severity === 'warning').length);
  readonly busy = computed(() => ['loading', 'checking', 'saving'].includes(this.status()));

  readonly statusLabel = computed(() => {
    switch (this.status()) {
      case 'loading': return 'Loading…';
      case 'saved': return 'Saved';
      case 'dirty': return 'Unsaved changes';
      case 'checking': return 'Validating…';
      case 'valid': return 'Valid · not saved';
      case 'invalid': return 'Has errors';
      case 'saving': return 'Saving…';
    }
  });

  readonly templateItems: MenuItem[] = [
    { label: 'Single symbol', command: () => this.insertTemplate('single') },
    { label: 'Rule-based (by attribute)', command: () => this.insertTemplate('rules') },
    { label: 'Scale-dependent with labels', command: () => this.insertTemplate('labels') },
  ];

  private view?: EditorView;
  private readonly themeSlot = new Compartment();
  private themeObserver?: MutationObserver;
  /** Text as last saved / loaded — "dirty" compares against it. */
  private savedText = '';
  private loadedFromServer = false;

  ngAfterViewInit(): void {
    this.view = new EditorView({
      parent: this.host.nativeElement,
      state: EditorState.create({
        doc: '',
        extensions: [
          basicSetup,
          xml(),
          lintGutter(),
          linter((view) => this.lint(view), { delay: 400 }),
          this.themeSlot.of(this.isDark() ? oneDark : []),
          EditorView.lineWrapping,
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => (this.save(), true) },
            { key: 'Shift-Alt-f', preventDefault: true, run: () => (this.format(), true) },
          ]),
          EditorView.updateListener.of((update) => {
            if (update.selectionSet || update.docChanged) {
              const pos = update.state.selection.main.head;
              const line = update.state.doc.lineAt(pos);
              this.cursor.set(`Ln ${line.number}, Col ${pos - line.from + 1}`);
            }
            if (update.docChanged) this.onEdited();
          }),
        ],
      }),
    });
    this.themeObserver = new MutationObserver(() =>
      this.view?.dispatch({ effects: this.themeSlot.reconfigure(this.isDark() ? oneDark : []) }),
    );
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    this.loadCurrent();
  }

  ngOnDestroy(): void {
    this.themeObserver?.disconnect();
    if (this.previewing() !== 'off') {
      this.preview.emit(null);
      this.api.discardSldDraft(this.target).subscribe({ error: () => undefined });
    }
    this.view?.destroy();
  }

  // ---- loading ------------------------------------------------------

  /** Replace the editor content with the layer's current style. */
  loadCurrent(): void {
    if (this.isDirty() && this.loadedFromServer && !confirm('Discard your unsaved SLD changes?')) return;
    this.status.set('loading');
    this.api.currentSld(this.target).subscribe({
      next: (text) => {
        const formatted = formatXml(text) ?? text;
        this.setText(formatted, true);
        this.loadedFromServer = true;
        this.status.set('saved');
        this.findings.set([]);
      },
      error: () => {
        // No style to read (or GeoServer unreachable): start from a template.
        this.setText(sldTemplate('single', this.geometry, this.layerName), false);
        this.loadedFromServer = true;
        this.status.set('dirty');
      },
    });
  }

  /** Load an .sld file into the editor (not applied until saved). */
  onFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      this.notify.error('The SLD must be 5 MB or smaller.');
      return;
    }
    file.text().then((text) => {
      this.setText(formatXml(text) ?? text, false);
      this.notify.success(`Loaded ${file.name} — validate and save to apply it.`);
    });
  }

  insertTemplate(kind: SldTemplateKind): void {
    if (this.text().trim() && !confirm('Replace the editor content with this template?')) return;
    this.setText(sldTemplate(kind, this.geometry, this.layerName), false);
  }

  format(): void {
    const formatted = formatXml(this.text());
    if (formatted == null) {
      this.notify.error('Fix the XML errors before formatting.');
      return;
    }
    this.setText(formatted, false, true);
  }

  download(): void {
    const blob = new Blob([this.text()], { type: 'application/vnd.ogc.sld+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(this.layerName || 'layer').replace(/[^\w.-]+/g, '_')}.sld`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.text());
      this.notify.success('SLD copied to the clipboard.');
    } catch {
      this.notify.error('Could not copy — select the text and press Ctrl+C.');
    }
  }

  // ---- validate / preview / save --------------------------------------

  validate(): void {
    this.runCheck(() => {
      if (this.status() === 'valid') {
        this.notify.success(this.warningCount() ? 'SLD is valid, with warnings.' : 'SLD is valid.');
      }
    });
  }

  togglePreview(): void {
    if (this.previewing() === 'live') {
      this.endPreview();
      return;
    }
    this.runCheck((style) => {
      if (!style) return;
      this.preview.emit(style);
      this.previewing.set('live');
    });
  }

  endPreview(): void {
    this.preview.emit(null);
    this.previewing.set('off');
  }

  save(): void {
    if (this.busy()) return;
    const local = xmlProblem(this.text());
    if (local) {
      this.showFindings([{ severity: 'error', ...local }]);
      this.status.set('invalid');
      this.notify.error('Fix the XML errors before saving.');
      return;
    }
    this.runCheck((style) => {
      if (!style) {
        this.notify.error('Not saved — fix the errors listed below.');
        return;
      }
      this.status.set('saving');
      this.api.pasteSld(this.target, this.text()).subscribe({
        next: (result) => {
          this.savedText = this.text();
          this.status.set('saved');
          if (this.previewing() !== 'off') this.previewing.set('off');
          this.preview.emit(null);
          this.saved.emit(result);
          this.notify.success('SLD saved as the layer style.');
        },
        error: (error: HttpErrorResponse) => {
          this.status.set('invalid');
          this.showFindings([{ severity: 'error', message: this.msg(error) }]);
          this.notify.error(this.msg(error));
        },
      });
    });
  }

  /** Revert the editor to the last saved style. */
  revert(): void {
    if (!this.isDirty()) return;
    if (!confirm('Discard your changes and go back to the saved style?')) return;
    this.setText(this.savedText, true);
    this.status.set('saved');
    this.findings.set([]);
    if (this.previewing() !== 'off') this.endPreview();
  }

  jumpTo(finding: Finding): void {
    if (!this.view || !finding.line) return;
    const line = this.view.state.doc.line(Math.min(finding.line, this.view.state.doc.lines));
    this.view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
    this.view.focus();
  }

  isDirty(): boolean {
    return this.text() !== this.savedText;
  }

  // ---- internals ---------------------------------------------------------

  private runCheck(done: (previewStyle: string | null) => void): void {
    const text = this.text();
    const local = xmlProblem(text);
    if (local) {
      this.showFindings([{ severity: 'error', ...local }]);
      this.status.set('invalid');
      done(null);
      return;
    }
    this.status.set('checking');
    this.api.checkSld(this.target, text).subscribe({
      next: (result) => {
        this.showFindings([
          ...result.errors.map((message) => ({ severity: 'error' as const, message, line: lineIn(message) })),
          ...result.warnings.map((message) => ({ severity: 'warning' as const, message })),
        ]);
        this.status.set(result.valid ? (this.isDirty() ? 'valid' : 'saved') : 'invalid');
        done(result.valid ? result.previewStyle : null);
      },
      error: (error: HttpErrorResponse) => {
        this.status.set('invalid');
        this.showFindings([{ severity: 'error', message: this.msg(error) }]);
        done(null);
      },
    });
  }

  private lint(view: EditorView): Diagnostic[] {
    const problem = xmlProblem(view.state.doc.toString());
    if (!problem) return [];
    const line = view.state.doc.line(Math.min(problem.line ?? 1, view.state.doc.lines));
    return [{ from: line.from, to: line.to, severity: 'error', message: problem.message }];
  }

  private onEdited(): void {
    if (this.status() === 'loading') return;
    this.status.set(this.isDirty() ? 'dirty' : 'saved');
    if (this.previewing() === 'live') this.previewing.set('stale');
  }

  private showFindings(findings: Finding[]): void {
    this.findings.set(findings);
  }

  private text(): string {
    return this.view?.state.doc.toString() ?? '';
  }

  private setText(text: string, asSaved: boolean, keepSelection = false): void {
    if (!this.view) return;
    const head = keepSelection ? Math.min(this.view.state.selection.main.head, text.length) : 0;
    if (asSaved) this.savedText = text;
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
      selection: { anchor: head },
    });
  }

  private isDark(): boolean {
    return document.documentElement.getAttribute('data-theme') === 'dark';
  }

  private msg(error: HttpErrorResponse): string {
    const body = error.error as { message?: string } | string | null;
    if (typeof body === 'string') {
      try {
        return (JSON.parse(body) as { message?: string }).message ?? body;
      } catch {
        return body;
      }
    }
    return body?.message ?? error.message ?? 'Request failed.';
  }
}

/** "…line 12…" in a GeoServer parser message → 12. */
function lineIn(message: string): number | undefined {
  const m = /line(?:Number)?\s*[:=]?\s*(\d+)/i.exec(message);
  return m ? Number(m[1]) : undefined;
}
