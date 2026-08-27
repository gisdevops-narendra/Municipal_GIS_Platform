import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { ConfigService } from '@nestjs/config';
import {
  StorageService,
  UnsafeArchiveError,
  UploadTooLargeError,
} from './storage.service';

const MUNICIPALITY_ID = '11111111-1111-1111-1111-111111111111';
const UPLOAD_ID = '22222222-2222-2222-2222-222222222222';

function configFor(rootDir: string, overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    GIS_UPLOAD_STORAGE_DIR: rootDir,
    GIS_UPLOAD_MAX_FILE_SIZE_MB: '500',
    GIS_UPLOAD_MAX_EXTRACTED_ZIP_SIZE_MB: '2000',
    GIS_UPLOAD_MAX_ZIP_FILE_COUNT: '100',
    ...overrides,
  };
  return {
    get: (key: string, fallback?: string) => values[key] ?? fallback,
  } as unknown as ConfigService;
}

describe('StorageService', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gis-storage-test-'));
  });

  afterEach(async () => {
    await fsp.rm(rootDir, { recursive: true, force: true });
  });

  describe('saveRawFile', () => {
    it('stores the file under a generated name, never the original filename', async () => {
      const service = new StorageService(configFor(rootDir));
      const { storedFilename, absolutePath } = await service.saveRawFile(
        MUNICIPALITY_ID,
        UPLOAD_ID,
        '../../etc/passwd.geojson',
        Buffer.from('{}'),
      );
      expect(storedFilename).not.toContain('passwd');
      expect(storedFilename).toMatch(/^[a-f0-9-]{36}\.geojson$/);
      expect(fs.existsSync(absolutePath)).toBe(true);
      expect(absolutePath.startsWith(path.resolve(rootDir))).toBe(true);
    });

    it('falls back to .bin for a disallowed/unknown extension', async () => {
      const service = new StorageService(configFor(rootDir));
      const { storedFilename } = await service.saveRawFile(
        MUNICIPALITY_ID,
        UPLOAD_ID,
        'payload.exe',
        Buffer.from('x'),
      );
      expect(storedFilename.endsWith('.bin')).toBe(true);
    });

    it('rejects a file larger than the configured limit', async () => {
      const service = new StorageService(
        configFor(rootDir, { GIS_UPLOAD_MAX_FILE_SIZE_MB: '0.00001' }),
      );
      await expect(
        service.saveRawFile(
          MUNICIPALITY_ID,
          UPLOAD_ID,
          'a.geojson',
          Buffer.from('x'.repeat(1000)),
        ),
      ).rejects.toBeInstanceOf(UploadTooLargeError);
    });
  });

  describe('extractZipSafely', () => {
    async function writeZip(build: (zip: AdmZip) => void): Promise<string> {
      const zip = new AdmZip();
      build(zip);
      const zipPath = path.join(rootDir, 'upload.zip');
      await fsp.writeFile(zipPath, zip.toBuffer());
      return zipPath;
    }

    it('extracts a normal flat set of files', async () => {
      const zipPath = await writeZip((zip) => {
        zip.addFile('roads.shp', Buffer.from('shp-data'));
        zip.addFile('roads.shx', Buffer.from('shx-data'));
        zip.addFile('roads.dbf', Buffer.from('dbf-data'));
      });
      const service = new StorageService(configFor(rootDir));
      const result = await service.extractZipSafely(
        zipPath,
        MUNICIPALITY_ID,
        UPLOAD_ID,
      );
      expect(result.files.sort()).toEqual([
        'roads.dbf',
        'roads.shp',
        'roads.shx',
      ]);
      expect(fs.existsSync(path.join(result.dir, 'roads.shp'))).toBe(true);
    });

    it('rejects a ZIP entry using path traversal ("../")', async () => {
      const zipPath = await writeZip((zip) => {
        // adm-zip's own addFile() normalizes away leading "../" segments
        // (it would silently store this as "etc/evil.txt"), which would
        // defeat the point of this test — set entryName directly after
        // adding, which (like a maliciously hand-crafted ZIP) bypasses
        // that normalization and preserves the literal traversal path in
        // the archive's central directory, same as a real attacker's tool
        // would produce.
        const entry = zip.addFile('placeholder.txt', Buffer.from('pwned'));
        entry.entryName = '../../../etc/evil.txt';
      });
      const service = new StorageService(configFor(rootDir));
      await expect(
        service.extractZipSafely(zipPath, MUNICIPALITY_ID, UPLOAD_ID),
      ).rejects.toBeInstanceOf(UnsafeArchiveError);
      expect(
        fs.existsSync(path.join(os.tmpdir(), '..', 'etc', 'evil.txt')),
      ).toBe(false);
    });

    it('flattens nested directory entries to basenames rather than following them', async () => {
      const zipPath = await writeZip((zip) => {
        zip.addFile('nested/dir/roads.shp', Buffer.from('data'));
      });
      const service = new StorageService(configFor(rootDir));
      const result = await service.extractZipSafely(
        zipPath,
        MUNICIPALITY_ID,
        UPLOAD_ID,
      );
      expect(result.files).toEqual(['roads.shp']);
      expect(fs.existsSync(path.join(result.dir, 'nested'))).toBe(false);
    });

    it('rejects more files than the configured maxZipFileCount', async () => {
      const zipPath = await writeZip((zip) => {
        for (let i = 0; i < 5; i++) {
          zip.addFile(`file-${i}.txt`, Buffer.from('x'));
        }
      });
      const service = new StorageService(
        configFor(rootDir, { GIS_UPLOAD_MAX_ZIP_FILE_COUNT: '3' }),
      );
      await expect(
        service.extractZipSafely(zipPath, MUNICIPALITY_ID, UPLOAD_ID),
      ).rejects.toBeInstanceOf(UnsafeArchiveError);
    });

    it('rejects when the declared uncompressed size exceeds the configured limit (zip-bomb guard)', async () => {
      const zipPath = await writeZip((zip) => {
        zip.addFile('big.txt', Buffer.alloc(10_000, 'a'));
      });
      const service = new StorageService(
        configFor(rootDir, {
          GIS_UPLOAD_MAX_EXTRACTED_ZIP_SIZE_MB: '0.000001',
        }),
      );
      await expect(
        service.extractZipSafely(zipPath, MUNICIPALITY_ID, UPLOAD_ID),
      ).rejects.toBeInstanceOf(UnsafeArchiveError);
    });

    it('rejects an empty archive', async () => {
      const zipPath = await writeZip(() => undefined);
      const service = new StorageService(configFor(rootDir));
      await expect(
        service.extractZipSafely(zipPath, MUNICIPALITY_ID, UPLOAD_ID),
      ).rejects.toBeInstanceOf(UnsafeArchiveError);
    });

    it('rejects a malformed (non-ZIP) file rather than crashing', async () => {
      const badPath = path.join(rootDir, 'not-a-zip.zip');
      await fsp.writeFile(badPath, 'this is not a zip file');
      const service = new StorageService(configFor(rootDir));
      await expect(
        service.extractZipSafely(badPath, MUNICIPALITY_ID, UPLOAD_ID),
      ).rejects.toBeInstanceOf(UnsafeArchiveError);
    });

    it('rejects two entries that collide once flattened to the same basename', async () => {
      const zipPath = await writeZip((zip) => {
        zip.addFile('a/roads.shp', Buffer.from('1'));
        zip.addFile('b/roads.shp', Buffer.from('2'));
      });
      const service = new StorageService(configFor(rootDir));
      await expect(
        service.extractZipSafely(zipPath, MUNICIPALITY_ID, UPLOAD_ID),
      ).rejects.toBeInstanceOf(UnsafeArchiveError);
    });
  });

  describe('tenant-path safety', () => {
    it('refuses a non-UUID-shaped municipality id rather than building a path from it', async () => {
      const service = new StorageService(configFor(rootDir));
      await expect(
        service.saveRawFile(
          '../../etc',
          UPLOAD_ID,
          'a.geojson',
          Buffer.from('x'),
        ),
      ).rejects.toThrow('Invalid municipality id.');
    });
  });
});
