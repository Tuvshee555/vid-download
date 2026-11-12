import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyToken } from '../auth';
import { LocalStorage, type DownloadClaims, type UploadClaims } from './local';
import { S3Storage, contentDisposition } from './s3';
import { isValidStorageKey, outputKey, uploadKey } from './types';

const SECRET = 'storage-test-secret-0123456789abcdef';
const ID = '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b';

describe('storage keys', () => {
  it('accepts only the two application shapes', () => {
    expect(isValidStorageKey(uploadKey(ID))).toBe(true);
    expect(isValidStorageKey(outputKey(ID, 'mp4'))).toBe(true);
  });

  it.each([
    '../etc/passwd',
    'uploads/../../etc/passwd',
    '/uploads/abc12345',
    'uploads/abc12345/extra',
    'outputs/abc12345',
    'outputs/abc12345/../x',
    'outputs/abc12345/out put.mp4',
    'other/abc12345',
    'uploads/ab',
    'uploads\\abc12345',
    '',
  ])('rejects %j', (key) => expect(isValidStorageKey(key)).toBe(false));
});

describe('LocalStorage', () => {
  let dir: string;
  let scratch: string;
  let storage: LocalStorage;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vd-store-'));
    scratch = await mkdtemp(join(tmpdir(), 'vd-scratch-'));
    storage = new LocalStorage({ dir, apiPublicUrl: 'http://api.test', signingSecret: SECRET });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });

  it('puts, heads, reads back and deletes an object', async () => {
    const source = join(scratch, 'in.bin');
    await writeFile(source, 'hello world');
    const key = outputKey(ID, 'mp3');

    const stored = await storage.putFile(key, source, { contentType: 'audio/mpeg' });
    expect(stored.size).toBe(11);
    expect(await storage.head(key)).toMatchObject({ key, size: 11 });

    const copy = join(scratch, 'out.bin');
    await storage.getToFile(key, copy);
    expect(await readFile(copy, 'utf8')).toBe('hello world');

    await storage.delete(key);
    expect(await storage.head(key)).toBeNull();
    // the empty per-job directory is removed too
    await expect(stat(join(dir, 'outputs', ID))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports NOT_FOUND for a missing object and enforces maxBytes', async () => {
    await expect(storage.getToFile(uploadKey(ID), join(scratch, 'x'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const source = join(scratch, 'big.bin');
    await writeFile(source, Buffer.alloc(2000));
    await storage.putFile(uploadKey(ID), source, { contentType: 'video/mp4' });
    await expect(storage.getToFile(uploadKey(ID), join(scratch, 'y'), { maxBytes: 100 })).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });

  it('refuses keys that could escape the storage root', async () => {
    await expect(storage.head('../../etc/passwd')).rejects.toMatchObject({ code: 'STORAGE_FAILURE' });
    await expect(storage.delete('uploads/../../x')).rejects.toMatchObject({ code: 'STORAGE_FAILURE' });
    expect(() => storage.pathFor('/etc/passwd')).toThrow();
  });

  it('lists objects with timestamps for the expiry sweep', async () => {
    const source = join(scratch, 'a.bin');
    await writeFile(source, 'x');
    await storage.putFile(outputKey(ID, 'mp4'), source, { contentType: 'video/mp4' });
    await storage.putFile(uploadKey(ID), source, { contentType: 'video/mp4' });
    const outputs = await storage.list('outputs/');
    expect(outputs.map((o) => o.key)).toEqual([outputKey(ID, 'mp4')]);
    expect(Date.now() - outputs[0]!.lastModified.getTime()).toBeLessThan(10_000);
    expect(await storage.list('uploads/')).toHaveLength(1);
    expect(await storage.list('nothing/')).toEqual([]);
  });

  it('mints a download link whose token carries key, name and expiry', async () => {
    const { url, expiresAt } = await storage.createDownloadUrl(outputKey(ID, 'mp4'), {
      filename: 'My Video.mp4',
      contentType: 'video/mp4',
      ttlSeconds: 120,
    });
    expect(url.startsWith('http://api.test/v1/files/')).toBe(true);
    const token = url.replace('http://api.test/v1/files/', '');
    const verified = verifyToken<DownloadClaims>(token, SECRET, 'download');
    expect(verified).toMatchObject({ ok: true, payload: { k: outputKey(ID, 'mp4'), fn: 'My Video.mp4', ct: 'video/mp4' } });
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 100_000);
  });

  it('mints an upload ticket bound to the declared size', async () => {
    const ticket = await storage.createUploadTicket(uploadKey(ID), { size: 5000, contentType: 'video/mp4', ttlSeconds: 300 });
    expect(ticket.method).toBe('PUT');
    const token = ticket.url.replace('http://api.test/v1/uploads/', '');
    expect(verifyToken<UploadClaims>(token, SECRET, 'upload')).toMatchObject({ ok: true, payload: { k: uploadKey(ID), sz: 5000 } });
  });

  it('cannot mint links without signing configuration (worker mode)', async () => {
    const workerStorage = new LocalStorage({ dir });
    await expect(workerStorage.createDownloadUrl(outputKey(ID, 'mp4'), { filename: 'a', contentType: 'video/mp4', ttlSeconds: 60 })).rejects.toMatchObject({
      code: 'INTERNAL',
    });
  });

  it('streams uploads to disk with a size cap and exact-size check', async () => {
    const info = await storage.writeFromStream(uploadKey(ID), Readable.from([Buffer.alloc(1000, 1)]), { maxBytes: 5000, expectedBytes: 1000 });
    expect(info.size).toBe(1000);

    const other = '4a2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b';
    await expect(
      storage.writeFromStream(uploadKey(other), Readable.from([Buffer.alloc(9000)]), { maxBytes: 5000 }),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(await storage.head(uploadKey(other))).toBeNull();

    const third = '5a2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b';
    await expect(
      storage.writeFromStream(uploadKey(third), Readable.from([Buffer.alloc(10)]), { maxBytes: 5000, expectedBytes: 20 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await storage.head(uploadKey(third))).toBeNull();
  });
});

describe('S3Storage (offline presigning)', () => {
  const storage = new S3Storage({
    bucket: 'test-bucket',
    region: 'auto',
    endpoint: 'https://acct123.r2.cloudflarestorage.com',
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'secret-example-secret-example',
  });

  it('presigns an expiring download URL with an attachment filename', async () => {
    const { url, expiresAt } = await storage.createDownloadUrl(outputKey(ID, 'mp4'), {
      filename: 'Хөгжим 🎵.mp4',
      contentType: 'video/mp4',
      ttlSeconds: 300,
    });
    const parsed = new URL(url);
    expect(parsed.hostname).toContain('r2.cloudflarestorage.com');
    expect(parsed.pathname).toContain(`outputs/${ID}/output.mp4`);
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(parsed.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.searchParams.get('response-content-disposition')).toContain('attachment;');
    expect(parsed.searchParams.get('response-content-type')).toBe('video/mp4');
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(url).not.toContain('secret-example');
  });

  it('presigns an upload URL that signs the content headers', async () => {
    const ticket = await storage.createUploadTicket(uploadKey(ID), { size: 4096, contentType: 'video/mp4', ttlSeconds: 600 });
    const parsed = new URL(ticket.url);
    expect(ticket.method).toBe('PUT');
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(parsed.searchParams.get('X-Amz-SignedHeaders') ?? '').toContain('content-length');
    expect(ticket.headers['Content-Type']).toBe('video/mp4');
  });

  it('refuses invalid keys before touching the network', async () => {
    await expect(storage.createDownloadUrl('../x', { filename: 'a', contentType: 'a/b', ttlSeconds: 60 })).rejects.toMatchObject({
      code: 'STORAGE_FAILURE',
    });
  });

  it('encodes Content-Disposition for non-ASCII and quote characters', () => {
    const header = contentDisposition('Хөгжим "live".mp3');
    expect(header).toContain('attachment;');
    expect(header).toMatch(/filename="[\x20-\x7e]+"/);
    expect(header).toContain("filename*=UTF-8''");
    expect(header).not.toMatch(/filename="[^"]*"[^;]*"/);
  });
});
