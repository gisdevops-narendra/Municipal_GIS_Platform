import { Directive, ElementRef, HostListener, inject } from '@angular/core';
import { ColorPicker } from 'primeng/colorpicker';

/**
 * Closes a p-colorPicker on the first press outside it. PrimeNG binds its own
 * outside-click listener only after the open animation starts, so the opening
 * click leaves `selfClick` set and the next outside click is swallowed —
 * the panel then needs a second click to close. Applies to every
 * p-colorPicker in a component that imports this directive.
 */
@Directive({ selector: 'p-colorPicker', standalone: true })
export class ColorPickerCloseDirective {
  private readonly picker = inject(ColorPicker);
  private readonly host = inject(ElementRef<HTMLElement>);

  @HostListener('document:pointerdown', ['$event'])
  onDocumentPointerDown(event: PointerEvent): void {
    if (!this.picker.overlayVisible || this.picker.inline) return;
    const target = event.target as Node | null;
    if (!target || this.host.nativeElement.contains(target) || this.picker.overlay?.contains(target)) return;
    this.picker.selfClick = false;
    this.picker.hide();
  }
}
