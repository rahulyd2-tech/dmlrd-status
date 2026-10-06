// DMLRD outside health check - CR-2026-0024.
// Runs on GitHub Actions (never on XTREME2), so it still works when our own server is down.
// Reads sites.json, checks every site, keeps state in data/, opens/closes GitHub issues on outages
// and sends WhatsApp for server-wide outages and for sites not hosted on XTREME2.
// No npm dependencies (Node 22 built-ins only).
import fs from 'node:fs/promises';
import tls from 'node:tls';
import crypto from 'node:crypto';

const DRY = process.argv.includes('--dry-run');
const cfg = JSON.parse(await fs.readFile('sites.json', 'utf8'));
const R = cfg.rules;
const now = new Date();
const iso = now.toISOString();
const today = iso.slice(0, 10);
const RUN_URL = process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : null;
const UA = 'DMLRD-Status-Check/1.0 (+https://status.dmlrd.tech)';

await fs.mkdir('data/runs', { recursive: true });
const readJson = async (p, d) => { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return d; } };
const state = await readJson('data/state.json', { checks: {}, server: {} });
const daily = await readJson('data/daily.json', { checks: {} });

// ---------- plain-language errors (owner asked for no jargon) ----------
function plain(e) {
  const code = e?.cause?.code || e?.cause?.errors?.[0]?.code || e?.code || '';
  const name = e?.name || '';
  if (name === 'TimeoutError' || name === 'AbortError' || /TIMEOUT/.test(code)) return `No answer within ${R.timeoutMs / 1000} seconds`;
  if (code === 'ECONNREFUSED') return 'The server refused the connection';
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return 'The connection was cut off';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'The web address could not be found (DNS problem)';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'The server cannot be reached';
  if (code === 'CERT_HAS_EXPIRED') return 'The security certificate has expired';
  if (/CERT|SSL|TLS|SIGNATURE|ALTNAME/.test(code)) return 'Security certificate problem';
  return `Could not connect (${code || e?.message || 'unknown error'})`;
}

async function probeHttp(c) {
  const t0 = performance.now();
  try {
    const r = await fetch(c.url, { redirect: 'manual', signal: AbortSignal.timeout(R.timeoutMs), headers: { 'user-agent': UA } });
    const ms = Math.round(performance.now() - t0);
    const body = c.expect.bodyIncludes ? await r.text() : (await r.body?.cancel(), '');
    if (!c.expect.status.includes(r.status)) return { ok: false, status: r.status, ms, error: `Unexpected answer from the server (code ${r.status})` };
    if (c.expect.bodyIncludes && !body.includes(c.expect.bodyIncludes)) return { ok: false, status: r.status, ms, error: 'The page content is not what we expect' };
    return { ok: true, status: r.status, ms };
  } catch (e) {
    return { ok: false, status: null, ms: Math.round(performance.now() - t0), error: plain(e) };
  }
}

function probeCert(host) {
  return new Promise((resolve) => {
    const s = tls.connect({ host, port: 443, servername: host, timeout: 10000 }, () => {
      const pc = s.getPeerCertificate();
      s.end();
      resolve({ days: pc?.valid_to ? Math.floor((new Date(pc.valid_to) - Date.now()) / 864e5) : null, validTo: pc?.valid_to ? new Date(pc.valid_to).toISOString().slice(0, 10) : null });
    });
    s.on('error', () => resolve({ days: null }));
    s.on('timeout', () => { s.destroy(); resolve({ days: null }); });
  });
}

async function check(c) {
  let r = await probeHttp(c);
  if (!r.ok) { await new Promise((z) => setTimeout(z, 5000)); const again = await probeHttp(c); if (again.ok) r = { ...again, retried: true }; }
  const cert = await probeCert(new URL(c.url).hostname);
  const warn = [];
  if (r.ok && r.ms > R.slowMs) warn.push(`Very slow (${(r.ms / 1000).toFixed(1)} s)`);
  if (cert.days !== null && cert.days < R.certWarnDays) warn.push(`Security certificate ends in ${cert.days} days`);
  return { ...r, certDays: cert.days, certValidTo: cert.validTo, warn, level: !r.ok ? 'down' : warn.length ? 'warn' : 'up' };
}

const results = Object.fromEntries(await Promise.all(cfg.checks.map(async (c) => [c.id, await check(c)])));

