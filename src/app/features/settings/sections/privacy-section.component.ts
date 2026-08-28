import { Component } from '@angular/core';

/** Settings → Privacy & Data Usage. Static explanation of what the Settings
 *  feature stores and where. */
@Component({
  selector: 'app-privacy-section',
  standalone: true,
  imports: [],
  template: `
    <div class="prose">
      <h3>What this screen stores</h3>
      <p>
        Your preferences on this screen are saved against your user account in the
        platform database, and mirrored to this browser's local storage so the app can
        apply your theme before it finishes loading. No preference here is shared with
        other users or with your municipality.
      </p>

      <h3>Your profile</h3>
      <p>
        Your name, email, mobile number, role and department are held to operate the
        platform — authentication, layer permissions and audit trails. Email and role
        are managed by your Municipality Owner; you can edit your own name and mobile
        number under Profile &amp; Account.
      </p>

      <h3>Map &amp; usage data</h3>
      <p>
        Basemap tiles are requested directly from third-party providers (OpenStreetMap,
        CARTO, OpenTopoMap) as you pan the map, which necessarily discloses your IP
        address and the area you are viewing to them. GIS layer data stays within this
        platform.
      </p>

      <h3>Clearing your data</h3>
      <p>
        “Reset Settings” removes every preference on this screen from both the database
        and this browser. Removing your account entirely is done by your Municipality
        Owner from the Users screen.
      </p>
    </div>
  `,
  styles: [
    `
      .prose h3 {
        font-size: 13.5px;
        margin: 20px 0 6px;
      }
      .prose h3:first-child {
        margin-top: 0;
      }
      .prose p {
        font-size: 12.5px;
        line-height: 1.65;
        color: var(--color-ink-500);
        margin: 0;
      }
    `,
  ],
})
export class PrivacySectionComponent {}
