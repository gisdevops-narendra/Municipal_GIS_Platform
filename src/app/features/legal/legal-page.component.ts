import { Component, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { SiteHeaderComponent } from '../../shared/components/site-header/site-header.component';
import { SiteFooterComponent } from '../../shared/components/site-footer/site-footer.component';

/** Version accepted at sign-up — keep in sync with the backend TERMS_VERSION. */
export const TERMS_VERSION = '2026-11-21';

/**
 * Terms of Service and Privacy Policy (public pages, linked from sign-up).
 * NOTE: starting text only — have it reviewed for your jurisdiction and
 * organisation before going live, and bump TERMS_VERSION when it changes.
 */
@Component({
  selector: 'app-legal-page',
  standalone: true,
  imports: [RouterLink, SiteHeaderComponent, SiteFooterComponent],
  template: `
    <app-site-header />
    <main class="legal">
      <article class="legal__doc">
        @if (doc === 'terms') {
          <h1>Terms of Service</h1>
          <p class="legal__meta">Version {{ version }}</p>
          <h2>1. The service</h2>
          <p>Municipal GIS Platform lets you upload geographic data, view it on a map, analyse it and share it. Each account has its own private workspace.</p>
          <h2>2. Your account</h2>
          <p>You must give a real email address and keep your password secret. You are responsible for what happens in your account. One person per account.</p>
          <h2>3. Your data</h2>
          <p>You keep all rights to the data you upload. You must have the right to upload it. We only process it to run the service for you (storing, displaying, analysing and exporting it). You can delete any layer, or your whole account, at any time from the app.</p>
          <h2>4. Acceptable use</h2>
          <p>Do not upload unlawful content or personal data you are not allowed to process, do not try to access other accounts, and do not overload or attack the service. We may suspend accounts that do.</p>
          <h2>5. Storage limits</h2>
          <p>Accounts have a storage limit. Uploads that would exceed it are refused until you free up space or the limit is raised.</p>
          <h2>6. Availability</h2>
          <p>We work to keep the service running and back it up regularly, but it is provided "as is" without guarantees. Keep your own copies of important data.</p>
          <h2>7. Changes</h2>
          <p>We may update these terms. The version you accepted is recorded with your account.</p>
          <p class="legal__see">See also the <a routerLink="/privacy">Privacy Policy</a>.</p>
        } @else {
          <h1>Privacy Policy</h1>
          <p class="legal__meta">Version {{ version }}</p>
          <h2>What we store</h2>
          <p>Your name, email address, optional mobile number, your settings, and the GIS data you upload. For security we keep a log of important account actions (sign-up, email changes, deletions, layer changes) with the time and IP address.</p>
          <h2>Why</h2>
          <p>Only to run the service: to sign you in, show and process your data, protect accounts from abuse, and help you if something goes wrong.</p>
          <h2>Who can see it</h2>
          <p>Your workspace is private to your account. Platform administrators can see account details and the activity log to keep the service safe. Map backgrounds are loaded from third-party tile providers, which see your IP address and the area you view.</p>
          <h2>How long</h2>
          <p>Until you delete it. Deleting your account removes your profile, workspace and all uploaded data. The activity log entry recording the deletion is kept for security.</p>
          <h2>Your choices</h2>
          <p>You can change your name, email and password, and delete your account, in Settings.</p>
          <p class="legal__see">See also the <a routerLink="/terms">Terms of Service</a>.</p>
        }
      </article>
    </main>
    <app-site-footer />
  `,
  styles: [
    `
      .legal {
        padding: 40px 16px 72px;
      }
      .legal__doc {
        max-width: 720px;
        margin: 0 auto;
        color: var(--color-ink-700);
        font-size: 14.5px;
        line-height: 1.65;
      }
      h1 {
        margin: 0 0 4px;
        font-size: 26px;
        color: var(--color-ink-900);
      }
      h2 {
        margin: 26px 0 6px;
        font-size: 16px;
        color: var(--color-ink-900);
      }
      p {
        margin: 0 0 10px;
      }
      .legal__meta {
        color: var(--color-ink-500);
        font-size: 13px;
      }
      .legal__see {
        margin-top: 28px;
      }
      a {
        color: var(--color-primary-700);
      }
    `,
  ],
})
export class LegalPageComponent {
  readonly doc = inject(ActivatedRoute).snapshot.data['doc'] as 'terms' | 'privacy';
  readonly version = TERMS_VERSION;
}
