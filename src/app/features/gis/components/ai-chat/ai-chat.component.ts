import {
  Component,
  EventEmitter,
  Input,
  Output,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { MessageModule } from 'primeng/message';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import { MapService } from '../../services/map.service';
import { GisAiService } from '../../services/gis-ai.service';
import { AttributeExternalFilter } from '../attribute-table/attribute-table.component';
import { ChatMessage, GisChatResponse } from '../../models/gis-ai.model';

const EXAMPLES = [
  'Show buildings within 50m of roads.',
  'Find vacant properties larger than 2000 sq ft in Ward 5.',
  'Find schools within 1 km of hospitals.',
];

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
  imports: [FormsModule, ButtonModule, InputTextModule, MessageModule],
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

  readonly examples = EXAMPLES;
  readonly messages = signal<ChatMessage[]>([]);
  readonly sending = signal(false);
  readonly serviceError = signal<string | null>(null);
  draft = '';

  readonly hasResult = computed(() =>
    this.messages().some((m) => m.response?.answerKind === 'gis_operation'),
  );

  private history(): { role: 'user' | 'assistant'; content: string }[] {
    return this.messages()
      .filter((m) => !m.pending && !m.error)
      .map((m) => ({ role: m.role, content: m.content }));
  }

  useExample(text: string): void {
    this.draft = text;
    this.send();
  }

  send(): void {
    const text = this.draft.trim();
    if (!text || this.sending()) return;

    this.serviceError.set(null);
    this.draft = '';
    const priorHistory = this.history();

    this.messages.update((list) => [
      ...list,
      { role: 'user', content: text },
      { role: 'assistant', content: '', pending: true },
    ]);
    this.sending.set(true);

    this.aiService.chat(text, priorHistory, this.activeLayerId).subscribe({
      next: (response) => {
        this.sending.set(false);
        this.applyAssistant({
          role: 'assistant',
          content: response.explanation,
          response,
        });
        this.applyResultToMap(response);
      },
      error: (err: HttpErrorResponse) => {
        this.sending.set(false);
        const message =
          err.error?.message ??
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

  private applyAssistant(message: ChatMessage): void {
    this.messages.update((list) => {
      const next = [...list];
      const idx = next.findIndex((m) => m.pending);
      if (idx >= 0) next[idx] = message;
      else next.push(message);
      return next;
    });
  }

  private applyResultToMap(response: GisChatResponse): void {
    const result = response.result;
    if (!result) return;

    if (result.matched === 0) {
      this.mapService.clearQueryHighlight();
      return;
    }

    this.mapService.setLayerVisibility(result.layerId, true);
    this.mapService.setQueryHighlight(result.geometries);
    if (result.geometries.length > 0) {
      this.mapService.zoomToGeometries(result.geometries);
    }
    if (result.cql) {
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

  reset(): void {
    this.messages.set([]);
    this.serviceError.set(null);
    this.clearResults();
  }

  operationSummary(response: GisChatResponse): string[] {
    const op = response.operation;
    if (!op) return [];
    const bits: string[] = [`target layer: ${op.target_layer}`];
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
    if (op.limit) bits.push(`limit ${op.limit}`);
    return bits;
  }
}
