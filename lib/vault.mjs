// CR-2026-0027 - encryption for the status data (AES-256-GCM).
// One random data key (STATUS_DATA_KEY, base64, 32 bytes) encrypts every data file.
// The page gets the data key by unwrapping kdf.json with the viewer's password
// (PBKDF2-SHA256 -> AES-256-GCM key). Output format matches WebCrypto: ciphertext || 16-byte tag.
// The file name is bound as additional data, so encrypted files cannot be swapped.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export function dataKey() {
  const b64 = process.env.STATUS_DATA_KEY;
  if (!b64) throw new Error('STATUS_DATA_KEY is not set');
  const k = Buffer.from(b64, 'base64');
  if (k.length !== 32) throw new Error('STATUS_DATA_KEY must be 32 bytes (base64)');
  return k;
}

export function seal(key, plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(Buffer.from(plaintext)), c.final(), c.getAuthTag()]);
  return { v: 1, alg: 'A256GCM', iv: iv.toString('base64'), ct: ct.toString('base64') };
}

export function open(key, env, aad) {
  const iv = Buffer.from(env.iv, 'base64');
  const all = Buffer.from(env.ct, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  if (aad) d.setAAD(Buffer.from(aad));
  d.setAuthTag(all.subarray(all.length - 16));
  return Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]).toString('utf8');
}

// The additional data is the path relative to data/, with forward slashes (e.g. "runs/2026-10-11.enc").
const aadOf = (file) => path.relative('data', file).split(path.sep).join('/');

export async function readEnc(key, file, fallback) {
  try { return open(key, JSON.parse(await fs.readFile(file, 'utf8')), aadOf(file)); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
export async function writeEnc(key, file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(seal(key, text, aadOf(file))) + '\n');
}

// Wrap the data key with a password (for kdf.json).
export function wrapKey(dek, password, iterations = 600000, version = 1) {
  const salt = crypto.randomBytes(16);
  const kek = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  return { v: 1, version, kdf: 'PBKDF2-SHA256', iterations, salt: salt.toString('base64'), wrapped: seal(kek, dek, 'dmlrd-status-key'), updated: new Date().toISOString() };
}
export function unwrapKey(kdf, password) {
  const kek = crypto.pbkdf2Sync(password, Buffer.from(kdf.salt, 'base64'), kdf.iterations, 32, 'sha256');
  const iv = Buffer.from(kdf.wrapped.iv, 'base64'); const all = Buffer.from(kdf.wrapped.ct, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', kek, iv); d.setAAD(Buffer.from('dmlrd-status-key')); d.setAuthTag(all.subarray(all.length - 16));
  return Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]);
}
