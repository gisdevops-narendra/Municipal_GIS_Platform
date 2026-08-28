import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as path from 'path';
import {
  GISLayerUpload,
  GisGeometryType,
  GisPermission,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AppUser } from '../auth/types/app-user.type';
import { GdalError, GdalService } from './gdal.service';
import {
  StorageService,
  UnsafeArchiveError,
  UploadTooLargeError,
} from './storage.service';
import { GeoServerService, PostgisConnectionParams } from './geoserver.service';
import { GisAuthorizationService } from './gis-authorization.service';
import { StyleService, type UploadedIcon } from './style.service';
import { FieldStatsService } from './field-stats.service';
import { CreateUploadDto } from './dto/create-upload.dto';
import type {
  ClassificationMethod,
  LayerStyleSpecDto,
} from './dto/layer-style.dto';
import {
  deriveLayerCode,
  generateLayerTableName,
  isSafeGeneratedTableName,
} from './layer-naming.util';

interface ValidationSummary {
  fileValid: boolean;
  sourceCrs: string | null;
  targetCrs: string;
  geometryType: string | null;
  featureCount: number;
  fields: { name: string; type: string }[];
  warnings: string[];
  errors: string[];
}

const LAT_NAMES = ['latitude', 'lat'];
const LON_NAMES = ['longitude', 'lon', 'lng'];
const X_NAMES = ['x', 'easting'];
const Y_NAMES = ['y', 'northing'];

function findFieldIgnoreCase(
  fields: string[],
  candidates: string[],
): string | null {
  for (const candidate of candidates) {
    const found = fields.find((f) => f.toLowerCase() === candidate);
    if (found) return found;
  }
  return null;
}

function mapGeometryType(raw: string | null): GisGeometryType | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower.includes('point')) return 'POINT';
  if (lower.includes('line')) return 'LINE';
  if (lower.includes('polygon')) return 'POLYGON';
  return null;
}

/**
 * Orchestrates the whole Task 7 upload lifecycle: create -> validate ->
 * preview -> submit-review -> approve/reject -> publish. See
 * docs/backend.md "GIS Uploads" for the full design. Every method takes
 * `appUser` (municipalityId, systemRole, departmentId, id) resolved
 * server-side from the JWT — never a client-supplied tenant/department id
 * (Task 7 §40/§41).
 */
@Injectable()
export class GisUploadsService {
  private readonly logger = new Logger(GisUploadsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly gdal: GdalService,
    private readonly geoServer: GeoServerService,
    private readonly config: ConfigService,
    private readonly gisAuth: GisAuthorizationService,
    private readonly styleService: StyleService,
    private readonly fieldStats: FieldStatsService,
  ) {}

  async create(
    appUser: AppUser,
    dto: CreateUploadDto,
    file: Express.Multer.File,
  ) {
    const workspace = await this.prisma.gISWorkspace.findUnique({
      where: { municipalityId: appUser.municipalityId },
    });
    if (!workspace || workspace.status !== 'ACTIVE') {
      throw new BadRequestException(
        'GIS workspace is not ready for uploads yet.',
      );
    }

    if (dto.departmentId) {
      const department = await this.prisma.department.findFirst({
        where: { id: dto.departmentId, municipalityId: appUser.municipalityId },
      });
      if (!department) {
        // Never confirms whether the id exists in another municipality —
        // see Task 7 §41.
        throw new NotFoundException('Department not found.');
      }
    }

    const layerCode = deriveLayerCode(dto.layerName);
    await this.assertCanUpload(appUser, dto, workspace.id, layerCode);

    const fileFormat = this.detectFileFormat(file.originalname);
    if (!fileFormat) {
      throw new BadRequestException(
        'Unsupported file type. Upload a Shapefile ZIP, GeoJSON, or CSV file.',
      );
    }
    if (fileFormat === 'CSV' && (dto.xField || dto.yField) && !dto.sourceCrs) {
      throw new BadRequestException(
        'sourceCrs is required when specifying X/Y columns — it is never assumed to be WGS84.',
      );
    }

    const upload = await this.prisma.gISLayerUpload.create({
      data: {
        municipalityId: appUser.municipalityId,
        gisWorkspaceId: workspace.id,
        uploadedById: appUser.id,
        originalFilename: file.originalname,
        storedFilename: '',
        fileSize: file.size,
        fileFormat,
        status: 'UPLOAD_PENDING',
        layerName: dto.layerName.trim(),
        layerCode,
        description: dto.description?.trim() || null,
        departmentId:
          dto.ownershipType === 'DEPARTMENT' ? dto.departmentId : null,
        ownershipType: dto.ownershipType,
        sourceCrs: dto.sourceCrs ?? null,
        targetCrs: workspace.defaultCrs,
      },
    });

    const { storedFilename } = await this.storage.saveRawFile(
      appUser.municipalityId,
      upload.id,
      file.originalname,
      file.buffer,
    );
    await this.prisma.gISLayerUpload.update({
      where: { id: upload.id },
      data: { storedFilename },
    });

    await this.runValidation(upload.id, dto);

    return this.toResponse(await this.mustFind(upload.id));
  }

