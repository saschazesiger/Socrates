import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { config } from './config.js';

const s3 = new S3Client({
  region: config.s3.region,
  endpoint: config.s3.endpoint,
  forcePathStyle: Boolean(config.s3.endpoint), // needed for MinIO/R2-style endpoints
  credentials: {
    accessKeyId: config.s3.accessKeyId,
    secretAccessKey: config.s3.secretAccessKey,
  },
});

function fullKey(key) {
  return config.s3.prefix ? `${config.s3.prefix}/${key}` : key;
}

/** Returns the object body as a string, or null if the key does not exist. */
export async function s3Get(key) {
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: config.s3.bucket, Key: fullKey(key) })
    );
    return await res.Body.transformToString('utf-8');
  } catch (err) {
    if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw err;
  }
}

export async function s3Put(key, body) {
  await s3.send(
    new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: fullKey(key),
      Body: body,
      ContentType: key.endsWith('.json') || key.endsWith('.jsonl')
        ? 'application/json'
        : 'text/plain; charset=utf-8',
    })
  );
}

/** Deletes an object. A missing key is treated as success (idempotent). */
export async function s3Delete(key) {
  try {
    await s3.send(
      new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: fullKey(key) })
    );
  } catch (err) {
    if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return;
    throw err;
  }
}

/**
 * Lists object keys under `prefix` (relative to S3_PREFIX), with the configured
 * prefix stripped back off so callers see the same keys they pass to get/put.
 */
export async function s3List(prefix = '') {
  const base = config.s3.prefix ? `${config.s3.prefix}/` : '';
  const keys = [];
  let ContinuationToken;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: config.s3.bucket,
        Prefix: fullKey(prefix),
        ContinuationToken,
      })
    );
    for (const obj of res.Contents ?? []) {
      keys.push(base && obj.Key.startsWith(base) ? obj.Key.slice(base.length) : obj.Key);
    }
    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return keys;
}
