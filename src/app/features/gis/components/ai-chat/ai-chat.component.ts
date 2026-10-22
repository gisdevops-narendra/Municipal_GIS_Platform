import { Subscription } from 'rxjs';
import {
  Component,
  ElementRef,
  EventEmitter,
  Input,
  Output,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { MessageModule } from 'primeng/message';
import { DialogModule } from 'primeng/dialog';
import { CurrentUserService } from '../../../../core/services/current-user.service';
import { NotificationService } from '../../../../core/services/notification.service';
import { SettingsService } from '../../../../core/services/settings.service';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import { MapService } from '../../services/map.service';
import { GisAiService } from '../../services/gis-ai.service';
import { AttributeExternalFilter } from '../attribute-table/attribute-table.component';
import {
  AiChatOptions,
  AiClarifyOption,
  AiConversationSummary,
  AiGisOperation,
  AiInstruction,
  AiQueryLogEntry,
  ChatMessage,
  GisChatResponse,
} from '../../models/gis-ai.model';

/** Shown only until the real-layer suggestions arrive. */
const EXAMPLES: string[] = [];

const nf = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });

/**
 * AI Assistant — natural-language GIS queries, living in the workspace left
 * dock alongside the Query Builder and Buffer/Overlay tools.
 *
 * A request goes: here -> `/api/gis/ai/chat` -> Python AI/RAG service
 * (produces a structured plan) -> NestJS validates the plan against this
 * municipality's real layers and compiles it to ONE read-only parameterised
 * PostGIS query. The matched features come back as an ECQL filter + GeoJSON,
 * which this component surfaces through the *existing* pipeline: the map
 * highlight overlay (`MapService`) and the Attribute Table's locked filter
 * (`queryRun` -> the workspace's `onQueryRun`). No new map/table code.
 */
@Component({
  selector: 'app-ai-chat',
  standalone: true,
  imports: [DatePipe, FormsModule, ButtonModule, MessageModule, DialogModule],
  templateUrl: './ai-chat.component.html',
  styleUrl: './ai-chat.component.scss',
})
export class AiChatComponent {
  private readonly mapService = inject(MapService);
  private readonly aiService = inject(GisAiService);
  private readonly notify = inject(NotificationService);
  /** AI Assistant settings (Settings → AI Assistant). */
  readonly prefs = inject(SettingsService).assistant;
  private readonly settings = inject(SettingsService);

  @Input() layers: GisLayer[] = [];
  @Input() activeLayerId: string | null = null;

  @Output() queryRun = new EventEmitter<AttributeExternalFilter>();
  @Output() queryCleared = new EventEmitter<void>();

  /** Generated from the user's real layers; the static list only shows
   *  until they arrive (or if the AI service is down). */
  readonly examples = signal<string[]>(EXAMPLES);
  readonly messages = signal<ChatMessage[]>([]);
  readonly sending = signal(false);
  readonly serviceError = signal<string | null>(null);
  draft = '';
  /** In-flight requests — cancelled by Reset so a slow answer can't land
   *  in (and change the map from) the new, empty conversation. */
  private chatSub?: Subscription;
  private readonly narrateSubs = new Set<Subscription>();

  /** Server-side chat: memory survives reloads; instructions live there. */
  readonly conversationId = signal<string | null>(null);
  readonly instructions = signal<AiInstruction[]>([]);
  readonly historyVisible = signal(false);
  readonly historyRows = signal<AiConversationSummary[]>([]);
  readonly historyLoading = signal(false);
  readonly historyQuery = signal('');
  private readonly filteredHistory = computed(() => {
    const q = this.historyQuery().trim().toLowerCase();
    return q ? this.historyRows().filter((r) => r.title.toLowerCase().includes(q)) : this.historyRows();
  });
  readonly pinnedChats = computed(() => this.filteredHistory().filter((r) => r.pinned));
  readonly recentChats = computed(() => this.filteredHistory().filter((r) => !r.pinned));

