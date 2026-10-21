/** Mirrors backend `ONBOARDING_STEPS` — order is the setup order. */
export type OnboardingStepId = 'account' | 'workspace' | 'departments' | 'users' | 'data' | 'access';

/** A route's prerequisite: a setup step, or the whole mandatory setup. */
export type OnboardingRequirement = OnboardingStepId | 'complete';

/** Shape of GET /api/onboarding. */
export interface OnboardingStatus {
  steps: { id: OnboardingStepId; mandatory: boolean; done: boolean; count: number | null }[];
  setupComplete: boolean;
  dismissed: boolean;
  workspaceStatus: 'PROVISIONING' | 'ACTIVE' | 'PROVISIONING_FAILED' | null;
}

export interface OnboardingStepGuide {
  id: OnboardingStepId;
  title: string;
  /** Header menu that does this step; null for automatic steps. */
  menu: string | null;
  route: string | null;
  /** Shown once done, e.g. "2 departments created". */
  doneLabel: (count: number | null) => string;
  summary: string;
  /** What to do, in order, on that menu's screen. */
  howTo: string[];
  /** One line shown in the guide bar on the step's own screen. */
  hint: string;
}

export const ONBOARDING_GUIDE: OnboardingStepGuide[] = [
  {
    id: 'account',
    title: 'Register your municipality',
    menu: null,
    route: null,
    doneLabel: () => 'Municipality and Owner account created',
    summary:
      'Your municipality and your Municipality Owner account were created at registration. The Owner is the only role that can configure the platform.',
    howTo: [],
    hint: ''
  },
  {
    id: 'workspace',
    title: 'GIS workspace',
    menu: null,
    route: null,
    doneLabel: () => 'Workspace ready on GeoServer',
    summary:
      'A dedicated GIS workspace is created for your municipality automatically. Every layer you publish is stored and served from it.',
    howTo: [],
    hint: ''
  },
  {
    id: 'departments',
    title: 'Create departments',
    menu: 'Departments',
    route: '/departments',
    doneLabel: (n) => `${n} department${n === 1 ? '' : 's'} created`,
    summary:
      'Departments (Water Works, Street Lights, Roads…) own the operational GIS data of the municipality. Every Department Head and Department User belongs to one.',
    howTo: [
      'Open the Departments menu.',
      'Add a department for each municipal function that maintains map data.',
      'Give each one a clear name — it appears on layers, users and permissions.'
    ],
    hint: 'Add at least one department, e.g. Water Works.'
  },
  {
    id: 'users',
    title: 'Add users',
    menu: 'Users',
    route: '/users',
    doneLabel: (n) => `${n} user${n === 1 ? '' : 's'} added`,
    summary:
      'Add the people who will work on the platform. Department Heads upload, review and publish their department’s data; Department Users can view the Municipal GIS map.',
    howTo: [
      'Open the Users menu.',
      'Add a user and choose their role: Department Head or Department User.',
      'Assign the department they work in.'
    ],
    hint: 'Add at least one Department Head or Department User.'
  },
  {
    id: 'data',
    title: 'Upload and publish GIS data',
    menu: 'GIS Layers',
    route: '/gis/layers',
    doneLabel: (n) => `${n} layer upload${n === 1 ? '' : 's'} published`,
    summary:
      'Bring your map data in. Uploads are validated (file, CRS, geometry), reviewed and then published as a layer on the Municipal GIS map.',
    howTo: [
      'Open the GIS Layers menu and click Upload Data.',
      'Choose a Shapefile (ZIP), GeoJSON or CSV and follow the wizard.',
      'Submit it for review, Approve it, then Publish.',
      'Optional: use the Permissions (shield) button on a layer to control who can view, edit or export it.'
    ],
    hint: 'Upload a file, then Submit → Approve → Publish it.'
  },
  {
    id: 'access',
    title: 'Review module access',
    menu: 'Module Access',
    route: '/module-access',
    doneLabel: () => 'Reviewed',
    summary:
      'Optional. Choose which map tools and modules (measure, print, data tools, geoprocessing…) each role and department may use. Sensible defaults already apply.',
    howTo: [
      'Open the Module Access menu.',
      'Turn modules on or off for each role or department.',
      'Come back here and mark this step as reviewed.'
    ],
    hint: 'Adjust module access if needed, then mark this step as reviewed.'
  }
];

export function onboardingGuide(id: OnboardingStepId): OnboardingStepGuide {
  return ONBOARDING_GUIDE.find((g) => g.id === id)!;
}
