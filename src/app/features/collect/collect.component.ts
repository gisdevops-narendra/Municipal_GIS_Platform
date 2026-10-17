import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { GisLayer } from '../../core/models/gis-layer.model';
import { GisLayersService } from '../../core/services/gis-layers.service';
import { ModuleAccessService } from '../../core/services/module-access.service';
import { NotificationService } from '../../core/services/notification.service';
import {
  ATTACHMENTS_MODULE_ID,
  EditSchema,
  FIELD_COLLECTION_MODULE_ID,
  VectorToolsService
} from '../gis/services/vector-tools.service';
import { QueuedSubmission, collectQueue } from './collect-queue';

const NUMERIC_TYPES = new Set(['integer', 'bigint', 'smallint', 'numeric', 'double precision', 'real']);

interface Fix {
  lon: number;
  lat: number;
  accuracy: number;
}

/**
 * Field Collection — a phone-first page for capturing features on site:
 * GPS position (or a walked line / boundary), the layer's attribute form
 * (with its field rules) and a photo. Without a connection, submissions
 * wait in an on-device queue and sync when the phone is back online.
 */
@Component({
  selector: 'app-collect',
  standalone: true,
  imports: [DatePipe, FormsModule, RouterLink],
  templateUrl: './collect.component.html',
  styleUrl: './collect.component.scss'
})
export class CollectComponent implements OnInit, OnDestroy {
  private readonly gisLayers = inject(GisLayersService);
  private readonly moduleAccess = inject(ModuleAccessService);
  private readonly vectorTools = inject(VectorToolsService);
  private readonly notify = inject(NotificationService);

  readonly allowed = signal<boolean | null>(null);
  readonly photosAllowed = signal(false);
  readonly layers = signal<GisLayer[]>([]);
  readonly layerId = signal<string | null>(null);
  readonly schema = signal<EditSchema | null>(null);
  readonly layer = computed(() => this.layers().find((l) => l.id === this.layerId()) ?? null);

  readonly fix = signal<Fix | null>(null);
  readonly vertices = signal<[number, number][]>([]);
  readonly locating = signal(false);
  values: Record<string, string> = {};
  readonly photo = signal<File | null>(null);
  readonly photoUrl = signal<string | null>(null);