  /** Owner only: the question log (what failed, what was slow, 👎). */
  readonly isOwner = signal(false);
  readonly logVisible = signal(false);
  readonly logRows = signal<AiQueryLogEntry[]>([]);
  readonly logLoading = signal(false);
  readonly logProblemsOnly = signal(false);

  @ViewChild('thread') private thread?: ElementRef<HTMLElement>;
  @ViewChild('input') private input?: ElementRef<HTMLTextAreaElement>;

  /** "Save as layer" dialog: the answer being saved and the new name. */
  readonly saveTarget = signal<GisChatResponse | null>(null);
  saveName = '';
  readonly saving = signal(false);
  /** Answer index with a download / pin in flight. */
  readonly busyIndex = signal<number | null>(null);

  /** Answer whose text was just copied (shows a tick for a moment). */
  readonly copiedIndex = signal<number | null>(null);

  constructor() {
    // Keep the newest turn in view; shrink the composer back once sent.
    effect(() => {
      this.messages();
      queueMicrotask(() => {
        const el = this.thread?.nativeElement;
        if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
        if (!this.draft && this.input) this.autoGrow(this.input.nativeElement);
      });
    });
    // The panel is created when first opened: prime the model's prompt
    // cache now, while the user types (best effort, fire and forget).
    this.aiService.warm().subscribe({ error: () => undefined });
    this.aiService.suggestions().subscribe({
      next: (list) => list.length && this.examples.set(list.slice(0, 6)),
      error: () => undefined,
    });
    inject(CurrentUserService)
      .getMe()
      .subscribe({ next: (me) => this.isOwner.set(me.systemRole === 'MUNICIPALITY_OWNER'), error: () => undefined });
  }

  /** 👍/👎 — stored against the answer's question-log row. */
  rate(index: number, helpful: boolean): void {
    const msg = this.messages()[index];
    const logId = msg?.response?.logId;
    if (!logId || msg.feedback) return;
    const feedback: 1 | -1 = helpful ? 1 : -1;
    this.messages.update((list) => list.map((m, i) => (i === index ? { ...m, feedback } : m)));
    this.aiService.feedback(logId, helpful).subscribe({
      // Undo the optimistic mark so the user can try again.
      error: () => this.messages.update((list) => list.map((m, i) => (i === index ? { ...m, feedback: undefined } : m))),
    });
  }

  /** The chats sidebar slides over the thread; the button toggles it. */
  toggleHistory(): void {
    if (this.historyVisible()) {
      this.historyVisible.set(false);
      return;
    }
    this.historyVisible.set(true);
    this.historyQuery.set('');
    this.historyLoading.set(true);
    this.aiService.conversations().subscribe({
      next: (rows) => {
        this.historyRows.set(rows);
        this.historyLoading.set(false);
      },
      error: () => {
        this.historyRows.set([]);
        this.historyLoading.set(false);
      },
    });
  }

  /** Pinned chats stay at the top of the list. */
  togglePin(chat: AiConversationSummary, event: Event): void {
    event.stopPropagation();
    const pinned = !chat.pinned;
    const setPinned = (value: boolean) =>
      this.historyRows.update((rows) => rows.map((r) => (r.id === chat.id ? { ...r, pinned: value } : r)));
    setPinned(pinned);
    this.aiService.pinConversation(chat.id, pinned).subscribe({ error: () => setPinned(!pinned) });
  }

  /** Reopen a saved chat: its turns, memory and instructions. */
  openConversation(id: string): void {
    this.aiService.conversation(id).subscribe({
      next: (chat) => {
        this.reset();
        this.conversationId.set(chat.id);
        this.instructions.set(chat.instructions ?? []);
        this.messages.set(
          chat.turns.flatMap((t) => [
            { role: 'user' as const, content: t.question },
            {
              role: 'assistant' as const,
              content: t.response.explanation,
              response: { ...t.response, logId: t.logId },
              feedback: t.feedback ?? undefined,
            },
          ]),
        );
        this.historyVisible.set(false);
      },
    });
  }

