import { CreateGisUploadRequest } from './gis-upload.model';

export type ExternalDbType = 'POSTGRESQL' | 'MYSQL' | 'MONGODB';

/** Sent with every request; the platform never stores it. */
export interface ExternalDbConnection {
  type: ExternalDbType;
  host: string;
  port: number;
  database: string;
  username?: string;
  password?: string;
  /** PostgreSQL */
  sslMode?: 'disable' | 'prefer' | 'require' | 'verify-ca' | 'verify-full';
  schemas?: string;
  /** MongoDB */
  authSource?: string;
  tls?: boolean;
  srv?: boolean;
}

export interface ExternalField {
  name: string;
  type: string;
}

export interface ExternalDataset {
  name: string;
  schema: string | null;
  table: string;
  geometryField: string | null;
  geometryType: string | null;
  crs: string | null;
  featureCount: number | null;
  fields: ExternalField[];
}

export interface ExternalPreview {
  dataset: ExternalDataset;
  /** `__geometry` holds each record's geometry type. */
  rows: Record<string, unknown>[];
}

/** What the database step hands the wizard to import. */
export interface ExternalDbSelection {
  connection: ExternalDbConnection;
  dataset: string;
  geometryField?: string;
  fields?: string[];
  limit?: number;
  sourceCrs?: string;
  latitudeField?: string;
  longitudeField?: string;
  xField?: string;
  yField?: string;
  /** Point data from coordinate columns (no routing). */
  points: boolean;
}

export type ExternalDbImportRequest = CreateGisUploadRequest & Omit<ExternalDbSelection, 'points'>;
