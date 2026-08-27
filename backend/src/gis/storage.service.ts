import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import AdmZip from 'adm-zip';

export class UploadTooLargeError extends Error {}
export class UnsafeArchiveError extends Error {}

export interface ExtractedZip {
  /** Absolute directory the ZIP was safely extracted into. */
  dir: string;
  /** Basenames of every file actually extracted (flat — see extractZip). */
  files: string[];
}

/**
 * Owns everything about WHERE uploaded GIS files live on disk and how a
 * ZIP is safely extracted. No GDAL/OGR logic here (see GdalService) — this
 * is purely filesystem safety: directory layout, filename sanitization,
 * and ZIP-bomb / path-traversal / symlink defenses (Task 7 §34, §36).
 *
 * Layout: <GIS_UPLOAD_STORAGE_DIR>/<municipalityId>/{raw,temporary,processed}/<uploadId>/...
 * — tenant-aware by construction (every path is built from a
 * server-derived municipalityId, never client input) and per-upload, so
 * one upload's files can never collide with or overwrite another's.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly rootDir: string;
  readonly maxUploadBytes: number;
  readonly maxExtractedZipBytes: number;
  readonly maxZipFileCount: number;

  constructor(private readonly config: ConfigService) {
    this.rootDir = path.resolve(
      this.config.get<string>('GIS_UPLOAD_STORAGE_DIR', './storage/uploads'),
    );
    this.maxUploadBytes =
      Number(this.config.get<string>('GIS_UPLOAD_MAX_FILE_SIZE_MB', '500')) *
      1024 *
      1024;
    this.maxExtractedZipBytes =
      Number(
        this.config.get<string>('GIS_UPLOAD_MAX_EXTRACTED_ZIP_SIZE_MB', '2000'),
      ) *
      1024 *
      1024;
    this.maxZipFileCount = Number(
      this.config.get<string>('GIS_UPLOAD_MAX_ZIP_FILE_COUNT', '100'),
    );
  }

  /** Base "raw/<uploadId>" directory for one upload's original file(s). */
  rawDir(municipalityId: string, uploadId: string): string {
    return this.tenantPath(municipalityId, 'raw', uploadId);
  }

  /** Base "temporary/<uploadId>" directory — extracted ZIP contents, etc.
   *  Safe to delete entirely once validation/import has finished with it
   *  (see UploadsService cleanup). */
  temporaryDir(municipalityId: string, uploadId: string): string {
    return this.tenantPath(municipalityId, 'temporary', uploadId);
  }

  /** Writes the originally uploaded file under raw/ with a generated,
   *  filesystem-safe name — the user's original filename is preserved
   *  only in the database (GISLayerUpload.originalFilename) for display,
   *  never used to build a path. Returns the stored filename and the
   *  absolute path it was written to. */
  async saveRawFile(
    municipalityId: string,
    uploadId: string,
    originalFilename: string,
    buffer: Buffer,
  ): Promise<{ storedFilename: string; absolutePath: string }> {
    if (buffer.length > this.maxUploadBytes) {
      throw new UploadTooLargeError(
        `File exceeds the maximum upload size of ${Math.round(this.maxUploadBytes / 1024 / 1024)} MB.`,
      );
    }
    const ext = this.safeExtension(originalFilename);
    const storedFilename = `${randomUUID()}${ext}`;
    const dir = this.rawDir(municipalityId, uploadId);
    await fsp.mkdir(dir, { recursive: true });
    const absolutePath = path.join(dir, storedFilename);
    await fsp.writeFile(absolutePath, buffer);
    return { storedFilename, absolutePath };
  }

  /**
   * Safely extracts a ZIP into a fresh temporary/<uploadId>/ directory.
   * Every entry is validated BEFORE anything is written — Task 7 §36:
   *
   * - rejects `../` / absolute-path entry names (zip-slip / path traversal)
   * - rejects symlink entries (adm-zip exposes the external attributes we
   *   need to detect these)
   * - rejects more than `maxZipFileCount` entries
   * - rejects if the sum of uncompressed entry sizes would exceed
   *   `maxExtractedZipBytes` (a cheap, effective zip-bomb guard — checked
   *   against the archive's own declared sizes before extracting, and
   *   every extracted file's declared size is used, not re-trusted after
   *   the fact)
   * - flattens output (basenames only): shapefile datasets are expected
   *   to be one flat set of sibling files (Task 7 §5), so this also
   *   incidentally neutralizes any directory-structure trickery
   *
   * The whole ZIP is rejected (nothing written) if any single entry fails
   * a check — never a partial, silently-truncated extraction.
   */
  async extractZipSafely(
    zipPath: string,
    municipalityId: string,
    uploadId: string,
  ): Promise<ExtractedZip> {
    let zip: AdmZip;
    try {
      zip = new AdmZip(zipPath);
    } catch (error) {
      throw new UnsafeArchiveError(
        `Could not read ZIP archive: ${(error as Error).message}`,
      );
    }

    const entries = zip.getEntries().filter((entry) => !entry.isDirectory);
    if (entries.length === 0) {
      throw new UnsafeArchiveError('ZIP archive contains no files.');
    }
    if (entries.length > this.maxZipFileCount) {
      throw new UnsafeArchiveError(
        `ZIP contains ${entries.length} files, exceeding the limit of ${this.maxZipFileCount}.`,
      );
    }

    const seenBasenames = new Set<string>();
    let totalUncompressed = 0;
    const planned: { entry: (typeof entries)[number]; basename: string }[] = [];

    for (const entry of entries) {
      const entryName = entry.entryName;

      // Zip-slip: absolute paths or any ".." segment, checked on the raw
      // entry name (before any normalization can hide it).
      if (
        path.isAbsolute(entryName) ||
        entryName.split(/[/\\]/).includes('..')
      ) {
        throw new UnsafeArchiveError(`Unsafe path in archive: "${entryName}".`);
      }

      // Symlinks: adm-zip stores unix permission bits in the top 16 bits
      // of externalAttributes; 0o120000 is S_IFLNK. Never follow/extract
      // these — they could point outside the extraction directory.
      const unixMode = (entry.header.attr >>> 16) & 0xffff;

      if ((unixMode & 0o170000) === 0o120000) {
        throw new UnsafeArchiveError(
          `Archive entry "${entryName}" is a symlink, which is not allowed.`,
        );
      }

      const basename = path.basename(entryName);
      if (!basename || basename === '.' || basename === '..') {
        throw new UnsafeArchiveError(`Unsafe path in archive: "${entryName}".`);
      }
      if (seenBasenames.has(basename.toLowerCase())) {
        throw new UnsafeArchiveError(
          `Archive contains two entries with the same filename "${basename}" once flattened.`,
        );
      }
      seenBasenames.add(basename.toLowerCase());

      totalUncompressed += entry.header.size;
      if (totalUncompressed > this.maxExtractedZipBytes) {
        throw new UnsafeArchiveError(
          `Extracted archive size exceeds the limit of ${Math.round(this.maxExtractedZipBytes / 1024 / 1024)} MB.`,
        );
      }

      planned.push({ entry, basename });
    }

    const destDir = this.temporaryDir(municipalityId, uploadId);
    await fsp.mkdir(destDir, { recursive: true });
    const resolvedDestDir = path.resolve(destDir) + path.sep;

    const files: string[] = [];
    for (const { entry, basename } of planned) {
      const targetPath = path.resolve(destDir, basename);
      // Defense in depth: re-verify the resolved target is still inside
      // destDir even though basename-only construction should guarantee
      // it already (belt-and-braces against any path library surprise).
      if (!targetPath.startsWith(resolvedDestDir)) {
        throw new UnsafeArchiveError(
          `Unsafe path in archive: "${entry.entryName}".`,
        );
      }
      await fsp.writeFile(targetPath, entry.getData());
      files.push(basename);
    }

    this.logger.log(
      `Safely extracted ${files.length} file(s) (${totalUncompressed} bytes) from upload ${uploadId}.`,
    );
    return { dir: destDir, files };
  }

  /** Deletes an upload's temporary/ directory (extracted ZIP contents) —
   *  called once validation/import has finished with it. Never touches
   *  raw/ (the original uploaded file is retained per Task 7 §35). */
  async cleanupTemporary(
    municipalityId: string,
    uploadId: string,
  ): Promise<void> {
    const dir = this.temporaryDir(municipalityId, uploadId);
    await fsp.rm(dir, { recursive: true, force: true });
  }

  fileExists(absolutePath: string): boolean {
    return fs.existsSync(absolutePath);
  }

  private tenantPath(municipalityId: string, ...segments: string[]): string {
    // municipalityId is always a server-derived UUID (AppUser.municipalityId
    // from the JWT-resolved user) — never client input — but validated
    // defensively anyway before it becomes part of a filesystem path.
    if (!/^[a-f0-9-]{36}$/i.test(municipalityId)) {
      throw new Error('Invalid municipality id.');
    }
    return path.join(this.rootDir, municipalityId, ...segments);
  }

  /** Whitelist-only: an uploaded file's extension is untrusted input, so
   *  only a small set of expected extensions is ever preserved on disk —
   *  anything else (including no extension, or something like ".php")
   *  becomes ".bin", which is never executed or interpreted by anything. */
  private safeExtension(originalFilename: string): string {
    const ext = path.extname(originalFilename).toLowerCase();
    const allowed = new Set(['.zip', '.geojson', '.json', '.csv']);
    return allowed.has(ext) ? ext : '.bin';
  }
}