  deleteConversation(id: string, event: Event): void {
    event.stopPropagation();
    this.aiService.deleteConversation(id).subscribe({
      next: () => {
        this.historyRows.update((rows) => rows.filter((r) => r.id !== id));
        if (this.conversationId() === id) this.reset();
      },
    });
  }

  removeInstruction(index: number): void {
    const id = this.conversationId();
    if (!id) return;
    this.aiService.removeInstruction(id, index).subscribe({ next: ({ instructions }) => this.instructions.set(instructions) });
  }

  openLog(): void {
    this.logVisible.set(true);
    this.loadLog();
  }

  toggleLogProblems(): void {
    this.logProblemsOnly.update((v) => !v);
    this.loadLog();
  }

  private loadLog(): void {
    this.logLoading.set(true);
    this.aiService.logs(this.logProblemsOnly()).subscribe({
      next: (rows) => {
        this.logRows.set(rows);
        this.logLoading.set(false);
      },
      error: () => {
        this.logRows.set([]);
        this.logLoading.set(false);
      },
    });
  }

  readonly hasResult = computed(() =>
    this.messages().some((m) => m.response?.answerKind === 'gis_operation'),
  );

  private history(): { role: 'user' | 'assistant'; content: string }[] {
    return this.messages()
      .filter((m) => !m.pending && !m.error)
      .map((m) => ({ role: m.role, content: m.response?.answer ?? m.content }));
  }

  /** The assistant's main text: the LLM wording once it arrives, else the
   *  computed answer, else the plan's explanation. */
  mainText(msg: ChatMessage): string {
    return msg.narration ?? msg.response?.answer ?? msg.content;
  }

  /** Enter sends; Shift+Enter is a new line. */
  onEnter(event: KeyboardEvent, el: HTMLTextAreaElement): void {
    if (event.shiftKey || event.isComposing) return;
    event.preventDefault();
    this.send();
    this.autoGrow(el);
  }

  /** The composer grows with its text, up to a few lines. */
  autoGrow(el: HTMLTextAreaElement): void {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }

  copy(index: number): void {
    const msg = this.messages()[index];
    if (!msg) return;
    navigator.clipboard?.writeText(this.mainText(msg)).then(() => {
      this.copiedIndex.set(index);
      setTimeout(() => this.copiedIndex.update((i) => (i === index ? null : i)), 1500);
    });
  }

  /** Follow-up chips show only under the newest answer. */
  readonly lastAnswerIndex = computed(() => {
    const list = this.messages();
    for (let i = list.length - 1; i >= 0; i--) if (list[i].role === 'assistant') return i;
    return -1;
  });

  useExample(text: string): void {
    this.draft = text;
    this.send();
  }

  /** A clarification / "Did you mean" chip: re-ask with the filled-in
   *  question, or run the option's ready plan — no retyping. */
  /** "field — e.g. a, b" → the choice and its sample values, shown on two lines. */
  optionParts(label: string): { title: string; detail: string | null } {
    const at = label.indexOf(' — ');
    return at < 0 ? { title: label, detail: null } : { title: label.slice(0, at), detail: label.slice(at + 3) };
  }

  choose(option: AiClarifyOption): void {
    if (this.sending()) return;
    if (option.operation) {
      this.send(option.label.replace(/^Did you mean\s*/i, '').replace(/\?$/, ''), option.operation);
    } else if (option.message) {
      this.draft = option.message;
      this.send();
    }
  }

