import { Subscription } from 'rxjs';
import {
  Component,
  EventEmitter,
  Input,
  Output,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { MessageModule } from 'primeng/message';
import { DialogModule } from 'primeng/dialog';
import { CurrentUserService } from '../../../../core/services/current-user.service';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import { MapService } from '../../services/map.service';
import { GisAiService } from '../../services/gis-ai.service';
import { AttributeExternalFilter } from '../attribute-table/attribute-table.component';
import {
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
  imports: [DatePipe, FormsModule, ButtonModule, InputTextModule, MessageModule, DialogModule],
  templateUrl: './ai-chat.component.html',
  styleUrl: './ai-chat.component.scss',
})
export class AiChatComponent {
  private readonly mapService = inject(MapService);
  private readonly aiService = inject(GisAiService);

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

  /** Owner only: the question log (what failed, what was slow, 👎). */
  readonly isOwner = signal(false);
  readonly logVisible = signal(false);
  readonly logRows = signal<AiQueryLogEntry[]>([]);
  readonly logLoading = signal(false);
  readonly logProblemsOnly = signal(false);

  constructor() {
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

  openHistory(): void {
    this.historyVisible.set(true);
    this.aiService.conversations().subscribe({ next: (rows) => this.historyRows.set(rows), error: () => this.historyRows.set([]) });
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

  useExample(text: string): void {
    this.draft = text;
    this.send();
  }

  /** A clarification / "Did you mean" chip: re-ask with the filled-in
   *  question, or run the option's ready plan — no retyping. */
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

    this.chatSub = this.aiService.chat(text, priorHistory, this.activeLayerId, previousOperation, resolvedOperation, this.conversationId()).subscribe({
      next: (response) => {
        this.sending.set(false);
        if (response.conversationId) this.conversationId.set(response.conversationId);
        if (response.instructions) this.instructions.set(response.instructions);
        const wantsWording = !!response.answer && !!response.facts;
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
    const sub = this.aiService.narrate(question, facts).subscribe({
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
    if (shapes.length > 0) {
      this.mapService.setQueryHighlight(shapes);
      this.mapService.zoomToGeometries(shapes);
    } else {
      // Exact answers send no geometries: GeoServer draws the layer
      // filtered by the question's conditions (cql below) — just zoom.
      this.mapService.clearQueryHighlight();
      if (result?.bbox && result.matched > 0) this.mapService.zoomToBbox4326(result.bbox);
    }
    if (result?.cql) {
      this.queryRun.emit({
        layerId: result.layerId,
        cql: result.cql,
        label: `AI · ${result.layerName}`,
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
    return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
  }

  area(m2: number | null): string {
    if (m2 == null) return '—';
    return m2 < 10000 ? `${Math.round(m2)} m²` : `${(m2 / 10000).toFixed(2)} ha`;
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
    if (op.spatial_filter) {
      const s = op.spatial_filter;
      bits.push(
        `${s.relation}${s.distance_meters ? ` ${s.distance_meters} m` : ''} of ${s.reference_layer}`,
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
