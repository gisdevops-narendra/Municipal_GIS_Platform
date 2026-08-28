import { Injectable, inject } from '@angular/core';
import { ConfirmationService, MessageService } from 'primeng/api';
import { SettingsService } from './settings.service';

type ToastSeverity = 'success' | 'info' | 'warn' | 'error';

/** Optional category (see `NOTIFICATION_CATEGORIES`) — a toast whose
 *  category the user has switched off in Settings is silently dropped.
 *  Omitting it always shows the toast. */
export type NotificationCategory =
  | 'general'
  | 'uploads'
  | 'layers'
  | 'system'
  | 'session';

export interface ConfirmRequest {
  /** Body text of the dialog. */
  message: string;
  /** Dialog title. Defaults to "Please confirm". */
  header?: string;
  /** Label on the confirm button. Defaults to "Confirm". */
  confirmLabel?: string;
  /** Label on the cancel button. Defaults to "Cancel". */
  cancelLabel?: string;
  /** Render the confirm button as destructive (red) with a warning icon.
   *  Defaults to false. */
  destructive?: boolean;
  /** Run when the user confirms. */
  accept: () => void;
  /** Run when the user cancels or dismisses. Optional. */
  reject?: () => void;
}

/**
 * The application's single entry point for transient notifications
 * (success / info / warning / error toasts) and confirmation prompts.
 *
 * Wraps PrimeNG's `MessageService` and `ConfirmationService` so every
 * screen — current and future — gets the same look and behaviour. The
 * native `alert()` / `confirm()` / `prompt()` are never used anywhere in
 * the app; use this service instead.
 *
 * The single `<p-toast>` and `<p-confirmdialog>` hosts live in
 * `AppComponent` — components only inject this service.
 */
@Injectable({ providedIn: 'root' })
export class NotificationService {
  private readonly messages = inject(MessageService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly settings = inject(SettingsService);

  /** A completed action. */
  success(detail: string, summary = 'Success', category?: NotificationCategory): void {
    this.toast('success', summary, detail, undefined, category);
  }

  /** Neutral information. */
  info(detail: string, summary = 'Information', category?: NotificationCategory): void {
    this.toast('info', summary, detail, undefined, category);
  }

  /** Something the user should be aware of but that isn't a failure. */
  warn(detail: string, summary = 'Warning', category?: NotificationCategory): void {
    this.toast('warn', summary, detail, 7000, category);
  }

  /** An action that failed. Stays on screen a little longer. Errors are
   *  never suppressed by a category toggle. */
  error(detail: string, summary = 'Something went wrong'): void {
    this.toast('error', summary, detail, 9000);
  }

  /**
   * Shows a modal confirm / cancel dialog. Nothing happens until the user
   * chooses — `accept` runs on confirm, `reject` (if given) on cancel or
   * dismiss.
   */
  confirm(request: ConfirmRequest): void {
    this.confirmation.confirm({
      header: request.header ?? 'Please confirm',
      message: request.message,
      icon: request.destructive
        ? 'pi pi-exclamation-triangle'
        : 'pi pi-question-circle',
      closable: true,
      dismissableMask: true,
      acceptButtonProps: {
        label: request.confirmLabel ?? 'Confirm',
        severity: request.destructive ? 'danger' : 'primary'
      },
      rejectButtonProps: {
        label: request.cancelLabel ?? 'Cancel',
        severity: 'secondary',
        text: true
      },
      accept: () => request.accept(),
      reject: () => request.reject?.()
    });
  }

  /**
   * Confirm dialog pre-tuned for destructive actions — red "Delete"
   * button, warning icon, "Confirm deletion" header. Override any of those
   * via the request.
   */
  confirmDelete(request: Omit<ConfirmRequest, 'destructive'>): void {
    this.confirm({
      header: 'Confirm deletion',
      confirmLabel: 'Delete',
      ...request,
      destructive: true
    });
  }

  private toast(
    severity: ToastSeverity,
    summary: string,
    detail: string,
    life?: number,
    category?: NotificationCategory
  ): void {
    const prefs = this.settings.notifications();
    if (category && prefs.categories[category] === false) {
      return;
    }
    this.messages.add({
      severity,
      summary,
      detail,
      life: life ?? prefs.toastDuration
    });
  }
}