  send(display?: string, resolvedOperation?: AiGisOperation): void {
    const text = (display ?? this.draft).trim();
    if (!text || this.sending()) return;

    this.serviceError.set(null);
    this.draft = '';
    const priorHistory = this.history();
    // The last operation that actually ran — a follow-up builds on it.
    const previousOperation = [...this.messages()]
      .reverse()
      .find((m) => m.response?.answerKind === 'gis_operation' && m.response.operation)?.response?.operation;

    this.messages.update((list) => [
      ...list,
      { role: 'user', content: text },
      { role: 'assistant', content: '', pending: true },
    ]);
    this.sending.set(true);

    this.chatSub = this.aiService
      .chat(text, priorHistory, this.activeLayerId, previousOperation, resolvedOperation, this.conversationId(), this.chatOptions())
      .subscribe({
      next: (response) => {
        this.sending.set(false);
        if (response.conversationId) this.conversationId.set(response.conversationId);
        if (response.instructions) this.instructions.set(response.instructions);
        const wantsWording = this.prefs().aiSummaries && !this.prefs().instantOnly && !!response.answer && !!response.facts;
        const index = this.applyAssistant({
          role: 'assistant',
          content: response.explanation,
          response,
          narrating: wantsWording,
        });
        this.applyResultToMap(response);
        if (wantsWording) this.narrate(index, text, response.facts!);
      },
      error: (err: HttpErrorResponse) => {
        this.sending.set(false);
        const raw = err.error?.message;
        const message =
          (Array.isArray(raw) ? raw.join('. ') : raw) ??
          (err.status === 0
            ? 'Could not reach the assistant.'
            : 'The assistant is unavailable right now.');
        this.serviceError.set(message);
        this.applyAssistant({
          role: 'assistant',
          content: message,
          error: true,
        });
      },
    });
  }

  /** Returns the index the message landed at. */
  private applyAssistant(message: ChatMessage): number {
    let index = -1;
    this.messages.update((list) => {
      const next = [...list];
      index = next.findIndex((m) => m.pending);
      if (index >= 0) next[index] = message;
      else index = next.push(message) - 1;
      return next;
    });
    return index;
  }

  /** Friendlier LLM wording of the computed answer — one more local-model
   *  call, so it fills in after the answer is already on screen. The
   *  backend drops any wording that strays from the numbers (null). */
  private narrate(index: number, question: string, facts: Record<string, unknown>): void {
    const settle = (narration?: string) =>
      this.messages.update((list) => {
        const msg = list[index];
        if (!msg?.narrating) return list;
        const next = [...list];
        next[index] = { ...msg, narrating: false, ...(narration && { narration }) };
        return next;
      });
    const language = this.prefs().language;
    const sub = this.aiService.narrate(question, facts, language === 'en' ? undefined : language).subscribe({
      next: ({ text }) => settle(text ?? undefined),
      error: () => settle(),
    });
    this.narrateSubs.add(sub);
    sub.add(() => this.narrateSubs.delete(sub));
  }

  private applyResultToMap(response: GisChatResponse): void {
    const result = response.result;
    const overlays = response.overlays ?? [];
    const features = result?.geometries ?? [];
    const shapes = [...overlays, ...features];

    if (result && result.matched > 0) {
      this.mapService.setLayerVisibility(result.layerId, true);
    }
    const { autoZoom, clearPrevious, openTable } = this.prefs();
    if (shapes.length > 0) {
      this.mapService.setQueryHighlight(shapes, !clearPrevious);
      if (autoZoom) this.mapService.zoomToGeometries(shapes);
    } else {
      // Exact answers send no geometries: GeoServer draws the layer
      // filtered by the question's conditions (cql below) — just zoom.
      if (clearPrevious) this.mapService.clearQueryHighlight();
      if (autoZoom && result?.bbox && result.matched > 0) this.mapService.zoomToBbox4326(result.bbox);
    }
    if (result?.cql) {
      this.queryRun.emit({
        layerId: result.layerId,
        cql: result.cql,
        label: `AI · ${result.layerName}`,
        openTable,
      });
    }
  }

  clearResults(): void {
    this.mapService.clearQueryHighlight();
    this.queryCleared.emit();
  }

  /** Stop: cancels the request — the backend and AI service then stop the
   *  model instead of finishing an answer nobody will read. */
  stop(): void {
    if (!this.sending()) return;
    this.chatSub?.unsubscribe();
    this.chatSub = undefined;
    this.sending.set(false);
    this.applyAssistant({ role: 'assistant', content: 'Stopped.', error: true });
  }

