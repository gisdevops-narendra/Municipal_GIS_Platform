import { Component } from '@angular/core';
import { environment } from '../../../../environments/environment';

@Component({
  selector: 'app-site-footer',
  standalone: true,
  templateUrl: './site-footer.component.html',
  styleUrl: './site-footer.component.scss'
})
export class SiteFooterComponent {
  readonly year = new Date().getFullYear();
  readonly version = environment.version;
}
