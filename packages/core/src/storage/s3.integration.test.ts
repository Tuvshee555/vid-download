/**
 * S3Storage against a real S3-compatible server (MinIO, SeaweedFS, LocalStack, or an R2 bucket).
 *
 *   S3_TEST_ENDPOINT=http://127.0.0.1:9100 S3_TEST_ACCESS_KEY=... S3_TEST_SECRET_KEY=... \
 *   S3_TEST_BUCKET=mediadock-test npm run test -w @vd/core
 *
 * Skipped unless S3_TEST_ENDPOINT is set. The bucket is created if it does not exist.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3Storage } from './s3';
import { outputKey, uploadKey } from './types';

const endpoint = process.env.S3_TEST_ENDPOINT;
const bucket = process.env.S3_TEST_BUCKET ?? 'mediadock-test';
const accessKeyId = process.env.S3_TEST_ACCESS_KEY ?? '';
const secretAccessKey = process.env.S3_TEST_SECRET_KEY ?? '';

describe.skipIf(!endpoint)('S3Storage against a real S3-compatible server', () => {
  let storage: S3Storage;
  let dir: string;
  const sha = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vd-s3-test-'));
    const admin = new S3Client({ region: 'auto', endpoint, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });
    try {
      await admin.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      await admin.send(new CreateBucketCommand({ Bucket: bucket }));
    }
    storage = new S3Storage({ bucket, region: 'auto', endpoint, accessKeyId, secretAccessKey, forcePathStyle: true });
  }, 60_000);

  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('uploads a large file with multipart, reads it back identically, lists and deletes it', async () => {
    const id = randomUUID();
    const key = outputKey(id, 'mp4');
    const payload = randomBytes(21 * 1024 * 1024); // > 2 parts of 8 MiB → exercises multipart upload
    const source = join(dir, 'big.bin');
    await writeFile(source, payload);

    const stored = await storage.putFile(key, source, { contentType: 'video/mp4' });
    expect(stored.size).toBe(payload.length);

    expect(await storage.head(key)).toMatchObject({ key, size: payload.length });
    const listed = await storage.list(`outputs/${id}/`);
    expect(listed.map((o) => o.key)).toEqual([key]);
    expect(Date.now() - listed[0]!.lastModified.getTime()).toBeLessThan(5 * 60_000);

    const copy = join(dir, 'copy.bin');
    await storage.getToFile(key, copy);
    expect(sha(await readFile(copy))).toBe(sha(payload));

    await storage.delete(key);
    expect(await storage.head(key)).toBeNull();
    await expect(storage.getToFile(key, join(dir, 'gone.bin'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  }, 120_000);

  it('enforces maxBytes when reading', async () => {
    const key = uploadKey(randomUUID());
    const source = join(dir, 'small.bin');
    await writeFile(source, Buffer.alloc(5000, 1));
    await storage.putFile(key, source, { contentType: 'application/octet-stream' });
    await expect(storage.getToFile(key, join(dir, 'limited.bin'), { maxBytes: 100 })).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    await storage.delete(key);
  });

  it('serves a presigned download with an attachment filename, and the link expires', async () => {
    const key = outputKey(randomUUID(), 'mp3');
    const source = join(dir, 'dl.bin');
    const body = randomBytes(50_000);
    await writeFile(source, body);
    await storage.putFile(key, source, { contentType: 'audio/mpeg' });

    const { url } = await storage.createDownloadUrl(key, { filename: 'Хөгжим track.mp3', contentType: 'audio/mpeg', ttlSeconds: 60 });
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(response.headers.get('content-type')).toContain('audio/mpeg');
    expect(Buffer.from(await response.arrayBuffer()).equals(body)).toBe(true);

    const short = await storage.createDownloadUrl(key, { filename: 'x.mp3', contentType: 'audio/mpeg', ttlSeconds: 1 });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect((await fetch(short.url)).status).toBeGreaterThanOrEqual(400);

    const tampered = new URL(url);
    tampered.searchParams.set('X-Amz-Signature', '0'.repeat(64));
    expect((await fetch(tampered)).status).toBeGreaterThanOrEqual(400);

    await storage.delete(key);
  }, 60_000);

  it('accepts a browser-style presigned upload of exactly the declared bytes — and nothing else', async () => {
    const key = uploadKey(randomUUID());
    const body = randomBytes(30_000);
    const ticket = await storage.createUploadTicket(key, { size: body.length, contentType: 'video/mp4', ttlSeconds: 120 });

    const ok = await fetch(ticket.url, { method: 'PUT', body, headers: ticket.headers });
    expect(ok.status).toBe(200);
    expect((await storage.head(key))?.size).toBe(body.length);

    const otherKey = uploadKey(randomUUID());
    const otherTicket = await storage.createUploadTicket(otherKey, { size: body.length, contentType: 'video/mp4', ttlSeconds: 120 });
    const tooBig = await fetch(otherTicket.url, { method: 'PUT', body: Buffer.concat([body, Buffer.alloc(1000)]), headers: otherTicket.headers });
    expect(tooBig.status).toBeGreaterThanOrEqual(400);
    expect(await storage.head(otherKey)).toBeNull();

    // A ticket for one key can't be replayed against another.
    const wrongKeyUrl = ticket.url.replace(key, uploadKey(randomUUID()));
    expect((await fetch(wrongKeyUrl, { method: 'PUT', body, headers: ticket.headers })).status).toBeGreaterThanOrEqual(400);

    await storage.delete(key);
  }, 60_000);
});
