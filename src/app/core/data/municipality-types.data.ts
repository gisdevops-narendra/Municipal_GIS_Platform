import { MunicipalityTypeOption } from '../models/municipality.model';

/** Configurable list of Indian Urban Local Body types. Adding a new type
 *  later means adding an entry here — no code branching depends on which
 *  type is selected. */
export const MUNICIPALITY_TYPES: MunicipalityTypeOption[] = [
  { code: 'municipal_corporation', label: 'Municipal Corporation' },
  { code: 'municipality', label: 'Municipality' },
  { code: 'municipal_council', label: 'Municipal Council' },
  { code: 'nagar_palika', label: 'Nagar Palika' },
  { code: 'nagar_panchayat', label: 'Nagar Panchayat' },
  { code: 'other', label: 'Other' }
];
