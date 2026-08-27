import { Component, Input, OnChanges, SimpleChanges, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { TooltipModule } from 'primeng/tooltip';
import { MapService } from '../../services/map.service';
import { BookmarkService } from '../../services/bookmark.service';
import { Bookmark, BookmarkError } from '../../models/bookmark.model';

/**
 * Spatial Bookmark Tool — save / list / zoom-to / rename / delete map
 * views, in the GIS left dock.
 *
 * The panel is thin: it reads the current view from `MapService`
 * (`getViewState` — centre / zoom / projection) and persists through
 * `BookmarkService` (localStorage per workspace, mirroring
 * `SavedQueryService`). Extending bookmarks later (folders, sharing,
 * import/export, "restore visible layers too") is a service + model change,
 * not a rewrite of this component.
 */
@Component({
  selector: 'app-bookmarks',
  standalone: true,
  imports: [FormsModule, ButtonModule, InputTextModule, TooltipModule],
  templateUrl: './bookmarks.component.html',
  styleUrl: './bookmarks.component.scss'
})
export class BookmarksComponent implements OnChanges {
  private readonly service = inject(BookmarkService);
  private readonly mapService = inject(MapService);

  @Input() workspaceKey = '';

  readonly bookmarks = signal<Bookmark[]>([]);
  newName = '';
  readonly addError = signal<string | null>(null);

  readonly renamingId = signal<string | null>(null);
  renameName = '';
  readonly renameError = signal<string | null>(null);

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['workspaceKey']) {
      this.refresh();
    }
  }

  add(): void {
    this.addError.set(null);
    const view = this.mapService.getViewState();
    if (!view) {
      this.addError.set('The map is not ready yet.');
      return;
    }
    const result = this.service.add(this.workspaceKey, this.newName, view);
    if (!result.ok) {
      this.addError.set(this.message(result.reason));
      return;
    }
    this.newName = '';
    this.refresh();
  }

  zoomTo(bookmark: Bookmark): void {
    this.mapService.applyViewState(bookmark.view);
  }

  startRename(bookmark: Bookmark): void {
    this.renamingId.set(bookmark.id);
    this.renameName = bookmark.name;
    this.renameError.set(null);
  }

  confirmRename(): void {
    const id = this.renamingId();
    if (!id) return;
    const result = this.service.rename(this.workspaceKey, id, this.renameName);
    if (!result.ok) {
      this.renameError.set(this.message(result.reason));
      return;
    }
    this.renamingId.set(null);
    this.refresh();
  }

  cancelRename(): void {
    this.renamingId.set(null);
    this.renameError.set(null);
  }

  remove(bookmark: Bookmark): void {
    this.service.remove(this.workspaceKey, bookmark.id);
    if (this.renamingId() === bookmark.id) {
      this.renamingId.set(null);
    }
    this.refresh();
  }

  clearAddError(): void {
    if (this.addError()) {
      this.addError.set(null);
    }
  }

  private refresh(): void {
    this.bookmarks.set(this.service.list(this.workspaceKey));
  }

  private message(reason: BookmarkError): string {
    switch (reason) {
      case 'empty':
        return 'Enter a name for the bookmark.';
      case 'duplicate':
        return 'A bookmark with that name already exists.';
      default:
        return 'Bookmark not found.';
    }
  }
}
