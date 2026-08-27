/** The type of Urban Local Body being registered. Kept as a configurable
 *  list rather than a hard-coded enum with special-cased logic, since the
 *  platform must support ULB types beyond Municipal Corporations. */
export type MunicipalityTypeCode =
  | 'municipal_corporation'
  | 'municipality'
  | 'municipal_council'
  | 'nagar_palika'
  | 'nagar_panchayat'
  | 'other';

export interface MunicipalityTypeOption {
  code: MunicipalityTypeCode;
  label: string;
}

export interface MunicipalityInfo {
  name: string;
  type: MunicipalityTypeCode | null;
  state: string;
  district: string;
  cityOrTown: string;
  officialEmail: string;
  contactNumber: string;
}

export const emptyMunicipalityInfo: MunicipalityInfo = {
  name: '',
  type: null,
  state: '',
  district: '',
  cityOrTown: '',
  officialEmail: '',
  contactNumber: ''
};
