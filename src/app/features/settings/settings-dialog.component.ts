import { Component, ElementRef, HostListener, computed, inject, viewChild, effect } from '@angular/core';
import { SettingsDialogService } from '../../core/services/settings-dialog.service';
import { SETTINGS_SECTIONS, SETTINGS_TABS, SettingsSectionMeta } from '../../core/settings/settings-sections';

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
import { AssistantSectionComponent } from './sections/assistant-section.component';
import { SystemStatusSectionComponent } from './sections/system-status-section.component';
import { AboutSectionComponent } from './sections/about-section.component';
import { HelpSectionComponent } from './sections/help-section.component';
import { PrivacySectionComponent } from './sections/privacy-section.component';
import { ResetSectionComponent } from './sections/reset-section.component';
import { DeleteAccountSectionComponent } from './sections/delete-account-section.component';

/**
 * Settings window — a dialog over the current page (Claude / ChatGPT style):
 * a short tab list on the left, the tab's settings as compact rows on the
 * right. Each tab stacks one or more of the existing section components
 * (see SETTINGS_TABS), so no setting was dropped. Changes save as you go.
 */
@Component({
  selector: 'app-settings-dialog',
  standalone: true,
  imports: [
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
    AssistantSectionComponent,
    SystemStatusSectionComponent,
    AboutSectionComponent,
    HelpSectionComponent,
    PrivacySectionComponent,
    ResetSectionComponent,
    DeleteAccountSectionComponent,
  ],
  templateUrl: './settings-dialog.component.html',
  styleUrl: './settings-dialog.component.scss',
})
export class SettingsDialogComponent {
  readonly dialog = inject(SettingsDialogService);
  readonly tabs = SETTINGS_TABS;

  readonly activeTab = computed(() => this.tabs.find((t) => t.id === this.dialog.tab()) ?? this.tabs[0]);
  readonly activeSections = computed<SettingsSectionMeta[]>(() =>
    this.activeTab()
      .sections.map((id) => SETTINGS_SECTIONS.find((s) => s.id === id))
      .filter((s): s is SettingsSectionMeta => !!s),
  );

  private readonly body = viewChild<ElementRef<HTMLElement>>('body');
  private readonly closeBtn = viewChild<ElementRef<HTMLButtonElement>>('closeBtn');

  constructor() {
    // New tab → start at the top of its content.
    effect(() => {
      this.dialog.tab();
      this.body()?.nativeElement.scrollTo({ top: 0 });
    });
    // Focus the window when it opens (keyboard / screen readers).
    effect(() => {
      const btn = this.closeBtn();
      if (btn) queueMicrotask(() => btn.nativeElement.focus());
    });
  }

  select(id: string): void {
    this.dialog.tab.set(id);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    // Let an open dropdown/overlay close first.
    if (document.querySelector('.p-select-overlay, .p-datepicker-panel, .p-popover')) return;
    this.dialog.close();
  }
}
