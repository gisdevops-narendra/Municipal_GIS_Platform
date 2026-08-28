import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { SiteHeaderComponent } from '../../shared/components/site-header/site-header.component';
import { SiteFooterComponent } from '../../shared/components/site-footer/site-footer.component';
import { SettingsService } from '../../core/services/settings.service';
import {
  DEFAULT_SECTION_ID,
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  SettingsSectionMeta,
} from '../../core/settings/settings-sections';

import { ProfileSectionComponent } from './sections/profile-section.component';
import { AppearanceSectionComponent } from './sections/appearance-section.component';
import { AccessibilitySectionComponent } from './sections/accessibility-section.component';
import { LanguageSectionComponent } from './sections/language-section.component';
import { DatetimeSectionComponent } from './sections/datetime-section.component';
import { NumbersSectionComponent } from './sections/numbers-section.component';
import { MapUnitsSectionComponent } from './sections/map-units-section.component';
import { CoordinatesSectionComponent } from './sections/coordinates-section.component';
import { BasemapSectionComponent } from './sections/basemap-section.component';
import { DefaultViewSectionComponent } from './sections/default-view-section.component';
import { LayerVisibilitySectionComponent } from './sections/layer-visibility-section.component';
import { MapPerformanceSectionComponent } from './sections/map-performance-section.component';
import { NotificationsSectionComponent } from './sections/notifications-section.component';
import { SessionSectionComponent } from './sections/session-section.component';
import { ShortcutsSectionComponent } from './sections/shortcuts-section.component';
import { SystemStatusSectionComponent } from './sections/system-status-section.component';
import { AboutSectionComponent } from './sections/about-section.component';
import { HelpSectionComponent } from './sections/help-section.component';
import { PrivacySectionComponent } from './sections/privacy-section.component';
import { ResetSectionComponent } from './sections/reset-section.component';

/**
 * Settings shell. Renders the grouped left-hand navigation from
 * `SETTINGS_SECTIONS` and switches the content pane on the active section
 * id, which is kept in the `?section=` query parameter so a section is
 * linkable and survives a reload. Adding a section is one entry in
 * `settings-sections.ts`, one `@case` below, and one component.
 */
@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [
    SiteHeaderComponent,
    SiteFooterComponent,
    ProfileSectionComponent,
    AppearanceSectionComponent,
    AccessibilitySectionComponent,
    LanguageSectionComponent,
    DatetimeSectionComponent,
    NumbersSectionComponent,
    MapUnitsSectionComponent,
    CoordinatesSectionComponent,
    BasemapSectionComponent,
    DefaultViewSectionComponent,
    LayerVisibilitySectionComponent,
    MapPerformanceSectionComponent,
    NotificationsSectionComponent,
    SessionSectionComponent,
    ShortcutsSectionComponent,
    SystemStatusSectionComponent,
    AboutSectionComponent,
    HelpSectionComponent,
    PrivacySectionComponent,
    ResetSectionComponent,
  ],
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss',
})
export class SettingsComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  readonly settings = inject(SettingsService);

  /** Sections bucketed by group, in registry order. */
  readonly nav = SETTINGS_GROUPS.map((group) => ({
    ...group,
    sections: SETTINGS_SECTIONS.filter((s) => s.group === group.id),
  }));

  private readonly requestedId = toSignal(
    this.route.queryParamMap.pipe(map((p) => p.get('section'))),
    { initialValue: this.route.snapshot.queryParamMap.get('section') },
  );

  readonly activeId = computed(() => {
    const id = this.requestedId();
    return SETTINGS_SECTIONS.some((s) => s.id === id) ? (id as string) : DEFAULT_SECTION_ID;
  });

  readonly activeSection = computed<SettingsSectionMeta>(
    () =>
      SETTINGS_SECTIONS.find((s) => s.id === this.activeId()) ??
      SETTINGS_SECTIONS.find((s) => s.id === DEFAULT_SECTION_ID)!,
  );

  select(id: string): void {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { section: id },
      queryParamsHandling: 'merge',
    });
  }
}
