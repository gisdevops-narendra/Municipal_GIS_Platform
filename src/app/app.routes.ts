import { Routes } from '@angular/router';
import { reviewStepGuard, successStepGuard } from './core/guards/registration-step.guard';
import { authGuard } from './core/guards/auth.guard';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./features/landing/landing.component').then((m) => m.LandingComponent),
    title: 'Municipal GIS Platform'
  },
  {
    path: 'login',
    loadComponent: () => import('./features/auth/login/login.component').then((m) => m.LoginComponent),
    title: 'Login — Municipal GIS Platform'
  },
  {
    path: 'register',
    pathMatch: 'full',
    redirectTo: 'register/municipality'
  },
  {
    path: 'register/municipality',
    loadComponent: () =>
      import('./features/auth/registration/municipality-info/municipality-info.component').then(
        (m) => m.MunicipalityInfoComponent
      ),
    title: 'Register Municipality — Municipal GIS Platform'
  },
  {
    path: 'register/owner',
    loadComponent: () =>
      import('./features/auth/registration/owner-account/owner-account.component').then(
        (m) => m.OwnerAccountComponent
      ),
    title: 'Create Owner Account — Municipal GIS Platform'
  },
  {
    path: 'register/review',
    canActivate: [reviewStepGuard],
    loadComponent: () =>
      import('./features/auth/registration/review/review.component').then((m) => m.ReviewComponent),
    title: 'Review & Confirm — Municipal GIS Platform'
  },
  {
    path: 'register/success',
    canActivate: [successStepGuard],
    loadComponent: () =>
      import('./features/auth/registration/success/success.component').then((m) => m.SuccessComponent),
    title: 'Municipality Created — Municipal GIS Platform'
  },
  {
    path: 'dashboard',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/dashboard/dashboard-placeholder.component').then(
        (m) => m.DashboardPlaceholderComponent
      ),
    title: 'Dashboard — Municipal GIS Platform'
  },
  {
    path: 'departments',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/departments/departments.component').then((m) => m.DepartmentsComponent),
    title: 'Departments — Municipal GIS Platform'
  },
  {
    path: 'users',
    canActivate: [authGuard],
    loadComponent: () => import('./features/users/users.component').then((m) => m.UsersComponent),
    title: 'Users — Municipal GIS Platform'
  },
  {
    path: 'gis',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/gis/gis-workspace.component').then((m) => m.GisWorkspaceComponent),
    title: 'Municipal GIS — Municipal GIS Platform'
  },
  {
    path: 'settings',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/settings/settings.component').then((m) => m.SettingsComponent),
    title: 'Settings — Municipal GIS Platform'
  },
  {
    path: 'gis/uploads',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/gis/pages/gis-uploads/gis-uploads.component').then(
        (m) => m.GisUploadsComponent
      ),
    title: 'GIS Data — Municipal GIS Platform'
  },
  {
    path: 'gis/layers',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/gis/pages/gis-layers/gis-layers.component').then((m) => m.GisLayersComponent),
    title: 'GIS Layers — Municipal GIS Platform'
  },
  {
    path: 'gis/layers/:id/permissions',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/gis/pages/gis-layer-permissions/gis-layer-permissions.component').then(
        (m) => m.GisLayerPermissionsComponent
      ),
    title: 'Layer Permissions — Municipal GIS Platform'
  },
  {
    path: '**',
    redirectTo: ''
  }
];
