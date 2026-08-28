import { Injectable, computed, inject } from '@angular/core';
import { SettingsService } from './settings.service';

/**
 * Locale- and preference-aware formatting. Wraps `Intl.*` with the user's
 * Language + Date/Time + Number + Map-Units + Coordinate settings so a
 * single change in Settings updates every readout that goes through here
 * (GIS status bar, measure results, feature info, dated tables).
 */
@Injectable({ providedIn: 'root' })
export class FormatService {
  private readonly settings = inject(SettingsService);

  private readonly locale = computed(() => this.settings.locale().language || 'en-IN');

  // ---- dates & times -----------------------------------------------------

  date(value: Date | string | number | null | undefined): string {
    const d = this.toDate(value);
    if (!d) return '—';
    return new Intl.DateTimeFormat(
      this.forcedLocale() ?? this.locale(),
      this.dateOpts(),
    ).format(d);
  }

  time(value: Date | string | number | null | undefined): string {
    const d = this.toDate(value);
    if (!d) return '—';
    return new Intl.DateTimeFormat(this.locale(), this.timeOpts()).format(d);
  }

  dateTime(value: Date | string | number | null | undefined): string {
    const d = this.toDate(value);
    if (!d) return '—';
    return new Intl.DateTimeFormat(this.forcedLocale() ?? this.locale(), {
      ...this.dateOpts(),
      ...this.timeOpts(),
    }).format(d);
  }

  private dateOpts(): Intl.DateTimeFormatOptions {
    switch (this.settings.locale().dateFormat) {
      case 'iso':
        return { year: 'numeric', month: '2-digit', day: '2-digit' };
      case 'dmy':
      case 'mdy':
        return { year: 'numeric', month: '2-digit', day: '2-digit' };
      case 'long':
        return { year: 'numeric', month: 'long', day: 'numeric' };
      default:
        return { year: 'numeric', month: 'short', day: '2-digit' };
    }
  }

  private timeOpts(): Intl.DateTimeFormatOptions {
    return {
      hour: '2-digit',
      minute: '2-digit',
      hour12: this.settings.locale().timeFormat === '12h',
    };
  }

  /** dateFormat can force a fixed order regardless of locale. */
  private forcedLocale(): string | undefined {
    switch (this.settings.locale().dateFormat) {
      case 'iso':
        return 'en-CA'; // yyyy-mm-dd
      case 'dmy':
        return 'en-GB';
      case 'mdy':
        return 'en-US';
      default:
        return undefined;
    }
  }

  // ---- numbers ---------------------------------------------------------

  number(value: number | null | undefined, fractionDigits?: number): string {
    if (value == null || !Number.isFinite(value)) return '—';
    const opts: Intl.NumberFormatOptions =
      fractionDigits != null
        ? { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }
        : {};
    const mode = this.settings.locale().numberFormat;
    if (mode === 'plain') {
      return value.toFixed(fractionDigits ?? (Number.isInteger(value) ? 0 : 2));
    }
    const locale =
      mode === 'in' ? 'en-IN' : mode === 'eu' ? 'de-DE' : mode === 'us' ? 'en-US' : this.locale();
    return new Intl.NumberFormat(locale, opts).format(value);
  }

  // ---- coordinates ---------------------------------------------------

  /** `lon, lat` formatted per the Coordinate Format setting. */
  coordinate(lon: number, lat: number): string {
    if (this.settings.coordinateFormat() === 'dms') {
      return `${this.dms(lat, ['N', 'S'])}, ${this.dms(lon, ['E', 'W'])}`;
    }
    return `${lon.toFixed(5)}, ${lat.toFixed(5)}`;
  }

  private dms(value: number, hemis: [string, string]): string {
    const hemi = value >= 0 ? hemis[0] : hemis[1];
    const abs = Math.abs(value);
    const deg = Math.floor(abs);
    const minFloat = (abs - deg) * 60;
    const min = Math.floor(minFloat);
    const sec = ((minFloat - min) * 60).toFixed(1);
    return `${deg}°${String(min).padStart(2, '0')}'${sec.padStart(4, '0')}"${hemi}`;
  }

  // ---- map measurements (metric / imperial) -------------------------

  /** A length in metres → the user's units. */
  length(metres: number): string {
    if (this.settings.mapUnits() === 'imperial') {
      const feet = metres * 3.280839895;
      return feet >= 5280
        ? `${this.number(feet / 5280, 2)} mi`
        : `${this.number(feet, 0)} ft`;
    }
    return metres >= 1000
      ? `${this.number(metres / 1000, 2)} km`
      : `${this.number(metres, 0)} m`;
  }

  /** An area in square metres → the user's units. */
  area(squareMetres: number): string {
    if (this.settings.mapUnits() === 'imperial') {
      const acres = squareMetres / 4046.8564224;
      return acres >= 640
        ? `${this.number(acres / 640, 2)} mi²`
        : `${this.number(acres, 2)} ac`;
    }
    if (squareMetres >= 1_000_000) return `${this.number(squareMetres / 1_000_000, 2)} km²`;
    if (squareMetres >= 10_000) return `${this.number(squareMetres / 10_000, 2)} ha`;
    return `${this.number(squareMetres, 0)} m²`;
  }

  private toDate(value: Date | string | number | null | undefined): Date | null {
    if (value == null || value === '') return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
}
