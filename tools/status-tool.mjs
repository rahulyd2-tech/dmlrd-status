// CR-2026-0027 - admin tool for the encrypted status data. Runs on XTREME2 (or anywhere with the key).
// Needs STATUS_DATA_KEY in the environment (D:\monitoring\secrets\status-page.env); set-password also
// needs STATUS_PASSWORD. Never commit sites.json or any decrypted output.
//
//   node tools/status-tool.mjs sites-decrypt          data/sites.enc -> sites.json (git-ignored) to edit
//   node tools/status-tool.mjs sites-encrypt          sites.json -> data/sites.enc
//   node tools/status-tool.mjs set-password           wrap the data key with STATUS_PASSWORD -> kdf.json (version + 1);
//                                                     devices that stayed signed in are signed out
//   node tools/status-tool.mjs show <file.enc>        print a decrypted file (e.g. data/events.enc)
//   node tools/status-tool.mjs verify-events          check the SHA-256 chain in data/events.enc
//   node tools/status-tool.mjs migrate <old-data-dir> encrypt the plain CR-2026-0024 data into data/
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataKey, readEnc, writeEnc, wrapKey, unwrapKey } from '../lib/vault.mjs';

const [cmd, arg] = process.argv.slice(2);
const KEY = dataKey();

if (cmd === 'sites-decrypt') {
  await fs.writeFile('sites.json', JSON.stringify(JSON.parse(await readEnc(KEY, 'data/sites.enc')), null, 2) + '\n');
  console.log('sites.json written (do not commit it)');
} else if (cmd === 'sites-encrypt') {
  const s = JSON.parse(await fs.readFile('sites.json', 'utf8'));
  if (!Array.isArray(s.checks) || !s.checks.every((c) => c.id && c.url && c.group && c.expect?.status)) throw new Error('sites.json is missing fields');
  await writeEnc(KEY, 'data/sites.enc', JSON.stringify(s));
  console.log(`data/sites.enc written (${s.checks.length} checks)`);
} else if (cmd === 'set-password') {
  const pw = process.env.STATUS_PASSWORD; if (!pw || pw.length < 12) throw new Error('STATUS_PASSWORD must be set (12+ characters)');
  let version = 1; try { version = JSON.parse(await fs.readFile('kdf.json', 'utf8')).version + 1; } catch {}
  const kdf = wrapKey(KEY, pw, 600000, version);
  if (!unwrapKey(kdf, pw).equals(KEY)) throw new Error('self-test failed');
  await fs.writeFile('kdf.json', JSON.stringify(kdf, null, 1) + '\n');
  console.log(`kdf.json written, version ${version}`);
} else if (cmd === 'show') {
  process.stdout.write(await readEnc(KEY, arg));
} else if (cmd === 'verify-events') {
  let p = '0'.repeat(64), n = 0;
  for (const l of (await readEnc(KEY, 'data/events.enc', '')).trim().split('\n').filter(Boolean)) {
    const o = JSON.parse(l), h = o.hash; delete o.hash;
    if (o.prev !== p || crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex') !== h) { console.error(`chain BROKEN at entry ${n} (${o.ts})`); process.exit(1); }
    p = h; n++;
  }
  console.log(`events chain OK, ${n} entries, head ${p.slice(0, 12)}`);
} else if (cmd === 'migrate') {
  const src = arg;
  const plain = async (f) => fs.readFile(path.join(src, f), 'utf8').catch(() => null);
  for (const [from, to] of [['state.json', 'state.enc'], ['daily.json', 'daily.enc'], ['latest.json', 'latest.enc'], ['events.jsonl', 'events.enc']]) {
    const t = await plain(from); if (t !== null) { await writeEnc(KEY, `data/${to}`, from.endsWith('.json') ? JSON.stringify(JSON.parse(t)) : t); console.log(`${from} -> data/${to}`); }
  }
  const runs = await fs.readdir(path.join(src, 'runs')).catch(() => []);
  for (const r of runs.filter((x) => x.endsWith('.jsonl'))) await writeEnc(KEY, `data/runs/${r.replace(/\.jsonl$/, '.enc')}`, await plain(path.join('runs', r)));
  console.log(`${runs.length} daily run files migrated`);
} else {
  console.log('usage: sites-decrypt | sites-encrypt | set-password | show <file.enc> | verify-events | migrate <old-data-dir>');
  process.exit(2);
}