// ---------- state transitions ----------
const events = [];
const fmtIST = (d) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const dur = (a, b) => { const m = Math.max(1, Math.round((new Date(b) - new Date(a)) / 60000)); return m < 60 ? `${m} minutes` : m < 2880 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 1440)} days`; };

for (const c of cfg.checks) {
  const r = results[c.id];
  const s = (state.checks[c.id] ??= { state: 'up', since: iso, fails: 0, firstFail: null, issue: null });
  if (r.ok) {
    if (s.state === 'down') events.push({ kind: 'recovered', check: c, from: s.firstFail, issue: s.issue });
    if (s.state !== r.level) s.since = iso;
    Object.assign(s, { state: r.level, fails: 0, firstFail: null, issue: s.state === 'down' ? null : s.issue });
  } else {
    s.fails += 1; s.firstFail ??= iso;
    if (s.fails >= R.failRunsBeforeAlert && s.state !== 'down') { s.state = 'down'; s.since = s.firstFail; events.push({ kind: 'down', check: c, from: s.firstFail, error: r.error }); }
  }
}

// One XTREME2-wide alert instead of 20 separate ones when the whole server is unreachable.
const x2 = cfg.checks.filter((c) => c.host === 'xtreme2');
const x2AllDown = x2.every((c) => state.checks[c.id].state === 'down');
const srv = (state.server ??= { state: 'up', since: iso, issue: null });
if (x2AllDown && srv.state !== 'down') {
  const first = x2.map((c) => state.checks[c.id].firstFail).filter(Boolean).sort()[0] || iso;
  srv.state = 'down'; srv.since = first;
  events.push({ kind: 'server-down', server: 'xtreme2', from: first, error: results[x2[0].id].error });
} else if (!x2AllDown && srv.state === 'down') {
  events.push({ kind: 'server-recovered', server: 'xtreme2', from: srv.since, issue: srv.issue });
  srv.state = 'up'; srv.since = iso;
}
const serverDown = srv.state === 'down';

// ---------- notifications ----------
const GH = process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY;
async function gh(method, path, body) {
  if (DRY || !GH) { console.log(`[dry] ${method} ${path} ${body ? JSON.stringify(body).slice(0, 160) : ''}`); return { number: 0 }; }
  const r = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${path}`, {
    method, headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': UA, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`GitHub ${method} ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}
async function whatsapp(template, params) {
  const { WA_TOKEN, WA_PHONE_NUMBER_ID, WA_TO, WA_GRAPH_VERSION = 'v23.0' } = process.env;
  if (DRY || !WA_TOKEN || !WA_PHONE_NUMBER_ID || !WA_TO) return { sent: false, why: 'WhatsApp not configured for this run' };
  const out = [];
  for (const to of WA_TO.split(',').map((x) => x.replace(/[^\d]/g, '')).filter(Boolean)) {
    const r = await fetch(`https://graph.facebook.com/${WA_GRAPH_VERSION}/${WA_PHONE_NUMBER_ID}/messages`, {
      method: 'POST', headers: { authorization: `Bearer ${WA_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template: { name: template, language: { code: 'en' }, components: [{ type: 'body', parameters: params.map((t) => ({ type: 'text', text: String(t).replace(/[\n\t]+/g, ' ').replace(/ {4,}/g, '   ').slice(0, 200) })) }] } }),
    });
    const j = await r.json().catch(() => ({}));
    out.push(r.ok ? `sent to ...${to.slice(-4)}` : `failed for ...${to.slice(-4)}: ${j?.error?.message || r.status}`);
  }
  return { sent: out.some((x) => x.startsWith('sent')), why: out.join('; ') };
}
const waWanted = (ev) => ev.kind.startsWith('server') || (ev.check && ev.check.host !== 'xtreme2');
const page = cfg.statusPage;

const log = [];
for (const ev of events) {
  const label = ev.check ? ev.check.name : cfg.servers[ev.server].name;
  const suppressed = ev.check && ev.check.host === 'xtreme2' && serverDown && ev.kind === 'down';
  let note = '';
  try {
    if (ev.kind === 'down' || ev.kind === 'server-down') {
      if (suppressed) { log.push({ ...ev, note: 'covered by the XTREME2 server-wide alert' }); continue; }
      const wa = waWanted(ev) ? await whatsapp('dmlrd_site_down', [label, ev.error, fmtIST(ev.from), page]) : { sent: false, why: 'XTREME2 sends its own alert for single sites' };
      const issue = await gh('POST', '/issues', {
        title: ev.kind === 'server-down' ? `DOWN: ${label} - all ${x2.length} sites on it are unreachable` : `DOWN: ${label}`,
        labels: ['outage', ev.kind === 'server-down' ? 'server' : ev.check.group],
        body: [`**What:** ${label} is not working when checked from outside our servers.`, `**Problem:** ${ev.error}`, `**Since:** ${fmtIST(ev.from)} IST`, ev.check ? `**Address:** ${ev.check.url}` : `**Sites affected:** ${x2.map((c) => c.name).join(', ')}`, `**WhatsApp:** ${wa.sent ? 'sent' : 'not sent'} (${wa.why})`, RUN_URL ? `**Check run:** ${RUN_URL}` : '', '', '_Opened automatically by the DMLRD outside health check (CR-2026-0024). It closes itself when the site works again._'].join('\n'),
      });
      if (ev.kind === 'server-down') srv.issue = issue.number; else state.checks[ev.check.id].issue = issue.number;
      note = `issue #${issue.number}; whatsapp: ${wa.why}`;
    } else {
      const wa = waWanted(ev) ? await whatsapp('dmlrd_site_recovered', [label, dur(ev.from, iso), page]) : { sent: false, why: 'XTREME2 sends its own alert for single sites' };
      if (ev.issue != null) {
        await gh('POST', `/issues/${ev.issue}/comments`, { body: `**Working again** at ${fmtIST(iso)} IST. Down for ${dur(ev.from, iso)}. WhatsApp: ${wa.sent ? 'sent' : 'not sent'} (${wa.why}).${RUN_URL ? `\nCheck run: ${RUN_URL}` : ''}` });
        await gh('PATCH', `/issues/${ev.issue}`, { state: 'closed', state_reason: 'completed' });
      }
      if (ev.kind === 'server-recovered') srv.issue = null;
      note = `${ev.issue != null ? `closed issue #${ev.issue}` : 'no issue was open'}; whatsapp: ${wa.why}`;
    }
  } catch (e) { note = `notification error: ${e.message}`; console.error(note); }
  log.push({ ...ev, note });
}
// After a server-wide outage ends, sites that are still down get their own alert next run.
if (!serverDown) for (const c of x2) { const s = state.checks[c.id]; if (s.state === 'down' && s.issue == null && !events.some((e) => e.check?.id === c.id)) s.state = 'up-pending'; }
for (const c of x2) if (state.checks[c.id].state === 'up-pending') { state.checks[c.id].state = 'up'; state.checks[c.id].fails = R.failRunsBeforeAlert - 1; }

// ---------- audit log: append-only, SHA-256 hash chain ----------
const evPath = 'data/events.jsonl';
let prev = '0'.repeat(64);
try { const lines = (await fs.readFile(evPath, 'utf8')).trim().split('\n'); if (lines[0]) prev = JSON.parse(lines.at(-1)).hash; } catch {}
let evOut = '';
for (const e of log) {
  const rec = { ts: iso, kind: e.kind, target: e.check?.id || e.server, name: e.check?.name || cfg.servers[e.server].name, since: e.from, error: e.error ?? null, note: e.note ?? null, run: RUN_URL, prev };
  rec.hash = crypto.createHash('sha256').update(JSON.stringify(rec)).digest('hex');
  prev = rec.hash; evOut += JSON.stringify(rec) + '\n';
}
if (evOut) await fs.appendFile(evPath, evOut);

// ---------- history for the status page ----------
await fs.appendFile(`data/runs/${today}.jsonl`, JSON.stringify({ t: iso, r: cfg.checks.map((c) => [c.id, results[c.id].level[0], results[c.id].ms, results[c.id].status]) }) + '\n');
for (const c of cfg.checks) {
  const d = ((daily.checks[c.id] ??= {})[today] ??= [0, 0, 0, 0]); // runs, up-or-warn runs, sum ms (when up), warn runs
  d[0] += 1; if (results[c.id].ok) { d[1] += 1; d[2] += results[c.id].ms; } if (results[c.id].level === 'warn') d[3] += 1;
  for (const k of Object.keys(daily.checks[c.id])) if ((now - new Date(k)) / 864e5 > 91) delete daily.checks[c.id][k];
}
for (const k of Object.keys(daily.checks)) if (!cfg.checks.some((c) => c.id === k)) delete daily.checks[k];

const recent = (await fs.readFile(evPath, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).slice(-30).map((l) => JSON.parse(l)).map(({ ts, kind, name, since, error }) => ({ ts, kind, name, since, error })).reverse();
const latest = {
  checkedAt: iso, run: RUN_URL, statusPage: page,
  overall: serverDown || cfg.checks.some((c) => state.checks[c.id].state === 'down') ? 'down' : cfg.checks.some((c) => results[c.id].level === 'warn') ? 'warn' : 'up',
  server: { xtreme2: srv.state, since: srv.since },
  groups: cfg.groups, servers: cfg.servers,
  checks: cfg.checks.map((c) => { const r = results[c.id], s = state.checks[c.id]; return { id: c.id, name: c.name, group: c.group, host: c.host, url: c.url, level: s.state === 'down' ? 'down' : r.level === 'down' ? 'checking' : r.level, since: s.since, status: r.status, ms: r.ms, certDays: r.certDays, certValidTo: r.certValidTo, problem: r.error || r.warn.join('; ') || null }; }),
  recent,
};
await fs.writeFile('data/state.json', JSON.stringify(state, null, 1) + '\n');
await fs.writeFile('data/daily.json', JSON.stringify(daily) + '\n');
await fs.writeFile('data/latest.json', JSON.stringify(latest, null, 1) + '\n');

const up = latest.checks.filter((c) => c.level === 'up' || c.level === 'warn').length;
const summary = `${up}/${latest.checks.length} working${events.length ? `, ${events.map((e) => `${e.kind}:${e.check?.name || e.server}`).join(', ')}` : ''}`;
console.log(summary);
for (const c of latest.checks) console.log(`${c.level.padEnd(8)} ${String(c.status ?? '-').padEnd(4)} ${String(c.ms).padStart(5)}ms cert:${c.certDays ?? '-'}d  ${c.name}${c.problem ? '  -> ' + c.problem : ''}`);
if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `summary=${summary}\n`);
