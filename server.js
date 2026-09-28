'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Client: PgClient } = require('pg');
const { createClient } = require('redis');

const pkg = require('./package.json');

const PORT = Number(process.env.PORT) || 3000;
const APP_NAME = process.env.APP_NAME || os.hostname();
const DATA_DIR = process.env.DATA_DIR || '/data';
const SCRATCH_DIR = process.env.SCRATCH_DIR || path.join(__dirname, 'scratch');
const DIRS = { data: DATA_DIR, scratch: SCRATCH_DIR };
const STARTED_AT = new Date();

// ---------------------------------------------------------------- variables

const SYSTEM_VAR = /^(PATH|HOME|HOSTNAME|PWD|OLDPWD|SHLVL|TERM|_|LANG|NODE_ENV|NODE_VERSION|YARN_VERSION|NPM_.*|npm_.*)$/;
const SECRET_KEY = /(SECRET|PASSWORD|PASSWD|PASS|TOKEN|KEY|CREDENTIAL|AUTH|PRIVATE)/i;
const URL_CREDENTIALS = /(\/\/[^:/@\s]*:)([^@\s]+)@/;

function describeVar(key, value) {
  const secret = SECRET_KEY.test(key);
  const credentials = URL_CREDENTIALS.test(value);
  let shown = value;
  if (secret) {
    shown = value.length > 8 ? value.slice(0, 2) + '•'.repeat(8) : '•'.repeat(Math.max(value.length, 4));
  } else if (credentials) {
    shown = value.replace(URL_CREDENTIALS, '$1***@');
  }
  return { key, value: shown, masked: secret || credentials, length: value.length };
}

function envReport() {
  const vars = [];
  const system = [];
  for (const [key, value] of Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b))) {
    (SYSTEM_VAR.test(key) ? system : vars).push(describeVar(key, value));
  }
  return { vars, system };
}

// Détecte, dans l'environnement, ce que Cassiope injecte : URLs d'add-ons (bindings) et liens internes.
function discover(env) {
  const found = { postgres: [], redis: [], peers: [] };
  const seenUrlPrefixes = new Set();

  for (const [name, value] of Object.entries(env)) {
    if (/^postgres(ql)?:\/\//i.test(value)) {
      found.postgres.push({ name, url: value });
    } else if (/^rediss?:\/\//i.test(value)) {
      found.redis.push({ name, url: value });
    } else if (/_URL$/.test(name) && /^https?:\/\//i.test(value)) {
      found.peers.push({ name, base: value.replace(/\/+$/, '') });
      seenUrlPrefixes.add(name.replace(/_URL$/, ''));
    }
  }

  for (const name of Object.keys(env)) {
    const m = name.match(/^(.+)_HOST$/);
    if (!m) continue;
    const prefix = m[1];
    const host = env[name];
    const port = env[`${prefix}_PORT`];
    if (!host || !port) continue;
    const user = env[`${prefix}_USER`] || env[`${prefix}_USERNAME`];
    const pass = env[`${prefix}_PASSWORD`];
    const db = env[`${prefix}_DATABASE`] || env[`${prefix}_DB`] || env[`${prefix}_NAME`];
    const auth = `${encodeURIComponent(user || '')}:${encodeURIComponent(pass || '')}`;
    if (user && pass && db) {
      found.postgres.push({ name: `${prefix}_*`, url: `postgres://${auth}@${host}:${port}/${encodeURIComponent(db)}` });
    } else if (pass && !user && !db) {
      found.redis.push({ name: `${prefix}_*`, url: `redis://:${encodeURIComponent(pass)}@${host}:${port}` });
    } else if (!pass && !user && !seenUrlPrefixes.has(prefix)) {
      found.peers.push({ name: `${prefix}_HOST/${prefix}_PORT`, base: `http://${host}:${port}` });
    }
  }
  return found;
}

const DISCOVERED = discover(process.env);

function publicEntry(e) {
  return { name: e.name, target: (e.url || e.base).replace(URL_CREDENTIALS, '$1***@') };
}

function scrub(message, entry) {
  let out = String(message);
  for (const secret of [entry.url, entry.url && new URL(entry.url).password].filter(Boolean)) {
    out = out.split(secret).join('***');
  }
  return out;
}