  /** New chat: a fresh server-side conversation (no memory, no rules). */
  reset(): void {
    this.conversationId.set(null);
    this.instructions.set([]);
    this.chatSub?.unsubscribe();
    this.chatSub = undefined;
    this.narrateSubs.forEach((sub) => sub.unsubscribe());
    this.narrateSubs.clear();
    this.sending.set(false);
    this.messages.set([]);
    this.serviceError.set(null);
    this.clearResults();
  }

  num(n: number | null | undefined): string {
    return n == null ? '—' : nf.format(n);
  }

  dist(m: number): string {
    const unit = this.prefs().distanceUnit;
    if (unit === 'm' || (unit === 'auto' && m < 1000)) return `${nf.format(Math.round(m))} m`;
    return `${(m / 1000).toFixed(2)} km`;
  }

  area(m2: number | null): string {
    if (m2 == null) return '—';
    switch (this.prefs().areaUnit) {
      case 'sqm':
        return `${nf.format(Math.round(m2))} m²`;
      case 'ha':
        return `${nf.format(m2 / 10000)} ha`;
      case 'acre':
        return `${nf.format(m2 / 4046.8564224)} acres`;
      default:
        return m2 < 10000 ? `${Math.round(m2)} m²` : `${(m2 / 10000).toFixed(2)} ha`;
    }
  }

  /** The assistant settings the backend applies to a question. */
  private chatOptions(): AiChatOptions {
    const p = this.prefs();
    const layerIds =
      p.layerScope === 'custom'
        ? p.layerIds
        : p.layerScope === 'visible'
          ? Object.entries(this.mapService.layerVisibility())
              .filter(([, on]) => on)
              .map(([id]) => id)
          : undefined;
    const numberMode = this.settings.locale().numberFormat;
    return {
      layerIds: layerIds?.length ? layerIds : undefined,
      instantOnly: p.instantOnly || undefined,
      saveHistory: p.saveHistory ? undefined : false,
      nearMeters: p.nearMeters > 0 ? p.nearMeters : undefined,
      format: {
        numberLocale:
          numberMode === 'in' ? 'en-IN' : numberMode === 'eu' ? 'de-DE' : numberMode === 'us' ? 'en-US' : this.settings.locale().language,
        distanceUnit: p.distanceUnit,
        areaUnit: p.areaUnit,
      },
    };
  }

  // ---- answer actions -------------------------------------------------------

  download(index: number, format: 'csv' | 'geojson'): void {
    const op = this.messages()[index]?.response?.operation;
    if (!op || this.busyIndex() !== null) return;
    this.busyIndex.set(index);
    this.aiService.export(op, format).subscribe({
      next: (res) => {
        this.busyIndex.set(null);
        const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? `ai-result.${format}`;
        const url = URL.createObjectURL(res.body!);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        URL.revokeObjectURL(url);
      },
      error: () => {
        this.busyIndex.set(null);
        this.notify.error('Could not download the result. Try again.');
      },
    });
  }

  openSave(response: GisChatResponse): void {
    this.saveName = `AI · ${response.result?.layerName ?? 'Result'}`.slice(0, 120);
    this.saveTarget.set(response);
  }

  saveAsLayer(): void {
    const op = this.saveTarget()?.operation;
    const name = this.saveName.trim();
    if (!op || name.length < 2 || this.saving()) return;
    this.saving.set(true);
    this.aiService.saveAsLayer(op, name).subscribe({
      next: () => {
        this.saving.set(false);
        this.saveTarget.set(null);
        this.notify.success(`Saved as the layer “${name}”. Reload the workspace to add it to the map.`, 'Layer saved', 'layers');
      },
      error: (err: HttpErrorResponse) => {
        this.saving.set(false);
        this.notify.error(err.error?.message ?? 'Could not save the layer.');
      },
    });
  }

