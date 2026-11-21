import { Component, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { SettingsDialogService } from '../../core/services/settings-dialog.service';

/**
 * `/settings` (and old `/settings?section=…` links): Settings is now a
 * window over the current page, so this route just opens it on the right
 * tab and shows the map behind it.
 */
@Component({
  selector: 'app-settings',
  standalone: true,
  template: '',
})
export class SettingsComponent {
  constructor() {
    const route = inject(ActivatedRoute);
    inject(SettingsDialogService).open(route.snapshot.queryParamMap.get('section'));
    void inject(Router).navigateByUrl('/gis', { replaceUrl: true });
  }
}