  readonly online = signal(typeof navigator === 'undefined' ? true : navigator.onLine);
  readonly queue = signal<QueuedSubmission[]>([]);
  readonly busy = signal(false);
  readonly message = signal<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null);

  private readonly onOnline = () => {
    this.online.set(true);
    void this.sync();
  };
  private readonly onOffline = () => this.online.set(false);

  ngOnInit(): void {
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
    // Work queued in an earlier visit syncs as soon as the page opens
    // online — not only on a later offline→online transition.
    void this.refreshQueue().then(() => {
      if (this.online() && this.queue().length) void this.sync();
    });
    this.moduleAccess.getMyModuleIds().subscribe({
      next: ({ moduleIds }) => {
        const ids = new Set(moduleIds);
        this.allowed.set(ids.has(FIELD_COLLECTION_MODULE_ID));
        this.photosAllowed.set(ids.has(ATTACHMENTS_MODULE_ID));
        if (ids.has(FIELD_COLLECTION_MODULE_ID)) this.loadLayers();
      },
      error: () => this.allowed.set(false)
    });
  }

  ngOnDestroy(): void {
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('offline', this.onOffline);
    this.setPhoto(null);
  }

  private loadLayers(): void {
    this.gisLayers.list().subscribe({
      next: (layers) => {
        this.layers.set(layers.filter((l) => l.layerType === 'VECTOR' && l.geometryType));
        const last = this.readLastLayer();
        if (last && this.layers().some((l) => l.id === last)) this.selectLayer(last);
      },
      error: () => this.message.set({ kind: 'error', text: 'Could not load layers — check your connection.' })
    });
  }

  selectLayer(layerId: string): void {
    this.layerId.set(layerId || null);
    this.schema.set(null);
    this.values = {};
    this.vertices.set([]);
    this.message.set(null);
    if (!layerId) return;
    try {
      localStorage.setItem('collect.layer', layerId);
    } catch {
      /* storage unavailable */
    }
    const cached = this.readSchema(layerId);
    if (cached) this.useSchema(cached);
    this.vectorTools.editSchema(layerId).subscribe({
      next: (schema) => {
        this.useSchema(schema);
        try {
          localStorage.setItem(`collect.schema.${layerId}`, JSON.stringify(schema));
        } catch {
          /* storage unavailable */
        }
      },
      error: (err: HttpErrorResponse) => {
        if (!cached) this.message.set({ kind: 'error', text: this.errorText(err) });
      }
    });
  }

  private useSchema(schema: EditSchema): void {
    this.schema.set(schema);
    this.values = Object.fromEntries(schema.fields.map((f) => [f.name, this.values[f.name] ?? '']));
  }

  inputKind(field: { name: string; type: string }): 'list' | 'number' | 'date' | 'boolean' | 'text' {
    if (this.schema()?.rules[field.name]?.values?.length) return 'list';
    if (NUMERIC_TYPES.has(field.type)) return 'number';
    if (field.type === 'date') return 'date';
    if (field.type === 'boolean') return 'boolean';
    return 'text';
  }

  ruleValues(field: string): string[] {
    return this.schema()?.rules[field]?.values ?? [];
  }

  /** `installed_on` → "Installed on" — column names are not crew-friendly. */
  fieldLabel(name: string): string {
    const text = name.replace(/[_-]+/g, ' ').trim();
    return text ? text[0].toUpperCase() + text.slice(1) : name;
  }

  isRequired(field: string): boolean {
    return !!this.schema()?.rules[field]?.required;
  }

  // ----- GPS -----

  locate(addVertex = false): void {
    if (!('geolocation' in navigator)) {
      this.message.set({ kind: 'error', text: 'This device has no GPS / location support.' });
      return;
    }
    this.locating.set(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        this.locating.set(false);
        const fix = { lon: pos.coords.longitude, lat: pos.coords.latitude, accuracy: pos.coords.accuracy };
        this.fix.set(fix);
        if (addVertex) this.vertices.update((v) => [...v, [fix.lon, fix.lat]]);
      },
      (err) => {
        this.locating.set(false);
        this.message.set({ kind: 'error', text: `Location unavailable: ${err.message}` });
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
    );
  }

  undoVertex(): void {
    this.vertices.update((v) => v.slice(0, -1));
  }

  private geometry(): Record<string, unknown> | null {
    const type = this.schema()?.geometryType;
    if (type === 'POINT') {
      const fix = this.fix();
      return fix ? { type: 'Point', coordinates: [fix.lon, fix.lat] } : null;
    }
    const v = this.vertices();
    if (type === 'LINE') return v.length >= 2 ? { type: 'LineString', coordinates: v } : null;
    if (type === 'POLYGON') return v.length >= 3 ? { type: 'Polygon', coordinates: [[...v, v[0]]] } : null;
    return null;
  }

  // ----- photo -----

  onPhoto(input: HTMLInputElement): void {
    this.setPhoto(input.files?.[0] ?? null);
    input.value = '';
  }

  setPhoto(file: File | null): void {
    const url = this.photoUrl();
    if (url) URL.revokeObjectURL(url);
    this.photo.set(file);
    this.photoUrl.set(file ? URL.createObjectURL(file) : null);
  }

  // ----- submit / queue -----

  async submit(): Promise<void> {
    const layer = this.layer();
    const geometry = this.geometry();
    if (!layer || !this.schema()) return;
    if (!geometry) {
      this.message.set({
        kind: 'error',
        text: this.schema()!.geometryType === 'POINT' ? 'Get your GPS position first.' : 'Add more GPS points (walk the line / boundary).'
      });
      return;
    }
    const missing = this.schema()!.fields.filter((f) => this.isRequired(f.name) && !this.values[f.name]?.trim());
    if (missing.length) {
      this.message.set({ kind: 'error', text: `Required: ${missing.map((f) => this.fieldLabel(f.name)).join(', ')}.` });
      return;
    }
    const item: QueuedSubmission = {
      id: crypto.randomUUID(),
      layerId: layer.id,
      layerName: layer.name,
      geometry,
      properties: Object.fromEntries(Object.entries(this.values).filter(([, v]) => v !== '')),
      photo: this.photo(),
      photoName: this.photo()?.name ?? null,
      createdAt: new Date().toISOString()
    };
    this.busy.set(true);
    const result = this.online() ? await this.send(item) : 'offline';
    this.busy.set(false);
    if (result === 'ok') {
      this.message.set({ kind: 'ok', text: 'Saved to the layer.' });
    } else if (result === 'ok-no-photo') {
      this.message.set({ kind: 'error', text: 'Saved to the layer, but the photo could not be uploaded. Add it from the map later.' });
    } else if (result === 'offline' || result === 'signed-out') {
      await collectQueue.add(item);
      await this.refreshQueue();
      this.message.set({
        kind: 'info',
        text:
          result === 'signed-out'
            ? 'Your session has expired — saved on this device. Sign in again, then sync.'
            : 'No connection — saved on this device and will sync when you are back online.'
      });
    } else {
      this.message.set({ kind: 'error', text: result });
      return;
    }
    this.resetForm();
  }

  /** 'ok', 'offline' / 'signed-out' (keep queued) or an error text (rejected
   *  by the server). A crew offline for hours comes back with an expired
   *  session — that must not discard their queued work. */
  private async send(item: QueuedSubmission): Promise<'ok' | 'ok-no-photo' | 'offline' | 'signed-out' | string> {
    try {
      const feature = await firstValueFrom(this.vectorTools.createFeature(item.layerId, item.geometry, item.properties));
      if (item.photo && this.photosAllowed()) {
        // The feature is saved either way — never resend it (duplicate);
        // just tell the user the photo didn't make it.
        const photoSaved = await firstValueFrom(
          this.vectorTools.addAttachment(item.layerId, feature.id, item.photo, item.photoName ?? 'photo.jpg')
        ).then(() => true, () => false);
        if (!photoSaved) return 'ok-no-photo';
      }
      return 'ok';
    } catch (err) {
      const e = err as HttpErrorResponse;
      if (e.status === 401) return 'signed-out';
      return e.status === 0 || e.status === 408 || e.status === 429 || e.status >= 500 ? 'offline' : this.errorText(e);
    }
  }

  async sync(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    let sent = 0;
    let photosLost = 0;
    const failed: string[] = [];
    for (const item of await collectQueue.list()) {
      const result = await this.send(item);
      if (result === 'offline') break;
      if (result === 'signed-out') {
        this.busy.set(false);
        await this.refreshQueue();
        this.message.set({ kind: 'error', text: 'Your session has expired — sign in again, then sync. Queued submissions are kept.' });
        return;
      }
      await collectQueue.remove(item.id);
      if (result === 'ok' || result === 'ok-no-photo') sent++;
      else failed.push(`${item.layerName}: ${result}`);
      if (result === 'ok-no-photo') photosLost++;
    }
    this.busy.set(false);
    await this.refreshQueue();
    if (sent || failed.length) {
      this.message.set({
        kind: failed.length || photosLost ? 'error' : 'ok',
        text:
          `${sent} queued submission(s) synced.` +
          (photosLost ? ` ${photosLost} photo(s) could not be uploaded.` : '') +
          (failed.length ? ` Rejected: ${failed.join('; ')}` : '')
      });
    }
  }

  discard(item: QueuedSubmission): void {
    this.notify.confirm({
      header: 'Discard submission?',
      message: `This ${item.layerName} record${item.photo ? ' and its photo' : ''} has not been synced and will be lost.`,
      confirmLabel: 'Discard',
      destructive: true,
      accept: async () => {
        await collectQueue.remove(item.id);
        await this.refreshQueue();
      }
    });
  }

  private async refreshQueue(): Promise<void> {
    try {
      this.queue.set(await collectQueue.list());
    } catch {
      this.queue.set([]);
    }
  }

  private resetForm(): void {
    this.values = Object.fromEntries(Object.keys(this.values).map((k) => [k, '']));
    // A kept fix would silently place the next point at this one's spot.
    this.fix.set(null);
    this.vertices.set([]);
    this.setPhoto(null);
  }

  private readLastLayer(): string | null {
    try {
      return localStorage.getItem('collect.layer');
    } catch {
      return null;
    }
  }

  private readSchema(layerId: string): EditSchema | null {
    try {
      const raw = localStorage.getItem(`collect.schema.${layerId}`);
      return raw ? (JSON.parse(raw) as EditSchema) : null;
    } catch {
      return null;
    }
  }

  private errorText(err: HttpErrorResponse): string {
    const message = err.error?.message;
    return Array.isArray(message) ? message.join(' ') : (message ?? `Request failed (${err.status}).`);
  }
}
