import { TestBed } from '@angular/core/testing';
import { BookmarkService } from './bookmark.service';
import { BookmarkView } from '../models/bookmark.model';

const VIEW: BookmarkView = { center: [8280000, 2570000], zoom: 12, projection: 'EPSG:3857' };
const WS = 'test-ws';

describe('BookmarkService', () => {
  let service: BookmarkService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [BookmarkService] });
    service = TestBed.inject(BookmarkService);
  });

  afterEach(() => localStorage.clear());

  it('starts empty', () => {
    expect(service.list(WS)).toEqual([]);
  });

  it('adds a bookmark and persists it (newest first)', () => {
    expect(service.add(WS, 'Downtown', VIEW).ok).toBe(true);
    const two = service.add(WS, 'North Ward', { ...VIEW, zoom: 14 });
    expect(two.ok).toBe(true);

    const list = service.list(WS);
    expect(list.map((b) => b.name)).toEqual(['North Ward', 'Downtown']);
    expect(list[1].view).toEqual(VIEW);

    // survives a fresh service instance (localStorage)
    const fresh = TestBed.inject(BookmarkService);
    expect(fresh.list(WS).length).toBe(2);
  });

  it('rejects an empty name', () => {
    expect(service.add(WS, '   ', VIEW)).toEqual({ ok: false, reason: 'empty' });
  });

  it('rejects a duplicate name case-insensitively', () => {
    service.add(WS, 'Riverfront', VIEW);
    expect(service.add(WS, 'riverfront', VIEW)).toEqual({ ok: false, reason: 'duplicate' });
    expect(service.list(WS).length).toBe(1);
  });

  it('renames a bookmark, guarding against blanks and duplicates', () => {
    const a = service.add(WS, 'A', VIEW);
    service.add(WS, 'B', VIEW);
    const id = a.ok ? a.bookmark.id : '';

    expect(service.rename(WS, id, 'B')).toEqual({ ok: false, reason: 'duplicate' });
    expect(service.rename(WS, id, ' ')).toEqual({ ok: false, reason: 'empty' });
    expect(service.rename(WS, 'nope', 'X')).toEqual({ ok: false, reason: 'not-found' });

    expect(service.rename(WS, id, 'A2').ok).toBe(true);
    expect(service.list(WS).find((b) => b.id === id)?.name).toBe('A2');
  });

  it('removes a bookmark', () => {
    const a = service.add(WS, 'Keep', VIEW);
    const b = service.add(WS, 'Drop', VIEW);
    service.remove(WS, b.ok ? b.bookmark.id : '');
    expect(service.list(WS).map((x) => x.name)).toEqual(['Keep']);
  });

  it('scopes bookmarks per workspace', () => {
    service.add(WS, 'One', VIEW);
    expect(service.list('other-ws')).toEqual([]);
  });
});
