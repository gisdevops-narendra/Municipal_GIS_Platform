import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Toast } from 'primeng/toast';
import { ConfirmDialog } from 'primeng/confirmdialog';

/**
 * Application shell. Hosts the single `<p-toast>` and `<p-confirmdialog>`
 * instances that back `NotificationService` — every screen's success /
 * error / warning / info messages and confirm prompts render through
 * these, so the app never uses a native `alert()` / `confirm()`.
 *
 * `Toast` / `ConfirmDialog` are referenced only inside the `@defer` block
 * in the template, so the compiler keeps them (and their PrimeNG Dialog /
 * Button dependencies) out of the initial bundle.
 */
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, Toast, ConfirmDialog],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent {}