  pinToDashboard(index: number): void {
    const msg = this.messages()[index];
    const question = this.messages()[index - 1]?.content ?? 'AI answer';
    const r = msg?.response;
    if (!r || this.busyIndex() !== null) return;
    const value = r.result
      ? `${this.num(r.result.matched)} ${r.result.matched === 1 ? 'feature' : 'features'}`
      : (r.answer ?? this.mainText(msg)).slice(0, 120);
    this.busyIndex.set(index);
    this.aiService
      .pinToDashboard({ title: question.slice(0, 200), value, detail: this.mainText(msg).slice(0, 1000), layerId: r.result?.layerId })
      .subscribe({
        next: () => {
          this.busyIndex.set(null);
          this.notify.success('Pinned to the Dashboard.');
        },
        error: () => {
          this.busyIndex.set(null);
          this.notify.error('Could not pin this answer.');
        },
      });
  }

  /** Bar width (%) of an aggregate row relative to the largest value. */
  barWidth(response: GisChatResponse, value: number | null): number {
    const max = Math.max(0, ...(response.aggregate?.rows ?? []).map((r) => r.value ?? 0));
    return max > 0 && value != null && value > 0 ? Math.max(2, (value / max) * 100) : 0;
  }

  metricTitle(response: GisChatResponse): string {
    const a = response.aggregate;
    if (!a) return '';
    const word = { count: 'Count', sum: 'Total', avg: 'Average', min: 'Minimum', max: 'Maximum' }[a.metric];
    return a.metricLabel ? `${word} ${a.metricLabel}` : word;
  }

  operationSummary(response: GisChatResponse): string[] {
    const op = response.operation;
    if (!op) return [];
    const bits: string[] = [`operation: ${op.kind ?? 'select'}`, `target layer: ${op.target_layer}`];
    for (const f of op.attribute_filters ?? []) {
      const v =
        f.values?.join(', ') ??
        (f.value2 != null ? `${f.value} … ${f.value2}` : `${f.value ?? ''}`);
      bits.push(`${f.field} ${f.op} ${v}`.trim());
    }
    for (const s of [op.spatial_filter, ...(op.spatial_filters ?? [])]) {
      if (!s) continue;
      const where = (s.reference_filters ?? []).map((f) => `${f.field} ${f.op} ${f.values?.join(', ') ?? f.value}`).join(' and ');
      bits.push(
        `${s.relation}${s.distance_meters ? ` ${s.distance_meters} m` : ''} of ${s.reference_layer}${where ? ` where ${where}` : ''}`,
      );
    }
    if (op.kind === 'aggregate') {
      bits.push(`${op.metric ?? 'count'}${op.metric_field ? ` of ${op.metric_field}` : ''}`);
      if (op.group_by) bits.push(`grouped by ${op.group_by}`);
      if (op.group_by_layer) bits.push(`grouped by ${op.group_by_layer}${op.group_by_layer_field ? `.${op.group_by_layer_field}` : ''}`);
    }
    if (op.kind === 'nearest' && op.reference_layer) {
      bits.push(`nearest ${op.count ?? 1} to ${op.reference_layer}`);
      for (const f of op.reference_filters ?? []) bits.push(`${op.reference_layer}: ${f.field} ${f.op} ${f.value ?? f.values?.join(', ') ?? ''}`);
    }
    if ((op.kind === 'buffer' || op.kind === 'service_area') && op.distance_meters) bits.push(`distance ${op.distance_meters} m`);
    if (op.kind === 'route' && op.to_layer) {
      bits.push(`to ${op.to_layer}`);
      for (const f of op.to_filters ?? []) bits.push(`${op.to_layer}: ${f.field} ${f.op} ${f.value ?? f.values?.join(', ') ?? ''}`);
    }
    if (op.network_layer) bits.push(`network: ${op.network_layer}`);
    if (op.limit) bits.push(`limit ${op.limit}`);
    return bits;
  }
}
