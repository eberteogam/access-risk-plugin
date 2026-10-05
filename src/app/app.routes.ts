import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./features/risk-cockpit/risk-cockpit.component').then(m => m.RiskCockpitComponent) },
  { path: 'overview', loadComponent: () => import('./features/overview/overview.component').then(m => m.OverviewComponent) },
  { path: 'workflows', loadComponent: () => import('./features/workflows/workflows.component').then(m => m.WorkflowsComponent) },
  { path: 'api-examples', loadComponent: () => import('./features/api-examples/api-examples.component').then(m => m.ApiExamplesComponent) },
];
