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

// ------------------------------------------------- explorateurs (lecture seule)

const CELL_MAX = 200;
const PAGE_SIZE = 25;

function cell(v) {
  if (v == null) return null;
  const s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > CELL_MAX ? s.slice(0, CELL_MAX) + '…' : s;
}

const quoteIdent = (s) => '"' + String(s).replace(/"/g, '""') + '"';

async function withPg(entry, database, fn) {
  const url = new URL(entry.url);
  if (database) url.pathname = '/' + encodeURIComponent(database);
  const client = new PgClient({ connectionString: url.toString(), connectionTimeoutMillis: 5000, statement_timeout: 5000 });
  client.on('error', () => {});
  try {
    await withTimeout(client.connect(), 7000, 'connexion');
    await client.query('begin read only');
    return await fn(client);
  } catch (err) {
    throw new Error(scrub(err.message, entry));
  } finally {
    client.end().catch(() => {});
  }
}

const LIST_DATABASES =
  'select datname as name, pg_database_size(datname)::bigint as size from pg_database where not datistemplate and datallowconn order by 1';
const LIST_TABLES = `select n.nspname as schema, c.relname as name, c.relkind as kind, greatest(c.reltuples, 0)::bigint as estimate
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p', 'v', 'm') and n.nspname <> 'information_schema' and n.nspname not like 'pg\\_%'
  order by 1, 2 limit 300`;

async function pgExplore(entry, { database, schema, table, offset }) {
  const databases = await withPg(entry, null, async (c) => ({
    current: (await c.query('select current_database() as db')).rows[0].db,
    list: (await c.query(LIST_DATABASES)).rows,
  }));
  const target = database || databases.current;
  if (!databases.list.some((d) => d.name === target)) throw new Error('base inconnue');
  return withPg(entry, target, async (c) => {
    const tables = (await c.query(LIST_TABLES)).rows;
    const out = { database: target, current: databases.current, databases: databases.list, tables };
    if (table) {
      if (!tables.some((t) => t.schema === schema && t.name === table)) throw new Error('table inconnue');
      const qualified = `${quoteIdent(schema)}.${quoteIdent(table)}`;
      const start = Math.max(0, Math.trunc(Number(offset)) || 0);
      const res = await c.query(`select * from ${qualified} limit ${PAGE_SIZE} offset ${start}`);
      const count = (await c.query(`select count(*)::bigint as n from ${qualified}`)).rows[0].n;
      out.data = {
        schema,
        table,
        offset: start,
        pageSize: PAGE_SIZE,
        total: Number(count),
        columns: res.fields.map((f) => f.name),
        rows: res.rows.map((r) => res.fields.map((f) => cell(r[f.name]))),
      };
    }
    return out;
  });
}

const QUEUE_KEY = 'cassiope-probe:queue';

async function withRedis(entry, fn) {
  const client = createClient({ url: entry.url, socket: { connectTimeout: 5000, reconnectStrategy: false } });
  client.on('error', () => {});
  try {
    await withTimeout(client.connect(), 7000, 'connexion');
    return await fn(client);
  } catch (err) {
    throw new Error(scrub(err.message, entry));
  } finally {
    client.disconnect().catch(() => {});
  }
}

async function redisKeyContent(c, key, type) {
  const max = PAGE_SIZE * 2 - 1;
  switch (type) {
    case 'string': return [String(await c.get(key))].map(cell);
    case 'list': return (await c.lRange(key, 0, max)).map(cell);
    case 'set': return (await c.sScan(key, 0, { COUNT: 50 })).members.slice(0, PAGE_SIZE * 2).map(cell);
    case 'zset': return (await c.zRangeWithScores(key, 0, max)).map((m) => `${cell(m.value)} (score ${m.score})`);
    case 'hash': return Object.entries(await c.hGetAll(key)).slice(0, PAGE_SIZE * 2).map(([f, v]) => `${f} = ${cell(v)}`);
    case 'stream': return (await c.xRange(key, '-', '+', { COUNT: PAGE_SIZE * 2 })).map((m) => `${m.id} ${cell(m.message)}`);
    default: return [];
  }
}

async function redisExplore(entry, { key }) {
  return withRedis(entry, async (c) => {
    const out = { dbsize: await c.dbSize() };
    let cursor = 0;
    const names = [];
    for (let i = 0; i < 20 && names.length < 100; i++) {
      const res = await c.scan(cursor, { COUNT: 100 });
      cursor = res.cursor;
      names.push(...res.keys);
      if (cursor === 0) break;
    }
    out.truncated = cursor !== 0 || names.length > 100;
    out.keys = await Promise.all(
      names.slice(0, 100).sort().map(async (name) => ({ name, type: await c.type(name), ttl: await c.ttl(name) })),
    );
    out.queue = { key: QUEUE_KEY, items: (await c.lRange(QUEUE_KEY, 0, PAGE_SIZE * 2 - 1)).map(cell), length: await c.lLen(QUEUE_KEY) };
    if (key) {
      const type = await c.type(key);
      if (type === 'none') throw new Error('clé introuvable');
      out.content = { key, type, ttl: await c.ttl(key), values: await redisKeyContent(c, key, type) };
    }
    return out;
  });
}

// File de démonstration : seule zone en écriture des explorateurs, limitée à une clé `cassiope-probe:*`.
async function redisQueue(entry, action) {
  return withRedis(entry, async (c) => {
    if (action === 'push') {
      await c.rPush(QUEUE_KEY, JSON.stringify({ id: Date.now(), from: APP_NAME, at: new Date().toISOString() }));
      await c.lTrim(QUEUE_KEY, -100, -1);
    } else if (action === 'pop') await c.lPop(QUEUE_KEY);
    else if (action === 'clear') await c.del(QUEUE_KEY);
    else throw new Error('action inconnue');
    return { length: await c.lLen(QUEUE_KEY) };
  });
}

// -------------------------------------------------- config avancée et logs

const HEALTH = { mode: 'ok', until: 0, delayMs: 0 };

function healthState() {
  if (HEALTH.mode !== 'ok' && Date.now() >= HEALTH.until) Object.assign(HEALTH, { mode: 'ok', until: 0, delayMs: 0 });
  return { mode: HEALTH.mode, delayMs: HEALTH.delayMs, remainingSeconds: HEALTH.mode === 'ok' ? 0 : Math.ceil((HEALTH.until - Date.now()) / 1000) };
}

const EXTRA_PORTS = (process.env.EXTRA_PORTS || '')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((p) => Number.isInteger(p) && p >= 1024 && p <= 65535 && p !== PORT);
const LISTENING = [];

function configReport(req) {
  const h = req.headers;
  return {
    port: PORT,
    listening: LISTENING,
    extraPortsEnv: process.env.EXTRA_PORTS || null,
    health: healthState(),
    seenAs: { host: h.host, forwardedHost: h['x-forwarded-host'] || null, forwardedProto: h['x-forwarded-proto'] || null, forwardedFor: h['x-forwarded-for'] || null },
  };
}

let logJob = null;

function generateLogs({ count, level, intervalMs }) {
  if (logJob) throw new Error('une génération est déjà en cours');
  const levels = level === 'mixed' ? ['info', 'warn', 'error'] : [level];
  const emit = (i) => {
    const lv = levels[i % levels.length];
    const line = JSON.stringify({ level: lv, app: APP_NAME, n: i + 1, of: count, msg: `Ligne de test ${i + 1}/${count}`, at: new Date().toISOString() });
    (lv === 'info' ? console.log : lv === 'warn' ? console.warn : console.error)(line);
  };
  if (!intervalMs) {
    for (let i = 0; i < count; i++) emit(i);
    return { emitted: count, done: true };
  }
  let i = 0;
  logJob = setInterval(() => {
    emit(i++);
    if (i >= count) {
      clearInterval(logJob);
      logJob = null;
    }
  }, intervalMs);
  return { emitted: 0, done: false, seconds: Math.ceil((count * intervalMs) / 1000) };
}

const clampInt = (v, min, max, fallback) => Math.min(Math.max(Math.trunc(Number(v)) || fallback, min), max);

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
  'GET /healthz': async (req, res) => {
    const { mode, delayMs } = healthState();
    if (mode === 'slow') await new Promise((r) => setTimeout(r, delayMs));
    res.writeHead(mode === 'fail' ? 503 : 200, { 'content-type': 'text/plain' });
    res.end(mode === 'fail' ? 'unhealthy (simulé)' : 'ok');
  },
  'GET /api/config': (req, res) => sendJson(res, 200, configReport(req)),
  'POST /api/health': async (req, res) => {
    const body = await readJson(req);
    if (!['ok', 'fail', 'slow'].includes(body.mode)) return sendJson(res, 400, { error: 'mode inconnu' });
    if (body.mode === 'ok') Object.assign(HEALTH, { mode: 'ok', until: 0, delayMs: 0 });
    else Object.assign(HEALTH, { mode: body.mode, until: Date.now() + clampInt(body.seconds, 5, 600, 60) * 1000, delayMs: clampInt(body.delayMs, 100, 30000, 10000) });
    sendJson(res, 200, healthState());
  },
  'POST /api/logs/generate': async (req, res) => {
    const body = await readJson(req);
    const level = ['info', 'warn', 'error', 'mixed'].includes(body.level) ? body.level : 'info';
    sendJson(res, 200, generateLogs({ count: clampInt(body.count, 1, 500, 20), level, intervalMs: clampInt(body.intervalMs, 0, 2000, 0) }));
  },
  'POST /api/pg/explore': async (req, res) => {
    const { name, database, schema, table, offset } = await readJson(req);
    const entry = DISCOVERED.postgres.find((e) => e.name === name);
    if (!entry) return sendJson(res, 404, { error: 'add-on PostgreSQL inconnu' });
    sendJson(res, 200, await pgExplore(entry, { database, schema, table, offset }));
  },
  'POST /api/redis/explore': async (req, res) => {
    const { name, key } = await readJson(req);
    const entry = DISCOVERED.redis.find((e) => e.name === name);
    if (!entry) return sendJson(res, 404, { error: 'add-on Redis inconnu' });
    sendJson(res, 200, await redisExplore(entry, { key }));
  },
  'POST /api/redis/queue': async (req, res) => {
    const { name, action } = await readJson(req);
    const entry = DISCOVERED.redis.find((e) => e.name === name);
    if (!entry) return sendJson(res, 404, { error: 'add-on Redis inconnu' });
    sendJson(res, 200, await redisQueue(entry, action));
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
  for (const port of EXTRA_PORTS) {
    http.createServer(server.listeners('request')[0]).listen(port, '0.0.0.0', () => LISTENING.push(port));
  }
  server.listen(PORT, '0.0.0.0', () => {
    LISTENING.unshift(PORT);
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
