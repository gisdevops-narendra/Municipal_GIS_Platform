import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./features/landing/landing.component').then((m) => m.LandingComponent),
    title: 'Municipal GIS Platform'
  },
  {
    // Share Map: public, read-only — no sign-in.
    path: 'share/:token',
    loadComponent: () => import('./features/share/public-map.component').then((m) => m.PublicMapComponent),
    title: 'Shared map — Municipal GIS Platform'
  },
  {
    path: 'login',
    loadComponent: () => import('./features/auth/login/login.component').then((m) => m.LoginComponent),
    title: 'Login — Municipal GIS Platform'
  },
  {
    path: 'register',
    loadComponent: () => import('./features/auth/register/register.component').then((m) => m.RegisterComponent),
    title: 'Create Account — Municipal GIS Platform'
  },
  {
    // Old multi-step registration links.
    path: 'register/:step',
    redirectTo: 'register'
  },
  {
    path: 'gis',
    canActivate: [authGuard],
    data: { reuse: true },
    loadComponent: () =>
      import('./features/gis/gis-workspace.component').then((m) => m.GisWorkspaceComponent),
    title: 'Municipal GIS — Municipal GIS Platform'
  },
  {
    path: 'collect',
    canActivate: [authGuard],
    loadComponent: () => import('./features/collect/collect.component').then((m) => m.CollectComponent),
    title: 'Field Collection — Municipal GIS Platform'
  },
  {
    // Opens the Settings window over the map (old links keep working).
    path: 'settings',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/settings/settings.component').then((m) => m.SettingsComponent),
    title: 'Settings — Municipal GIS Platform'
  },
  {
    // Uploading and managing layers happens on the map now.
    path: 'gis/uploads',
    redirectTo: 'gis'
  },
  { path: 'gis/layers', redirectTo: 'gis' },
  {
    // Departments, Users, Module Access and Getting Started were removed.
    path: 'departments',
    redirectTo: 'gis'
  },
  { path: 'dashboard', redirectTo: 'gis' },
  { path: 'users', redirectTo: 'gis' },
  { path: 'module-access', redirectTo: 'gis' },
  { path: 'setup', redirectTo: 'gis' },
  {
    path: '**',
    redirectTo: ''
  }
];