// ------------------------------------------------------------------- tests

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} : délai de ${ms / 1000} s dépassé`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function testPostgres(entry) {
  const started = Date.now();
  const client = new PgClient({ connectionString: entry.url, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
  client.on('error', () => {});
  try {
    await withTimeout(client.connect(), 7000, 'connexion');
    const version = (await client.query('select version() as v')).rows[0].v;
    const result = { ok: true, ms: Date.now() - started, version, writable: true, rows: [] };
    try {
      await client.query(
        'create table if not exists cassiope_probe (id serial primary key, at timestamptz not null default now(), instance text)',
      );
      await client.query('insert into cassiope_probe (instance) values ($1)', [APP_NAME]);
      await client.query('delete from cassiope_probe where id not in (select id from cassiope_probe order by id desc limit 20)');
      result.rows = (await client.query('select id, at, instance from cassiope_probe order by id desc limit 5')).rows;
    } catch (err) {
      result.writable = false;
      result.writeError = scrub(err.message, entry);
    }
    result.ms = Date.now() - started;
    return result;
  } catch (err) {
    return { ok: false, ms: Date.now() - started, error: scrub(err.message, entry) };
  } finally {
    client.end().catch(() => {});
  }
}

async function testRedis(entry) {
  const started = Date.now();
  const client = createClient({ url: entry.url, socket: { connectTimeout: 5000, reconnectStrategy: false } });
  client.on('error', () => {});
  try {
    await withTimeout(client.connect(), 7000, 'connexion');
    const pong = await client.ping();
    const info = await client.info('server');
    const version = (info.match(/redis_version:(\S+)/) || [])[1] || 'inconnue';
    const result = { ok: true, ms: 0, pong, version, writable: true };
    try {
      result.hits = await client.incr('cassiope-probe:hits');
      await client.set('cassiope-probe:last', JSON.stringify({ instance: APP_NAME, at: new Date().toISOString() }));
      result.last = JSON.parse(await client.get('cassiope-probe:last'));
    } catch (err) {
      result.writable = false;
      result.writeError = scrub(err.message, entry);
    }
    result.ms = Date.now() - started;
    return result;
  } catch (err) {
    return { ok: false, ms: Date.now() - started, error: scrub(err.message, entry) };
  } finally {
    client.disconnect().catch(() => {});
  }
}

async function testPeer(entry, peerPath) {
  const started = Date.now();
  const url = entry.base + peerPath;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      redirect: 'manual',
      headers: { 'x-cassiope-probe-from': APP_NAME },
    });
    const text = (await res.text()).slice(0, 600);
    let body = text;
    try {
      body = JSON.parse(text);
    } catch {}
    return { ok: res.ok, status: res.status, ms: Date.now() - started, url, body };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, url, error: err.cause?.code ? `${err.message} (${err.cause.code})` : err.message };
  }
}

// ------------------------------------------------------------------ stockage

function unescapeMount(s) {
  return s.replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
}

function readMounts() {
  let raw = '';
  try {
    raw = fs.readFileSync('/proc/self/mountinfo', 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [pre, post] = line.split(' - ');
      if (!post) return null;
      const [fstype, source] = post.split(' ');
      return { mountPoint: unescapeMount(pre.split(' ')[4]), fstype, source };
    })
    .filter(Boolean);
}

const PSEUDO_FS = /^(proc|sysfs|cgroup2?|devpts|mqueue|tmpfs|devtmpfs|shm|nsfs|securityfs|debugfs|tracefs|fusectl|configfs|binfmt_misc|pstore|bpf|autofs|hugetlbfs)$/;

function mountFor(dir, mounts) {
  const resolved = path.resolve(dir);
  return mounts
    .filter((m) => resolved === m.mountPoint || resolved.startsWith(m.mountPoint === '/' ? '/' : m.mountPoint + '/'))
    .sort((a, b) => b.mountPoint.length - a.mountPoint.length)[0];
}

async function usage(dir) {
  try {
    const s = await fsp.statfs(dir);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { total, free, used: total - free };
  } catch {
    return null;
  }
}

const PROBE_FILE = '.cassiope-probe.json';

// Chaque démarrage incrémente un compteur posé dans le dossier : il survit à un redéploiement
// si et seulement si le dossier est sur un volume persistant.
async function recordBoot(dir) {
  try {
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, PROBE_FILE);
    let record = null;
    try {
      record = JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch {}
    const now = new Date().toISOString();
    const next = {
      bootCount: (record?.bootCount || 0) + 1,
      firstBootAt: record?.firstBootAt || now,
      lastBootAt: now,
      hosts: [...(record?.hosts || []), os.hostname()].slice(-5),
    };
    await fsp.writeFile(file, JSON.stringify(next));
    return next;
  } catch (err) {
    return { error: err.message };
  }
}

const bootRecords = {};

async function storageReport() {
  const mounts = readMounts();
  const dirs = {};
  for (const [id, dir] of Object.entries(DIRS)) {
    const mount = mountFor(dir, mounts);
    let files = [];
    let listError = null;
    try {
      files = await Promise.all(
        (await fsp.readdir(dir))
          .filter((n) => n !== PROBE_FILE)
          .slice(0, 50)
          .map(async (name) => ({ name, size: (await fsp.stat(path.join(dir, name)).catch(() => ({ size: 0 }))).size })),
      );
    } catch (err) {
      listError = err.message;
    }
    dirs[id] = {
      path: dir,
      mount: mount ? { ...mount, dedicated: mount.mountPoint !== '/' } : null,
      usage: await usage(dir),
      boot: bootRecords[id],
      files,
      listError,
    };
  }
  const all = await Promise.all(
    mounts
      .filter((m) => !PSEUDO_FS.test(m.fstype) && !m.mountPoint.startsWith('/etc/') && !m.mountPoint.startsWith('/proc'))
      .map(async (m) => ({ ...m, usage: await usage(m.mountPoint) })),
  );
  return { dirs, mounts: all };
}

const MB = 1024 * 1024;

async function writeFiller(id, mb) {
  const dir = DIRS[id];
  const u = await usage(dir);
  if (u && u.free < (mb + 50) * MB) throw new Error(`Espace libre insuffisant (${Math.round(u.free / MB)} Mo)`);
  const file = path.join(dir, `probe-${Date.now()}.bin`);
  const handle = await fsp.open(file, 'w');
  try {
    const chunk = Buffer.alloc(MB, 0x61);
    for (let i = 0; i < mb; i++) await handle.write(chunk);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return path.basename(file);
}

async function clearFillers(id) {
  const dir = DIRS[id];
  const names = (await fsp.readdir(dir)).filter((n) => /^probe-\d+\.bin$/.test(n));
  await Promise.all(names.map((n) => fsp.unlink(path.join(dir, n))));
  return names.length;
}

// ----------------------------------------------------------------- serveur

const INDEX_HTML = path.join(__dirname, 'public', 'index.html');

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 4096) {
        reject(new Error('corps trop volumineux'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('JSON invalide'));
      }
    });
    req.on('error', reject);
  });
}

function whoami(req) {
  return {
    app: APP_NAME,
    hostname: os.hostname(),
    version: pkg.version,
    node: process.version,
    startedAt: STARTED_AT.toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    calledBy: req.headers['x-cassiope-probe-from'] || null,
  };
}

const routes = {
  'GET /healthz': (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  },
  'GET /api/whoami': (req, res) => sendJson(res, 200, whoami(req)),
  'GET /api/env': (req, res) =>
    sendJson(res, 200, {
      ...envReport(),
      discovered: {
        postgres: DISCOVERED.postgres.map(publicEntry),
        redis: DISCOVERED.redis.map(publicEntry),
        peers: DISCOVERED.peers.map(publicEntry),
      },
    }),
  'GET /api/storage': async (req, res) => sendJson(res, 200, await storageReport()),
  'POST /api/storage/write': async (req, res) => {
    const { dir, mb } = await readJson(req);
    const size = Math.min(Math.max(Math.trunc(Number(mb)) || 1, 1), 100);
    if (!DIRS[dir]) return sendJson(res, 400, { error: 'dossier inconnu' });
    sendJson(res, 200, { file: await writeFiller(dir, size), mb: size });
  },
  'POST /api/storage/clear': async (req, res) => {
    const { dir } = await readJson(req);
    if (!DIRS[dir]) return sendJson(res, 400, { error: 'dossier inconnu' });
    sendJson(res, 200, { removed: await clearFillers(dir) });
  },
  'POST /api/test/postgres': async (req, res) => {
    const { name } = await readJson(req);
    const entry = DISCOVERED.postgres.find((e) => e.name === name);
    if (!entry) return sendJson(res, 404, { error: 'add-on PostgreSQL inconnu' });
    sendJson(res, 200, await testPostgres(entry));
  },
  'POST /api/test/redis': async (req, res) => {
    const { name } = await readJson(req);
    const entry = DISCOVERED.redis.find((e) => e.name === name);
    if (!entry) return sendJson(res, 404, { error: 'add-on Redis inconnu' });
    sendJson(res, 200, await testRedis(entry));
  },
  'POST /api/test/peer': async (req, res) => {
    const { name, path: peerPath = '/api/whoami' } = await readJson(req);
    const entry = DISCOVERED.peers.find((e) => e.name === name);
    if (!entry) return sendJson(res, 404, { error: 'lien interne inconnu' });
    if (!/^\/[\w\-./]*$/.test(peerPath)) return sendJson(res, 400, { error: 'chemin invalide' });
    sendJson(res, 200, await testPeer(entry, peerPath));
  },
};

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  try {
    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return fs.createReadStream(INDEX_HTML).pipe(res);
    }
    const handler = routes[`${req.method} ${pathname}`];
    if (!handler) return sendJson(res, 404, { error: 'introuvable' });
    await handler(req, res);
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
    else res.end();
  }
});

async function main() {
  for (const id of Object.keys(DIRS)) bootRecords[id] = await recordBoot(DIRS[id]);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`cassiope-getting-started ${pkg.version} (${APP_NAME}) : http://0.0.0.0:${PORT}`);
    console.log(
      `add-ons détectés : postgres=${DISCOVERED.postgres.length} redis=${DISCOVERED.redis.length} · liens internes=${DISCOVERED.peers.length}`,
    );
  });
}

for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });

main();
