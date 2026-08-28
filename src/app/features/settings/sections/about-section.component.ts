import { Component, inject, signal } from '@angular/core';
import { SystemService } from '../../../core/services/system.service';
import { SystemInfo } from '../../../core/models/system-status.model';
import { FormatService } from '../../../core/services/format.service';
import { environment } from '../../../../environments/environment';

/** Settings → About & Version. Frontend build info is compiled in
 *  (`environment.version`); backend + runtime info comes from
 *  `GET /api/system/info`. */
@Component({
  selector: 'app-about-section',
  standalone: true,
  imports: [],
  template: `
    <dl class="facts">
      <div><dt>Application</dt><dd>Municipal GIS Platform — Urban Local Body Edition</dd></div>
      <div><dt>Frontend version</dt><dd>{{ frontendVersion }}</dd></div>
      <div><dt>API version</dt><dd>{{ info()?.apiVersion ?? '—' }}</dd></div>
      <div><dt>Environment</dt><dd>{{ info()?.environment ?? (production ? 'production' : 'development') }}</dd></div>
      @if (info(); as i) {
        <div><dt>Node runtime</dt><dd>{{ i.node }}</dd></div>
        <div><dt>API started</dt><dd>{{ fmt.dateTime(i.startedAt) }}</dd></div>
      }
    </dl>

    <h3 class="subhead">Open-source components</h3>
    <p class="muted">
      Built with Angular, NestJS, PostgreSQL / PostGIS, GeoServer, OpenLayers and PrimeNG.
      Basemap tiles © OpenStreetMap contributors, CARTO and OpenTopoMap under their
      respective licences.
    </p>
  `,
  styles: [
    `
      .facts {
        margin: 0;
        display: grid;
        gap: 0;
      }
      .facts div {
        display: grid;
        grid-template-columns: 12rem 1fr;
        gap: 12px;
        padding: 11px 0;
        border-bottom: 1px solid var(--color-line);
      }
      dt {
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--color-ink-500);
      }
      dd {
        margin: 0;
        font-size: 13px;
        color: var(--color-ink-900);
      }
      .subhead {
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--color-ink-500);
        margin: 24px 0 6px;
      }
      .muted {
        font-size: 12.5px;
        line-height: 1.6;
        color: var(--color-ink-500);
        margin: 0;
      }
      @media (max-width: 560px) {
        .facts div {
          grid-template-columns: 1fr;
          gap: 2px;
        }
      }
    `,
  ],
})
export class AboutSectionComponent {
  private readonly system = inject(SystemService);
  readonly fmt = inject(FormatService);

  readonly frontendVersion = environment.version;
  readonly production = environment.production;
  readonly info = signal<SystemInfo | null>(null);

  constructor() {
    this.system.info().subscribe({
      next: (info) => this.info.set(info),
      error: () => undefined,
    });
  }
}
