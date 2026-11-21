import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import * as yauzl from 'yauzl';

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
  /** Data pulled from a user's database is written server-side straight to
   *  disk (never through the browser), so it gets its own, larger limit. */
  readonly maxExternalImportBytes: number;
  readonly maxExtractedZipBytes: number;
  readonly maxZipFileCount: number;

  constructor(private readonly config: ConfigService) {
    this.rootDir = path.resolve(
      this.config.get<string>('GIS_UPLOAD_STORAGE_DIR', './storage/uploads'),
    );
    this.maxUploadBytes =
      Number(this.config.get<string>('GIS_UPLOAD_MAX_FILE_SIZE_MB', '3072')) *
      1024 *
      1024;
    this.maxExternalImportBytes =
      Number(this.config.get<string>('EXTERNAL_DB_MAX_FILE_SIZE_MB', '30720')) * 1024 * 1024;
    this.maxExtractedZipBytes =
      Number(
        this.config.get<string>('GIS_UPLOAD_MAX_EXTRACTED_ZIP_SIZE_MB', '102400'),
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

  /** Like saveRawFile, but moves an already-written server-side file
   *  (an external-database extract) into raw/ instead of buffering it. */
  async saveRawFileFromPath(
    municipalityId: string,
    uploadId: string,
    originalFilename: string,
    sourcePath: string,
  ): Promise<{ storedFilename: string; absolutePath: string }> {
    const { size } = await fsp.stat(sourcePath);
    if (size > this.maxExternalImportBytes) {
      throw new UploadTooLargeError(
        `The data exceeds the ${Math.round(this.maxExternalImportBytes / 1024 / 1024)} MB import limit.`,
      );
    }
    const ext = this.safeExtension(originalFilename);
    const storedFilename = `${randomUUID()}${ext}`;
    const dir = this.rawDir(municipalityId, uploadId);
    await fsp.mkdir(dir, { recursive: true });
    const absolutePath = path.join(dir, storedFilename);
    try {
      await fsp.rename(sourcePath, absolutePath);
    } catch {
      // Different filesystem (tmp → storage volume): copy, then drop the source.
      await fsp.copyFile(sourcePath, absolutePath);
      await fsp.rm(sourcePath, { force: true });
    }
    return { storedFilename, absolutePath };
  }

  /**
   * Safely extracts a ZIP into a fresh temporary/<uploadId>/ directory.
   * Every entry is validated BEFORE anything is written — Task 7 §36:
   *
   * - rejects `../` / absolute-path entry names (zip-slip / path traversal)
   * - rejects symlink entries (detected from the entry's unix mode bits)
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
    // Streaming reader (yauzl): only the central directory is held in
    // memory and each entry is inflated straight to disk, so archives
    // larger than Node's 2 GiB Buffer limit (national road networks etc.)
    // work — adm-zip loaded the whole file into one Buffer and could not.
    let zip: yauzl.ZipFile;
    let entries: yauzl.Entry[];
    try {
      zip = await this.openZip(zipPath);
      entries = (await this.readZipEntries(zip)).filter(
        (entry) => !entry.fileName.endsWith('/'),
      );
    } catch (error) {
      throw this.toArchiveError(error);
    }

    try {
      return await this.extractEntries(
        zip,
        entries,
        municipalityId,
        uploadId,
      );
    } finally {
      zip.close();
    }
  }

  private async extractEntries(
    zip: yauzl.ZipFile,
    entries: yauzl.Entry[],
    municipalityId: string,
    uploadId: string,
  ): Promise<ExtractedZip> {
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
    const planned: { entry: yauzl.Entry; basename: string }[] = [];

    for (const entry of entries) {
      const entryName = entry.fileName;

      // Zip-slip: absolute paths or any ".." segment, checked on the raw
      // entry name (before any normalization can hide it).
      if (
        path.isAbsolute(entryName) ||
        entryName.split(/[/\\]/).includes('..')
      ) {
        throw new UnsafeArchiveError(`Unsafe path in archive: "${entryName}".`);
      }

      // Symlinks: unix permission bits live in the top 16 bits of
      // externalFileAttributes; 0o120000 is S_IFLNK. Never follow/extract
      // these — they could point outside the extraction directory.
      const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;

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

      totalUncompressed += entry.uncompressedSize;
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
          `Unsafe path in archive: "${entry.fileName}".`,
        );
      }
      // yauzl verifies the inflated byte count equals the declared
      // uncompressedSize (validateEntrySizes), so the size guard above
      // can't be bypassed by a lying header.
      try {
        const readStream = await this.openEntryStream(zip, entry);
        await pipeline(readStream, fs.createWriteStream(targetPath));
      } catch (error) {
        throw this.toArchiveError(error);
      }
      files.push(basename);
    }

    this.logger.log(
      `Safely extracted ${files.length} file(s) (${totalUncompressed} bytes) from upload ${uploadId}.`,
    );
    return { dir: destDir, files };
  }

  private openZip(zipPath: string): Promise<yauzl.ZipFile> {
    return new Promise((resolve, reject) => {
      yauzl.open(
        zipPath,
        { lazyEntries: true, autoClose: false },
        (error, zip) => (error || !zip ? reject(error) : resolve(zip)),
      );
    });
  }

  private readZipEntries(zip: yauzl.ZipFile): Promise<yauzl.Entry[]> {
    return new Promise((resolve, reject) => {
      const entries: yauzl.Entry[] = [];
      zip.on('entry', (entry: yauzl.Entry) => {
        entries.push(entry);
        zip.readEntry();
      });
      zip.once('end', () => resolve(entries));
      zip.once('error', reject);
      zip.readEntry();
    });
  }

  private openEntryStream(
    zip: yauzl.ZipFile,
    entry: yauzl.Entry,
  ): Promise<NodeJS.ReadableStream> {
    return new Promise((resolve, reject) => {
      zip.openReadStream(entry, (error, stream) =>
        error || !stream ? reject(error) : resolve(stream),
      );
    });
  }

  /** yauzl rejects "../" and absolute entry names itself while reading the
   *  central directory — report those as the same "Unsafe path" error. */
  private toArchiveError(error: unknown): UnsafeArchiveError {
    if (error instanceof UnsafeArchiveError) return error;
    const message = (error as Error)?.message ?? String(error);
    if (/invalid relative path|absolute path/i.test(message)) {
      return new UnsafeArchiveError(`Unsafe path in archive: ${message}`);
    }
    return new UnsafeArchiveError(`Could not read ZIP archive: ${message}`);
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

  /** Permanently removes every file kept for one upload — the original
   *  file under raw/ and any extracted contents under temporary/. Used
   *  when the layer an upload produced is deleted (Task 8): nothing
   *  references those files any more. Best-effort per directory. */
  async deleteUploadFiles(
    municipalityId: string,
    uploadId: string,
  ): Promise<void> {
    await Promise.all([
      fsp.rm(this.rawDir(municipalityId, uploadId), {
        recursive: true,
        force: true,
      }),
      fsp.rm(this.temporaryDir(municipalityId, uploadId), {
        recursive: true,
        force: true,
      }),
    ]);
  }

  /** Removes every file stored for one account's workspace (account
   *  deletion). Best-effort, idempotent. */
  async deleteTenantFiles(municipalityId: string): Promise<void> {
    await fsp.rm(this.tenantPath(municipalityId), { recursive: true, force: true });
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