  async validate(uploadId: string, appUser: AppUser) {
    const upload = await this.findScoped(uploadId, appUser);
    this.assertCanManage(appUser, upload);
    await this.runValidation(uploadId);
    return this.toResponse(await this.mustFind(uploadId));
  }

  async list(appUser: AppUser, page: number, pageSize: number) {
    const where: Prisma.GISLayerUploadWhereInput =
      appUser.systemRole === 'MUNICIPALITY_OWNER'
        ? { municipalityId: appUser.municipalityId }
        : {
            municipalityId: appUser.municipalityId,
            OR: [
              { uploadedById: appUser.id },
              ...(appUser.departmentId
                ? [{ departmentId: appUser.departmentId }]
                : []),
            ],
          };

    const [total, uploads] = await this.prisma.$transaction([
      this.prisma.gISLayerUpload.count({ where }),
      this.prisma.gISLayerUpload.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { department: { select: { id: true, name: true } } },
      }),
    ]);

    return {
      items: uploads.map((u) => this.toResponse(u)),
      page,
      pageSize,
      total,
    };
  }

  async getById(uploadId: string, appUser: AppUser) {
    const upload = await this.findScoped(uploadId, appUser);
    return this.toResponse(upload);
  }

  /** Publishes a temporary WMS resource for the upload's already-imported
   *  table so the wizard's preview step can render it exactly like any
   *  other layer (ImageWMS), without ever sending raw geometry to the
   *  browser — see Task 7 §20/§52. Idempotent. */
  async preview(uploadId: string, appUser: AppUser) {
    const upload = await this.findScoped(uploadId, appUser);
    this.assertCanManage(appUser, upload);
    if (!upload.postgisTable) {
      throw new BadRequestException(
        'This upload has not been validated successfully yet.',
      );
    }

    const workspace = await this.prisma.gISWorkspace.findUniqueOrThrow({
      where: { id: upload.gisWorkspaceId },
    });
    const datastore = `${workspace.geoserverWorkspace}_postgis`;
    const previewName = this.previewLayerName(upload.id);

    const bbox = await this.geoServer.ensureFeatureType(
      workspace.geoserverWorkspace,
      datastore,
      {
        name: previewName,
        nativeName: upload.postgisTable,
        title: `Preview — ${upload.layerName}`,
        srs: upload.targetCrs ?? workspace.defaultCrs,
      },
    );

    return {
      geoserverWorkspace: workspace.geoserverWorkspace,
      geoserverLayer: previewName,
      bbox,
    };
  }

  // ---- Styling in the upload wizard (GIS Layer Styling). The spec is
  //      applied to the preview featuretype for the wizard map, saved on
  //      the upload, and re-applied to the real layer at publish time. ----

  private uploadGeometryKey(
    upload: GISLayerUpload,
  ): 'point' | 'line' | 'polygon' | null {
    if (upload.geometryType === 'POINT') return 'point';
    if (upload.geometryType === 'LINE') return 'line';
    if (upload.geometryType === 'POLYGON') return 'polygon';
    return null;
  }

  private assertStyleable(
    upload: GISLayerUpload,
  ): asserts upload is GISLayerUpload & {
    postgisTable: string;
  } {
    if (
      !upload.postgisTable ||
      !isSafeGeneratedTableName(upload.postgisTable)
    ) {
      throw new BadRequestException(
        'This upload has not been validated successfully yet.',
      );
    }
  }

  async uploadStyleAttributes(uploadId: string, appUser: AppUser) {
    const upload = await this.findScoped(uploadId, appUser);
    this.assertCanManage(appUser, upload);
    this.assertStyleable(upload);
    return {
      geometry: this.uploadGeometryKey(upload),
      attributes: await this.fieldStats.attributes(upload.postgisTable, null),
    };
  }

  async uploadFieldStats(
    uploadId: string,
    appUser: AppUser,
    field: string,
    options: { method?: ClassificationMethod; classes?: number },
  ) {
    const upload = await this.findScoped(uploadId, appUser);
    this.assertCanManage(appUser, upload);
    this.assertStyleable(upload);
    return this.fieldStats.fieldStats(
      upload.postgisTable,
      field,
      options,
      null,
    );
  }

  async applyUploadStyle(
    uploadId: string,
    appUser: AppUser,
    spec: LayerStyleSpecDto,
  ) {
    // preview() (re)publishes the `preview_<id>` featuretype and re-checks
    // access — the wizard styles that layer live on its own map.
    const { geoserverWorkspace, geoserverLayer } = await this.preview(
      uploadId,
      appUser,
    );
    await this.styleService.applyStyle(
      {
        workspace: geoserverWorkspace,
        geoserverLayer,
        styleName: `${geoserverLayer}_style`,
      },
      spec,
    );
    await this.prisma.gISLayerUpload.update({
      where: { id: uploadId },
      data: { styleSpec: spec as unknown as Prisma.InputJsonValue },
    });
    return { geoserverWorkspace, geoserverLayer };
  }

  /** Stores a user-supplied point icon in the upload's workspace. */
  async uploadStyleIcon(
    uploadId: string,
    appUser: AppUser,
    file: UploadedIcon,
  ) {
    const upload = await this.findScoped(uploadId, appUser);
    this.assertCanManage(appUser, upload);
    const workspace = await this.prisma.gISWorkspace.findUniqueOrThrow({
      where: { id: upload.gisWorkspaceId },
    });
    return this.styleService.uploadIcon(workspace.geoserverWorkspace, file);
  }

  /** Proxies a stored custom icon's bytes back for reload preview. */
  async uploadCustomIcon(uploadId: string, appUser: AppUser, name: string) {
    const upload = await this.findScoped(uploadId, appUser);
    this.assertCanManage(appUser, upload);
    const workspace = await this.prisma.gISWorkspace.findUniqueOrThrow({
      where: { id: upload.gisWorkspaceId },
    });
    return this.styleService.customIconBytes(
      workspace.geoserverWorkspace,
      name,
    );
  }

  async submitForReview(uploadId: string, appUser: AppUser) {
    const upload = await this.findScoped(uploadId, appUser);
    this.assertCanManage(appUser, upload);
    if (upload.status !== 'DRAFT') {
      throw new BadRequestException(
        `Cannot submit for review from status ${upload.status}.`,
      );
    }
    const updated = await this.prisma.gISLayerUpload.update({
      where: { id: uploadId },
      data: { status: 'IN_REVIEW' },
    });
    return this.toResponse(updated);
  }

  async approve(uploadId: string, appUser: AppUser) {
    const upload = await this.findScoped(uploadId, appUser);
    if (upload.status !== 'IN_REVIEW') {
      throw new BadRequestException(
        `Cannot approve from status ${upload.status}.`,
      );
    }
    if (!(await this.resolvePermissions(appUser, upload)).has('APPROVE')) {
      throw new ForbiddenException(
        'You do not have permission to approve this upload.',
      );
    }
    const updated = await this.prisma.gISLayerUpload.update({
      where: { id: uploadId },
      data: {
        status: 'APPROVED',
        reviewedById: appUser.id,
        reviewedAt: new Date(),
        rejectionReason: null,
      },
    });
    return this.toResponse(updated);
  }

  async reject(uploadId: string, appUser: AppUser, rejectionReason: string) {
    const upload = await this.findScoped(uploadId, appUser);
    if (upload.status !== 'IN_REVIEW') {
      throw new BadRequestException(
        `Cannot reject from status ${upload.status}.`,
      );
    }
    // Rejecting is part of the same review capability as approving — no
    // separate REJECT permission (Task 8 §3/§4 don't define one).
    if (!(await this.resolvePermissions(appUser, upload)).has('APPROVE')) {
      throw new ForbiddenException(
        'You do not have permission to reject this upload.',
      );
    }
    const updated = await this.prisma.gISLayerUpload.update({
      where: { id: uploadId },
      data: {
        status: 'REJECTED',
        reviewedById: appUser.id,
        reviewedAt: new Date(),
        rejectionReason,
      },
    });
    return this.toResponse(updated);
  }

  /**
   * Publishes an APPROVED (or retries a PUBLISH_FAILED) upload: creates or
   * replaces the destination GISLayer's GeoServer feature type, then
   * writes the GISLayer metadata, then marks the upload PUBLISHED. Never
   * marks PUBLISHED unless every step above succeeded — see Task 7 §27/§38.
   * When replacing an existing published layer (a new version), the OLD
   * feature type/table are only ever torn down AFTER the NEW one is
   * confirmed live (Task 7 §16/§23).
   */
  async publish(uploadId: string, appUser: AppUser) {
    const upload = await this.findScoped(uploadId, appUser);
    if (upload.status !== 'APPROVED' && upload.status !== 'PUBLISH_FAILED') {
      throw new BadRequestException(
        `Cannot publish from status ${upload.status}.`,
      );
    }
    if (!(await this.resolvePermissions(appUser, upload)).has('PUBLISH')) {
      throw new ForbiddenException(
        'You do not have permission to publish this upload.',
      );
    }
    if (
      !upload.postgisTable ||
      !isSafeGeneratedTableName(upload.postgisTable)
    ) {
      throw new BadRequestException(
        'Upload has no valid imported data to publish.',
      );
    }

    const workspace = await this.prisma.gISWorkspace.findUniqueOrThrow({
      where: { id: upload.gisWorkspaceId },
    });
    const datastore = `${workspace.geoserverWorkspace}_postgis`;
    const geoserverLayerName = upload.layerCode.toLowerCase();

    try {
      const existingLayer = await this.prisma.gISLayer.findUnique({
        where: {
          gisWorkspaceId_code: {
            gisWorkspaceId: workspace.id,
            code: upload.layerCode,
          },
        },
      });

      if (existingLayer) {
        // Replacing a published layer with a new version: tear down the
        // OLD feature type first so the new one can take its name, but
        // only AFTER confirming its own table is what we're about to
        // publish — the old table itself is not dropped until the new
        // feature type is verified live, below.
        await this.geoServer.deleteFeatureType(
          workspace.geoserverWorkspace,
          datastore,
          existingLayer.geoserverLayer,
        );
      }

      const bbox = await this.geoServer.ensureFeatureType(
        workspace.geoserverWorkspace,
        datastore,
        {
          name: geoserverLayerName,
          nativeName: upload.postgisTable,
          title: upload.layerName,
          srs: upload.targetCrs ?? workspace.defaultCrs,
        },
      );

      const savedLayer = await this.prisma.$transaction(async (tx) => {
        const layerRow = existingLayer
          ? await tx.gISLayer.update({
              where: { id: existingLayer.id },
              data: {
                name: upload.layerName,
                description: upload.description,
                postgisTable: upload.postgisTable!,
                geometryType: upload.geometryType,
                sourceUploadId: upload.id,
                version: { increment: 1 },
                status: 'ACTIVE',
                bboxMinX: bbox?.minX,
                bboxMinY: bbox?.minY,
                bboxMaxX: bbox?.maxX,
                bboxMaxY: bbox?.maxY,
                updatedById: appUser.id,
              },
            })
          : await tx.gISLayer.create({
              data: {
                gisWorkspaceId: workspace.id,
                name: upload.layerName,
                code: upload.layerCode,
                description: upload.description,
                layerType: 'VECTOR',
                geoserverWorkspace: workspace.geoserverWorkspace,
                geoserverLayer: geoserverLayerName,
                geometryType: upload.geometryType,
                departmentId: upload.departmentId,
                ownershipType: upload.ownershipType,
                postgisTable: upload.postgisTable!,
                sourceUploadId: upload.id,
                version: 1,
                visibleByDefault: true,
                displayOrder: await this.nextDisplayOrder(tx, workspace.id),
                bboxMinX: bbox?.minX,
                bboxMinY: bbox?.minY,
                bboxMaxX: bbox?.maxX,
                bboxMaxY: bbox?.maxY,
                createdById: appUser.id,
              },
            });

        await tx.gISLayerUpload.update({
          where: { id: upload.id },
          data: {
            status: 'PUBLISHED',
            publishedById: appUser.id,
            publishedAt: new Date(),
            layerId: layerRow.id,
          },
        });

        return layerRow;
      });

      // Task 8: a brand-new DEPARTMENT layer's owning department gets its
      // §4 default permissions seeded as real, editable rows the moment
      // it first exists — see GisAuthorizationService.ensureDefaultPermissions.
      // Not needed when replacing an existing layer (already has rows,
      // possibly customized by the Owner since — never overwritten here).
      if (
        !existingLayer &&
        upload.ownershipType === 'DEPARTMENT' &&
        upload.departmentId
      ) {
        await this.gisAuth.ensureDefaultPermissions(
          savedLayer.id,
          upload.departmentId,
        );
      }

      // GIS Layer Styling: carry the style the user configured in the
      // wizard's Preview step onto the real layer. Best-effort — a style
      // failure must never leave the layer unpublished (it is already live
      // above); it just falls back to the default style.
      if (upload.styleSpec) {
        try {
          const { styleName } = await this.styleService.applyStyle(
            {
              workspace: workspace.geoserverWorkspace,
              geoserverLayer: savedLayer.geoserverLayer,
            },
            upload.styleSpec as unknown as LayerStyleSpecDto,
          );
          await this.prisma.gISLayer.update({
            where: { id: savedLayer.id },
            data: {
              styleName,
              styleSpec: upload.styleSpec,
            },
          });
        } catch (error) {
          this.logger.warn(
            `Published layer ${savedLayer.id} but could not apply its saved style: ${(error as Error).message}`,
          );
        }
      }

      // Best-effort cleanup, never allowed to fail the publish itself
      // (the layer is already live at this point).
      await this.geoServer
        .deleteFeatureType(
          workspace.geoserverWorkspace,
          datastore,
          this.previewLayerName(upload.id),
        )
        .catch(() => undefined);
      await this.geoServer
        .deleteStyle(
          workspace.geoserverWorkspace,
          `${this.previewLayerName(upload.id)}_style`,
        )
        .catch(() => undefined);
      // existingLayer.postgisTable is null for a Task 6 demo/canonical
      // layer (shared gis_demo_* table, never owned by one upload) — such
      // a table must NEVER be dropped here, only a previous upload's own
      // dedicated layer_<uuid> table.
      if (
        existingLayer?.postgisTable &&
        existingLayer.postgisTable !== upload.postgisTable
      ) {
        await this.dropTableIfSafe(existingLayer.postgisTable);
      }

      return this.toResponse(await this.mustFind(uploadId));
    } catch (error) {
      this.logger.error(`Publishing upload ${uploadId} failed`, error as Error);
      await this.prisma.gISLayerUpload.update({
        where: { id: uploadId },
        data: {
          status: 'PUBLISH_FAILED',
          errorMessage: (error as Error).message,
        },
      });
      throw error;
    }
  }

  // ---------------------------------------------------------------------

  private async runValidation(
    uploadId: string,
    csvOverrides?: CreateUploadDto,
  ): Promise<void> {
    const upload = await this.mustFind(uploadId);
    await this.prisma.gISLayerUpload.update({
      where: { id: uploadId },
      data: { status: 'VALIDATING', errorMessage: null },
    });

    const warnings: string[] = [];
    try {
      const rawPath = path.join(
        this.storage.rawDir(upload.municipalityId, upload.id),
        upload.storedFilename,
      );

      let sourcePath = rawPath;
      let openOptions: string[] | undefined;

      if (upload.fileFormat === 'SHAPEFILE_ZIP') {
        const extracted = await this.storage.extractZipSafely(
          rawPath,
          upload.municipalityId,
          upload.id,
        );
        sourcePath = this.findShapefile(extracted.dir, extracted.files);
      } else if (upload.fileFormat === 'CSV') {
        openOptions = await this.buildCsvOpenOptions(
          rawPath,
          upload,
          csvOverrides,
          warnings,
        );
      }

      const inspected = await this.gdal.inspect(sourcePath, { openOptions });

      const geometryType = mapGeometryType(inspected.geometryType);
      if (!geometryType) {
        throw new GdalError(
          inspected.geometryType
            ? `Unsupported geometry type: ${inspected.geometryType}.`
            : 'The uploaded file has no geometry.',
        );
      }
      if (inspected.featureCount === 0) {
        throw new GdalError('The uploaded file contains no features.');
      }

      const sourceCrs = this.resolveSourceCrs(upload, inspected.epsgCode);
      if (!sourceCrs) {
        throw new GdalError(
          'Source CRS could not be determined from the file. Re-upload and specify sourceCrs explicitly.',
        );
      }

      const tableName = generateLayerTableName();
      const connection = this.datastoreConnection();
      await this.gdal.importToPostgis({
        sourcePath,
        tableName,
        targetCrs: upload.targetCrs ?? 'EPSG:32643',
        sourceCrsOverride: sourceCrs,
        openOptions,
        connection,
      });

      await this.ensureSpatialIndex(tableName);
      const { invalidCount, emptyCount } =
        await this.checkGeometryValidity(tableName);
      if (invalidCount > 0) {
        warnings.push(
          `${invalidCount} invalid geometr${invalidCount === 1 ? 'y' : 'ies'} found.`,
        );
      }
      if (emptyCount > 0) {
        warnings.push(
          `${emptyCount} empty geometr${emptyCount === 1 ? 'y' : 'ies'} found.`,
        );
      }

      const summary: ValidationSummary = {
        fileValid: true,
        sourceCrs,
        targetCrs: upload.targetCrs ?? 'EPSG:32643',
        geometryType,
        featureCount: inspected.featureCount,
        fields: inspected.fields,
        warnings,
        errors: [],
      };

      await this.prisma.gISLayerUpload.update({
        where: { id: uploadId },
        data: {
          status: 'DRAFT',
          sourceCrs,
          geometryType,
          featureCount: inspected.featureCount,
          postgisTable: tableName,
          validationSummary: summary as unknown as Prisma.InputJsonValue,
          errorMessage: null,
        },
      });

      if (upload.fileFormat === 'SHAPEFILE_ZIP') {
        await this.storage.cleanupTemporary(upload.municipalityId, upload.id);
      }
    } catch (error) {
      const message =
        error instanceof GdalError ||
        error instanceof UnsafeArchiveError ||
        error instanceof UploadTooLargeError
          ? error.message
          : `Validation failed: ${(error as Error).message}`;
      this.logger.warn(`Upload ${uploadId} validation failed: ${message}`);

      const summary: ValidationSummary = {
        fileValid: false,
        sourceCrs: upload.sourceCrs,
        targetCrs: upload.targetCrs ?? 'EPSG:32643',
        geometryType: null,
        featureCount: 0,
        fields: [],
        warnings,
        errors: [message],
      };
      await this.prisma.gISLayerUpload.update({
        where: { id: uploadId },
        data: {
          status: 'FAILED',
          errorMessage: message,
          validationSummary: summary as unknown as Prisma.InputJsonValue,
        },
      });
    }
  }

  /** Decides which CSV columns hold coordinates. Explicit
   *  latitudeField/longitudeField or xField/yField (from the upload
   *  request, or a validate-retry's overrides) always win. Otherwise,
   *  auto-detects against well-known column names (Task 7 §7) via a cheap
   *  plain-attribute read of the file's own header — X/Y auto-detection
   *  still requires an explicit sourceCrs (never assumed to be WGS84). */
  private async buildCsvOpenOptions(
    rawPath: string,
    upload: GISLayerUpload,
    overrides: CreateUploadDto | undefined,
    warnings: string[],
  ): Promise<string[]> {
    const latField = overrides?.latitudeField;
    const lonField = overrides?.longitudeField;
    const xField = overrides?.xField;
    const yField = overrides?.yField;

    if (latField && lonField) {
      return [
        `X_POSSIBLE_NAMES=${lonField}`,
        `Y_POSSIBLE_NAMES=${latField}`,
        'KEEP_GEOM_COLUMNS=NO',
      ];
    }
    if (xField && yField) {
      return [
        `X_POSSIBLE_NAMES=${xField}`,
        `Y_POSSIBLE_NAMES=${yField}`,
        'KEEP_GEOM_COLUMNS=NO',
      ];
    }

    const headerFields = await this.detectCsvFieldsFromHeader(rawPath);

    const lat = findFieldIgnoreCase(headerFields, LAT_NAMES);
    const lon = findFieldIgnoreCase(headerFields, LON_NAMES);
    if (lat && lon) {
      warnings.push(
        `Coordinate columns auto-detected: "${lon}" (longitude), "${lat}" (latitude).`,
      );
      return [
        `X_POSSIBLE_NAMES=${lon}`,
        `Y_POSSIBLE_NAMES=${lat}`,
        'KEEP_GEOM_COLUMNS=NO',
      ];
    }

    const x = findFieldIgnoreCase(headerFields, X_NAMES);
    const y = findFieldIgnoreCase(headerFields, Y_NAMES);
    if (x && y) {
      if (!upload.sourceCrs) {
        throw new GdalError(
          'X/Y coordinate columns were detected, but no sourceCrs was provided — X/Y coordinates are never assumed to be WGS84.',
        );
      }
      warnings.push(
        `Coordinate columns auto-detected: "${x}" (X), "${y}" (Y).`,
      );
      return [
        `X_POSSIBLE_NAMES=${x}`,
        `Y_POSSIBLE_NAMES=${y}`,
        'KEEP_GEOM_COLUMNS=NO',
      ];
    }

    throw new GdalError(
      'Could not detect latitude/longitude or X/Y columns in the CSV — specify latitudeField/longitudeField or xField/yField.',
    );
  }

  /** Cheap plain-attribute read of a CSV's header (no coordinate open
   *  options), used only to decide which columns to feed back into GDAL
   *  as X_POSSIBLE_NAMES/Y_POSSIBLE_NAMES for the real inspect/import. */
  private async detectCsvFieldsFromHeader(filePath: string): Promise<string[]> {
    const inspected = await this.gdal.inspect(filePath, {
      openOptions: ['KEEP_GEOM_COLUMNS=NO'],
    });
    return inspected.fields.map((f) => f.name);
  }

  private resolveSourceCrs(
    upload: GISLayerUpload,
    detectedEpsg: number | null,
  ): string | null {
    if (upload.sourceCrs) return upload.sourceCrs;
    if (upload.fileFormat === 'CSV') return 'EPSG:4326';
    if (detectedEpsg) return `EPSG:${detectedEpsg}`;
    return null;
  }

  private findShapefile(dir: string, files: string[]): string {
    const shpFiles = files.filter((f) => f.toLowerCase().endsWith('.shp'));
    if (shpFiles.length === 0) {
      throw new GdalError('ZIP archive does not contain a .shp file.');
    }
    if (shpFiles.length > 1) {
      throw new GdalError(
        'ZIP archive contains more than one Shapefile dataset — upload one logical Shapefile per file.',
      );
    }
    const shp = shpFiles[0];
    const base = shp.slice(0, -4).toLowerCase();
    const lowerFiles = files.map((f) => f.toLowerCase());
    for (const required of ['.shx', '.dbf']) {
      if (!lowerFiles.includes(`${base}${required}`)) {
        throw new GdalError(
          `ZIP archive is missing the required ${required} component of the Shapefile.`,
        );
      }
    }
    return path.join(dir, shp);
  }

  private detectFileFormat(
    originalFilename: string,
  ): 'SHAPEFILE_ZIP' | 'GEOJSON' | 'CSV' | null {
    const ext = path.extname(originalFilename).toLowerCase();
    if (ext === '.zip') return 'SHAPEFILE_ZIP';
    if (ext === '.geojson' || ext === '.json') return 'GEOJSON';
    if (ext === '.csv') return 'CSV';
    return null;
  }

  /**
   * Task 8 §5: uploading a NEW VERSION of an existing layer is governed by
   * the real UPLOAD permission grants on that layer — which can include a
   * cross-department grant, not just "your own department". Uploading
   * under a layer code that has never been published yet has no grants to
   * consult (no GISLayer/GISLayerPermission rows exist), so it falls back
   * to the §4 default: your own department only (or the Owner, any
   * department).
   */
  /** Task 8: resolves the effective permission set for approve/publish —
   *  the real per-layer grants once a GISLayer exists for this upload's
   *  layer code, or the virtual §4 defaults (scoped to the upload's own
   *  department) before it does. Centralizes the "layer might not exist
   *  yet" resolution used by both approve() and publish() (§10: don't
   *  duplicate authorization logic). */
  private async resolvePermissions(
    appUser: AppUser,
    upload: GISLayerUpload,
  ): Promise<Set<GisPermission>> {
    const existingLayer = await this.prisma.gISLayer.findUnique({
      where: {
        gisWorkspaceId_code: {
          gisWorkspaceId: upload.gisWorkspaceId,
          code: upload.layerCode,
        },
      },
    });
    if (existingLayer) {
      return this.gisAuth.getPermissions(appUser, existingLayer);
    }
    return this.gisAuth.getDefaultPermissions(
      appUser,
      upload.ownershipType,
      upload.departmentId,
    );
  }

  private async assertCanUpload(
    appUser: AppUser,
    dto: CreateUploadDto,
    gisWorkspaceId: string,
    layerCode: string,
  ): Promise<void> {
    if (dto.ownershipType === 'CANONICAL') {
      if (appUser.systemRole !== 'MUNICIPALITY_OWNER') {
        throw new ForbiddenException(
          'Only the municipality owner may create canonical layers.',
        );
      }
      if (dto.departmentId) {
        throw new BadRequestException(
          'Canonical layers must not have a department.',
        );
      }
      return;
    }

    if (!dto.departmentId) {
      throw new BadRequestException(
        'departmentId is required for department layers.',
      );
    }
    if (appUser.systemRole === 'MUNICIPALITY_OWNER') {
      return;
    }

    const existingLayer = await this.prisma.gISLayer.findUnique({
      where: { gisWorkspaceId_code: { gisWorkspaceId, code: layerCode } },
    });

    if (existingLayer) {
      const canUpload = await this.gisAuth.canUpload(appUser, existingLayer);
      if (!canUpload) {
        throw new ForbiddenException(
          'You do not have permission to upload to this layer.',
        );
      }
      return;
    }

    if (appUser.departmentId !== dto.departmentId) {
      throw new ForbiddenException(
        'You may only upload to your own department.',
      );
    }
  }

  private assertCanManage(
    appUser: AppUser,
    upload: { uploadedById: string },
  ): void {
    if (
      appUser.systemRole !== 'MUNICIPALITY_OWNER' &&
      upload.uploadedById !== appUser.id
    ) {
      throw new ForbiddenException(
        'You do not have permission to manage this upload.',
      );
    }
  }

  private async findScoped(uploadId: string, appUser: AppUser) {
    const upload = await this.prisma.gISLayerUpload.findFirst({
      where: { id: uploadId, municipalityId: appUser.municipalityId },
    });
    if (!upload) {
      throw new NotFoundException('Upload not found.');
    }
    if (
      appUser.systemRole !== 'MUNICIPALITY_OWNER' &&
      upload.uploadedById !== appUser.id &&
      upload.departmentId !== appUser.departmentId
    ) {
      throw new NotFoundException('Upload not found.');
    }
    return upload;
  }

  private async mustFind(uploadId: string): Promise<GISLayerUpload> {
    return this.prisma.gISLayerUpload.findUniqueOrThrow({
      where: { id: uploadId },
    });
  }

  private async ensureSpatialIndex(tableName: string): Promise<void> {
    if (!isSafeGeneratedTableName(tableName)) {
      throw new Error('Refusing to index an unsafe table name.');
    }
    await this.prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "${tableName}_geom_idx" ON "${tableName}" USING GIST ("geom")`,
    );
    const rows = await this.prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*)::bigint AS count FROM pg_indexes WHERE tablename = $1 AND indexname = $2`,
      tableName,
      `${tableName}_geom_idx`,
    );
    if (Number(rows[0]?.count ?? 0) === 0) {
      throw new Error('Spatial index could not be verified after creation.');
    }
  }

  private async checkGeometryValidity(
    tableName: string,
  ): Promise<{ invalidCount: number; emptyCount: number }> {
    if (!isSafeGeneratedTableName(tableName)) {
      throw new Error('Refusing to query an unsafe table name.');
    }
    const rows = await this.prisma.$queryRawUnsafe<
      { invalid_count: bigint; empty_count: bigint }[]
    >(
      `SELECT
         count(*) FILTER (WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom) AND NOT ST_IsValid(geom))::bigint AS invalid_count,
         count(*) FILTER (WHERE geom IS NULL OR ST_IsEmpty(geom))::bigint AS empty_count
       FROM "${tableName}"`,
    );
    return {
      invalidCount: Number(rows[0]?.invalid_count ?? 0),
      emptyCount: Number(rows[0]?.empty_count ?? 0),
    };
  }

  private async dropTableIfSafe(tableName: string): Promise<void> {
    if (!isSafeGeneratedTableName(tableName)) {
      this.logger.warn(`Refusing to drop unsafe table name "${tableName}".`);
      return;
    }
    await this.prisma
      .$executeRawUnsafe(`DROP TABLE IF EXISTS "${tableName}"`)
      .catch((error: Error) =>
        this.logger.warn(
          `Failed to drop old table "${tableName}": ${error.message}`,
        ),
      );
  }

  private previewLayerName(uploadId: string): string {
    return `preview_${uploadId.replace(/-/g, '')}`;
  }

  private async nextDisplayOrder(
    tx: Prisma.TransactionClient,
    gisWorkspaceId: string,
  ): Promise<number> {
    const max = await tx.gISLayer.aggregate({
      where: { gisWorkspaceId },
      _max: { displayOrder: true },
    });
    return (max._max.displayOrder ?? 0) + 1;
  }

  private datastoreConnection(): PostgisConnectionParams {
    return {
      host: this.config.getOrThrow<string>('POSTGIS_HOST'),
      port: this.config.getOrThrow<string>('POSTGIS_PORT'),
      database: this.config.getOrThrow<string>('POSTGIS_DATABASE'),
      user: this.config.getOrThrow<string>('POSTGIS_USER'),
      password: this.config.getOrThrow<string>('POSTGIS_PASSWORD'),
    };
  }

  private toResponse(
    upload: GISLayerUpload & {
      department?: { id: string; name: string } | null;
    },
  ) {
    return {
      id: upload.id,
      filename: upload.originalFilename,
      fileFormat: upload.fileFormat,
      fileSize: upload.fileSize,
      status: upload.status,
      layer: {
        name: upload.layerName,
        code: upload.layerCode,
        description: upload.description,
        ownershipType: upload.ownershipType,
        departmentId: upload.departmentId,
        departmentName: upload.department?.name ?? null,
      },
      validation: {
        valid: upload.status !== 'FAILED',
        featureCount: upload.featureCount,
        geometryType: upload.geometryType,
        sourceCrs: upload.sourceCrs,
        targetCrs: upload.targetCrs,
        summary: upload.validationSummary,
      },
      errorMessage: upload.errorMessage,
      review: {
        reviewedById: upload.reviewedById,
        reviewedAt: upload.reviewedAt,
        rejectionReason: upload.rejectionReason,
      },
      publish: {
        publishedById: upload.publishedById,
        publishedAt: upload.publishedAt,
        layerId: upload.layerId,
      },
      uploadedById: upload.uploadedById,
      createdAt: upload.createdAt,
      updatedAt: upload.updatedAt,
    };
  }
}
