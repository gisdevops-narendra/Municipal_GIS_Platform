import { Component, OnInit, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NotificationService } from '../../../../core/services/notification.service';
import { MapService } from '../../services/map.service';
import { SavedMap, SavedMapsService } from '../../services/saved-maps.service';

/** Saved maps: the whole map setup (view, basemap, layers on, order,
 *  opacity) under a name — reopen it later, or share it with everyone in
 *  the municipality. Bookmarks above keep a place only. */
@Component({
  selector: 'app-saved-maps',
  standalone: true,
  imports: [FormsModule, DatePipe],
  template: `
    <div class="sm">
      <span class="sm__label">Saved maps</span>
      <p class="sm__hint">Saves the whole map: view, basemap, which layers are on, their order and opacity.</p>
      <div class="sm__add">
        <input type="text" class="sm__input" maxlength="80" placeholder="Map name, e.g. Ward 5 water supply" [(ngModel)]="newName" (keydown.enter)="save()" aria-label="Saved map name" />
        <button type="button" class="sm__btn sm__btn--primary" [disabled]="!newName.trim() || busy()" (click)="save()">
          <i class="pi pi-save" aria-hidden="true"></i> Save map
        </button>
      </div>
      <label class="sm__check"><input type="checkbox" [(ngModel)]="newShared" /> Share with everyone in the municipality</label>

      @for (m of maps(); track m.id) {
        <div class="sm__item">
          <button type="button" class="sm__open" (click)="open(m)" [title]="'Open ' + m.name">
            <b>{{ m.name }}</b>
            <span>
              {{ m.state.visible.length }} layer{{ m.state.visible.length === 1 ? '' : 's' }} on · {{ m.updatedAt | date: 'd MMM, HH:mm' }}
              @if (m.shared) { <em>{{ m.mine ? 'Shared' : 'Shared with you' }}</em> }
            </span>
          </button>
          @if (m.mine) {
            <button type="button" class="sm__icon" title="Replace with the current map" (click)="overwrite(m)"><i class="pi pi-refresh"></i></button>
            <button type="button" class="sm__icon" [title]="m.shared ? 'Stop sharing' : 'Share with everyone'" (click)="toggleShare(m)">
              <i class="pi" [class.pi-users]="m.shared" [class.pi-user]="!m.shared"></i>
            </button>
            <button type="button" class="sm__icon sm__icon--danger" title="Delete" (click)="remove(m)"><i class="pi pi-trash"></i></button>
          }
        </div>
      } @empty {
        <p class="sm__hint">No saved maps yet.</p>
      }
    </div>
  `,
  styles: `
    .sm { display: flex; flex-direction: column; gap: 8px; margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--color-line); }
    .sm__label { font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--color-ink-500); }
    .sm__hint { margin: 0; font-size: 12px; color: var(--color-ink-500); }
    .sm__add { display: flex; gap: 6px; }
    .sm__input { flex: 1; min-width: 0; height: 32px; padding: 0 8px; border: 1px solid var(--color-line); border-radius: 6px; background: var(--color-surface); color: var(--color-ink-900); font: inherit; font-size: 13px; }
    .sm__btn { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 10px; border: 1px solid var(--color-line); border-radius: 6px; background: var(--color-surface); font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap; }
    .sm__btn--primary { border-color: var(--color-primary-600); background: var(--color-primary-600); color: #fff; }
    .sm__btn:disabled { opacity: 0.5; cursor: default; }
    .sm__check { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--color-ink-500); }
    .sm__item { display: flex; align-items: stretch; gap: 2px; }
    .sm__open { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 6px 8px; border: 1px solid var(--color-line); border-radius: 6px; background: var(--color-surface); color: var(--color-ink-900); font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
    .sm__open:hover { border-color: var(--color-primary-600); }
    .sm__open b { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sm__open span { color: var(--color-ink-500); }
    .sm__open em { margin-left: 6px; font-style: normal; color: var(--color-primary-600); font-weight: 600; }
    .sm__icon { width: 28px; border: 0; border-radius: 4px; background: transparent; color: var(--color-ink-500); cursor: pointer; }
    .sm__icon:hover { background: var(--color-surface-alt); color: var(--color-ink-900); }
    .sm__icon--danger:hover { color: #dc2626; }
  `
})
export class SavedMapsComponent implements OnInit {
  private readonly api = inject(SavedMapsService);
  private readonly mapService = inject(MapService);
  private readonly notify = inject(NotificationService);

  readonly maps = signal<SavedMap[]>([]);
  readonly busy = signal(false);
  newName = '';
  newShared = false;

  ngOnInit(): void {
    this.refresh();
  }

  private refresh(): void {
    this.api.list().subscribe({ next: (list) => this.maps.set(list), error: () => this.maps.set([]) });
  }

  save(): void {
    const name = this.newName.trim();
    const state = this.mapService.getMapState();
    if (!name || !state) return;
    this.busy.set(true);
    this.api.create(name, state, this.newShared).subscribe({
      next: () => {
        this.busy.set(false);
        this.newName = '';
        this.newShared = false;
        this.refresh();
        this.notify.success(`"${name}" saved.`, 'Saved map');
      },
      error: (err) => {
        this.busy.set(false);
        this.notify.error(err?.error?.message ?? 'The map could not be saved.', 'Saved map');
      }
    });
  }

  open(m: SavedMap): void {
    this.mapService.applyMapState(m.state);
  }

  overwrite(m: SavedMap): void {
    const state = this.mapService.getMapState();
    if (!state) return;
    this.notify.confirm({
      header: `Replace "${m.name}"?`,
      message: 'The saved map is replaced with the map as it is now.',
      confirmLabel: 'Replace',
      accept: () =>
        this.api.update(m, { state }).subscribe({
          next: () => {
            this.refresh();
            this.notify.success(`"${m.name}" updated.`, 'Saved map');
          },
          error: () => this.notify.error('The map could not be updated.', 'Saved map')
        })
    });
  }

  toggleShare(m: SavedMap): void {
    this.api.update(m, { shared: !m.shared }).subscribe({
      next: () => this.refresh(),
      error: () => this.notify.error('Sharing could not be changed.', 'Saved map')
    });
  }

  remove(m: SavedMap): void {
    this.notify.confirm({
      header: `Delete "${m.name}"?`,
      message: 'Only the saved map is deleted — no layers or data.',
      confirmLabel: 'Delete',
      destructive: true,
      accept: () => this.api.remove(m.id).subscribe(() => this.refresh())
    });
  }
}
