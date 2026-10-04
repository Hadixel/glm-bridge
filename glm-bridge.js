#!/usr/bin/env node
/*
 * glm-bridge — OpenAI + Anthropic compatible local bridge for Z.ai GLM,
 * backed by the ZCode desktop subscription (start plan, GLM-5.3-Flash).
 *
 * It drives ZCode's own agent CLI (zcode.cjs app-server --stdio) over the
 * official ZCode Protocol and calls `workspace/generateText`, which returns
 * {text, toolCalls, finishReason, usage} — a raw completion primitive.
 * Auth (JWT) and the per-request Aliyun captcha header are supplied by us,
 * impersonating the desktop host.
 *
 * Endpoints (all accept Bearer auth):
 *   GET  /health
 *   GET  /v1/models
 *   POST /v1/chat/completions   (OpenAI, stream supported)
 *   POST /v1/messages           (Anthropic, stream supported)
 *   POST /v1/messages/count_tokens (Anthropic compat, estimate)
 *
 * Env:
 *   GLM_BRIDGE_PORT   default 3010
 *   GLM_BRIDGE_KEY    default auto-generated into config.json
 *   GLM_BRIDGE_CLI    override path to zcode.cjs
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync, execFile } = require('child_process');

// ---------------------------------------------------------------- config ----
const HOME = os.homedir();
const IS_WIN = process.platform === 'win32';
// Mutable state (key, tokens, logs) lives in STATE_DIR, which is the install dir
// unless GLM_BRIDGE_HOME overrides it. Shipped assets always come from the
// directory holding this script, so relocating state never breaks them.
const STATE_DIR = process.env.GLM_BRIDGE_HOME
  ? path.resolve(process.env.GLM_BRIDGE_HOME)
  : __dirname;
const ASSET_DIR = __dirname;
const CONFIG_PATH = path.join(STATE_DIR, 'config.json');
const TOKENS_PATH = path.join(STATE_DIR, 'tokens.json');
const CACHE_PATH = path.join(STATE_DIR, 'account-revision.json');
const PID_PATH = path.join(STATE_DIR, 'bridge.pid');
const LOG_PATH = path.join(STATE_DIR, 'bridge.log');
const TRAY_PID_PATH = path.join(STATE_DIR, 'tray.pid');
const ACCOUNTS_PATH = path.join(STATE_DIR, 'accounts.json');
// Each ZCode account is a ZCODE_DATA_BASE_DIR; the CLI resolves credentials at
// <dir>/.zcode/v2/credentials.json. The first account ("main") uses $HOME, so
// existing single-account installs keep working unchanged. Multiple accounts
// each carry their own 100M/day start plan — the bridge rotates on quota.
function loadAccounts() {
  let a = null;
  try { a = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8')); } catch { /* first run */ }
  if (!a || !Array.isArray(a.accounts) || !a.accounts.length) {
    a = { active: 'main', accounts: [{ name: 'main', dir: HOME, addedAt: Date.now() }] };
  }
  const now = Date.now();
  let changed = false;
  for (const acc of a.accounts) {
    if (acc.exhaustedUntil && acc.exhaustedUntil <= now) {
      delete acc.exhaustedUntil;
      changed = true;
    }
    if (acc.quotaEmptyUntil && acc.quotaEmptyUntil <= now) {
      delete acc.quotaEmptyUntil;
      changed = true;
    }
  }
  if (!a.accounts.some(x => x.name === a.active)) {
    a.active = a.accounts[0].name;
    changed = true;
  }
  if (changed) {
    try { saveAccounts(a); } catch {}
  }
  return a;
}
function saveAccounts(a) { fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(a, null, 2)); }
function activeAccount() {
  const a = loadAccounts();
  return a.accounts.find(x => x.name === a.active) || a.accounts[0];
}
function accountCredFile(acc) {
  const dir = acc ? acc.dir : activeAccount().dir;
  return path.join(dir, '.zcode', 'v2', 'credentials.json');
}
function getUsableAccounts() {
  const a = loadAccounts();
  const now = Date.now();
  return a.accounts.filter(x => {
    if (!fs.existsSync(accountCredFile(x))) return false;
    if (x.exhaustedUntil && x.exhaustedUntil > now) return false;
    if (x.quotaEmptyUntil && x.quotaEmptyUntil > now) return false;
    return true;
  });
}
function markAccountExhausted(name, reason) {
  const a = loadAccounts();
  const acc = a.accounts.find(x => x.name === name);
  if (!acc) return;
  acc.exhaustedUntil = nextRenewalMs();
  saveAccounts(a);
  log(`account "${name}" paused until daily quota resets (${reason})`);
}
function markAccountEmpty(name, reason) {
  const a = loadAccounts();
  const acc = a.accounts.find(x => x.name === name);
  if (!acc) return;
  acc.quotaEmptyUntil = nextRenewalMs();
  saveAccounts(a);
  log(`account "${name}" marked empty until renewal (${reason})`);
}
function clearAccountExhaustion(name) {
  try {
    const a = loadAccounts();
    const acc = a.accounts.find(x => x.name === name);
    if (acc && (acc.exhaustedUntil || acc.quotaEmptyUntil)) {
      delete acc.exhaustedUntil;
      delete acc.quotaEmptyUntil;
      saveAccounts(a);
    }
  } catch {}
}

// Per-model capacity check for smart routing: an account is usable for a
// given model if ANY bucket covering that model still has tokens left
// (e.g. hadij: drained 100M Flash pool but leftover GLM-5.3 daily tokens).
function accountHasModelTokens(accName, requestedModel) {
  const plan = accountPlans.get(accName);
  if (!plan || plan.err) return true;  // unknown -> let it try
  const mq = plan.modelQuotas || {};
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const want = norm(requestedModel);
  for (const [m, v] of Object.entries(mq)) {
    const mv = norm(m);
    if (mv === want || mv.startsWith(want) || want.startsWith(mv)) {
      return (v.remaining || 0) > 0;
    }
  }
  return Object.values(mq).some(v => (v.remaining || 0) > 0);
}


function nextRenewalMs() {
  const parts = String(process.env.GLM_BRIDGE_CLAIM_AT || '19:30').split(':');
  const hh = Number.isFinite(Number(parts[0])) ? Number(parts[0]) : 19;
  const mm = Number.isFinite(Number(parts[1])) ? Number(parts[1]) : 30;
  const next = new Date();
  next.setHours(hh, mm, 0, 0);
  if (next.getTime() <= Date.now() + 5 * 60_000) next.setDate(next.getDate() + 1);
  return next.getTime() + 10 * 60_000;  // renewal + claim grace
}
function rotateAccount(reason) {
  const a = loadAccounts();
  const cur = a.accounts.find(x => x.name === a.active);
  if (cur) cur.exhaustedUntil = nextRenewalMs();
  const usable = getUsableAccounts().filter(x => x.name !== (cur ? cur.name : ''));
  if (!usable.length) {
    saveAccounts(a);
    log(`quota exhausted (${reason}) and no other account is usable`);
    return false;
  }
  a.active = usable[0].name;
  saveAccounts(a);
  log(`rotated active account to "${usable[0].name}" (${reason})`);
  return true;
}
// ZCode keeps its CLI data in <dataBaseDir>/.zcode on every platform
const zcodeDir = (acc) => path.join((acc || activeAccount()).dir, '.zcode');
const credPath = (acc) => path.join(zcodeDir(acc), 'v2', 'credentials.json');
const workspace = (acc) => path.join(STATE_DIR, 'workspace', (acc || activeAccount()).name);
const MINT_SCRIPT = path.join(ASSET_DIR, 'mint-captcha.js');
const SYSBLOCKS_PATH = path.join(ASSET_DIR, 'sysblocks.json');
const APPIMAGE = (() => {
  try {
    if (IS_WIN) {
      // Windows installer: %LOCALAPPDATA%\Programs\ZCode\ZCode.exe is an
      // Electron app; resources live beside it.
      const cands = [
        path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'Programs', 'ZCode'),
        path.join(HOME, 'AppData', 'Local', 'ZCode'),
      ];
      for (const dir of cands) {
        const p = path.join(dir, 'resources', 'glm', 'zcode.cjs');
        if (fs.existsSync(p)) return p;
      }
      return null;
    }
    return fs.readdirSync(path.join(HOME, 'Applications'))
      .filter(f => /^ZCode-.*\.AppImage$/.test(f))
      .map(f => path.join(HOME, 'Applications', f))
      .sort()
      .pop() || null;
  } catch { return null; }
})();

fs.mkdirSync(STATE_DIR, { recursive: true });

function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}\n`;
  try { fs.appendFileSync(LOG_PATH, line); } catch { /* ignore */ }
  if (process.env.GLM_BRIDGE_QUIET !== '1') process.stdout.write(line);
}

function loadConfig() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* first run */ }
  if (!c.key) {
    c.key = 'glm-local-' + crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
    log('generated bridge key ->', c.key);
  }
  c.port = Number(process.env.GLM_BRIDGE_PORT || c.port || 3010);
  if (process.env.GLM_BRIDGE_KEY) c.key = process.env.GLM_BRIDGE_KEY;
  c.routing = process.env.GLM_BRIDGE_ROUTING || c.routing || 'round-robin';
  return c;
}
function saveConfig(c) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
}
function getRoutingMode() {
  const cfg = loadConfig();
  return process.env.GLM_BRIDGE_ROUTING || cfg.routing || 'round-robin';
}
function setRoutingMode(mode) {
  if (!['round-robin', 'fill-first'].includes(mode)) {
    throw new Error('Routing mode must be "round-robin" or "fill-first"');
  }
  const cfg = loadConfig();
  cfg.routing = mode;
  saveConfig(cfg);
  log(`routing mode set to: ${mode}`);
  return mode;
}
const config = loadConfig();

// ------------------------------------------------------------- credentials ---
// ZCode stores credentials as enc:v1:<iv>.<tag>.<ct> (AES-256-GCM, base64url),
// key = sha256(ZCODE_CREDENTIAL_SECRET || "zcode-credential-fallback:<os>:<home>:<user>").
function decryptCredential(blob) {
  if (!blob.startsWith('enc:v1:')) return blob;
  const [ivB, tagB, ctB] = blob.slice('enc:v1:'.length).split('.');
  const b = s => Buffer.from(s, 'base64url');
  const secret = process.env.ZCODE_CREDENTIAL_SECRET
    || `zcode-credential-fallback:${os.platform()}:${HOME}:${os.userInfo().username}`;
  const key = crypto.createHash('sha256').update(secret).digest();
  const d = crypto.createDecipheriv('aes-256-gcm', key, b(ivB));
  d.setAuthTag(b(tagB));
  return Buffer.concat([d.update(b(ctB)), d.final()]).toString('utf8');
}

const credCache = new Map();
function loadJwt(acc) {
  if (!acc) acc = activeAccount();
  const cached = credCache.get(acc.name);
  if (cached && Date.now() - cached.at < 60_000 && cached.jwt) return cached.jwt;
  const file = accountCredFile(acc);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const jwt = decryptCredential(raw['zcodejwttoken']);
    credCache.set(acc.name, { at: Date.now(), jwt });
    return jwt;
  } catch (e) {
    return null;
  }
}

// ----------------------------------------------------------- captcha mint ----
// One Aliyun captcha device token per pool entry; scene from ZCode client config.
const CAPTCHA = { captchaId: 'MBmzpRpV', sceneId: '11xygtvd', region: 'sgp', prefix: 'no8xfe' };
let tokens = [];
let minting = false;

function loadTokens() {
  try { tokens = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8')); } catch { tokens = []; }
}
function saveTokens() {
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens));
}
function nextToken() {
  if (tokens.length === 0) return null;
  const t = tokens.shift();
  saveTokens();
  return t;
}
function ensureTokens(background = true) {
  if (minting || tokens.length >= 8) return;
  if (!fs.existsSync(MINT_SCRIPT)) { log('mint script missing:', MINT_SCRIPT); return; }
  minting = true;
  const out = path.join(STATE_DIR, `tokens-mint-${Date.now()}.json`);
  const p = spawn(process.execPath, [MINT_SCRIPT, '10', out],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...proxyEnv() } });
  p.stdout.on('data', d => log('[mint]', String(d).trim()));
  p.stderr.on('data', d => log('[mint:err]', String(d).trim().slice(0, 300)));
  p.on('exit', code => {
    minting = false;
    try {
      const fresh = JSON.parse(fs.readFileSync(out, 'utf8'));
      if (Array.isArray(fresh) && fresh.length) {
        loadTokens();
        tokens = [...new Set([...tokens, ...fresh])];
        saveTokens();
        log(`minted ${fresh.length} captcha tokens (pool=${tokens.length})`);
      }
      fs.rmSync(out, { force: true });
    } catch (e) { log('mint merge failed:', e.message); }
    if (tokens.length < 4) setTimeout(() => ensureTokens(), 2000);
  });
  if (!background) { /* caller may poll pool */ }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------- quota state (loud) ------
// When upstream 1005s every account, /health and the TUI must SAY so and
// what to do (claim in the GUI / wait for renewal) instead of looking "up".
const quotaState = { lastQuotaAt: 0, lastOkAt: 0 };
const planCache = {
  at: 0,
  active: null,
  endsAt: null,
  err: null,
  quotaLeft: null,
  quotaSummary: null,
  percent: null,
  remainingTokens: 0,
  totalTokens: 0,
  balances: [],
};

function formatTokens(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '0';
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1).replace(/\.0$/, '') + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(n));
}

function getTelemetryMid(acc) {
  try {
    const dir = acc ? acc.dir : activeAccount().dir;
    const p = path.join(dir, '.zcode', 'v2', 'telemetry-state.json');
    const mid = JSON.parse(fs.readFileSync(p, 'utf8')).deviceMid;
    return typeof mid === 'string' && mid ? mid : '';
  } catch { return ''; }
}

const accountPlans = new Map();

async function refreshAccountPlan(acc) {
  if (!acc) acc = activeAccount();
  const cached = accountPlans.get(acc.name);
  if (cached && Date.now() - cached.at < 30_000) return cached;

  const res = {
    at: Date.now(),
    name: acc.name,
    active: false,
    endsAt: null,
    err: null,
    quotaLeft: null,
    quotaSummary: null,
    percent: null,
    remainingTokens: 0,
    totalTokens: 0,
    balances: [],
  };

  try {
    const jwt = loadJwt(acc);
    if (!jwt) throw new Error('no credentials');
    const mid = getTelemetryMid(acc);
    const headers = {
      authorization: 'Bearer ' + jwt,
      'user-agent': 'ZCode/3.14.4',
      'x-zcode-app-version': '3.14.4',
      'x-platform': `${process.platform}-${process.arch}`,
      'x-client-language': 'en-US',
    };
    if (mid) headers['x-device-mid'] = mid;

    const balancePath = '/api/v1/zcode-plan/billing/balance?app_version=3.14.4&platform='
      + `${process.platform}-${process.arch}`;
    let r = await httpsGet(balancePath, resolvedProxy, 10_000, headers);
    if (r.status !== 200) {
      const currentPath = '/api/v1/zcode-plan/billing/current?app_version=3.14.4&platform='
        + `${process.platform}-${process.arch}`;
      r = await httpsGet(currentPath, resolvedProxy, 10_000, headers);
    }
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    const j = JSON.parse(r.body);
    const data = j.data || {};
    const plans = data.plans || [];
    const balances = data.balances || [];
    const now = Math.floor(Date.now() / 1000);

    const act = plans.find(x => String(x.status || '').toLowerCase() === 'active'
      && (!Number.isFinite(x.ends_at) || x.ends_at > now));
    res.active = !!act;
    res.endsAt = act && Number.isFinite(act.ends_at) ? act.ends_at : null;

    const activeBalances = balances.filter(b => {
      if (b.expires_at && Number.isFinite(b.expires_at) && b.expires_at <= now) return false;
      return true;
    });

    res.balances = activeBalances.map(b => {
      const total = Number(b.total_units) || 0;
      const used = Number(b.used_units) || 0;
      const remaining = Number(b.remaining_units) || 0;
      const pct = total > 0 ? Math.round((remaining / total) * 100) : 0;
      return {
        model: b.show_name || 'GLM',
        total,
        used,
        remaining,
        totalFormatted: formatTokens(total),
        remainingFormatted: formatTokens(remaining),
        percent: pct,
      };
    });

    const modelQuotas = {};
    for (const b of activeBalances) {
      const model = b.show_name || 'GLM';
      if (!modelQuotas[model]) {
        modelQuotas[model] = { model, total: 0, used: 0, remaining: 0 };
      }
      modelQuotas[model].total += Number(b.total_units) || 0;
      modelQuotas[model].used += Number(b.used_units) || 0;
      modelQuotas[model].remaining += Number(b.remaining_units) || 0;
    }
    for (const [k, v] of Object.entries(modelQuotas)) {
      v.percent = v.total > 0 ? Math.round((v.remaining / v.total) * 100) : 0;
      v.remainingFormatted = formatTokens(v.remaining);
      v.totalFormatted = formatTokens(v.total);
      v.label = `${v.remainingFormatted} / ${v.totalFormatted} (${v.percent}%)`;
    }
    res.modelQuotas = modelQuotas;

    // An account is only "empty" when EVERY bucket is drained. hadij-style
    // accounts often have a drained 100M Flash pool but leftover GLM-5.3
    // tokens — parking the whole account there wasted the remainder.
    const totalRem = activeBalances.reduce((s, b) => s + (Number(b.remaining_units) || 0), 0);
    const totalCap = activeBalances.reduce((s, b) => s + (Number(b.total_units) || 0), 0);
    const bestBucket = [...activeBalances].sort((a, b) =>
      (Number(b.remaining_units) || 0) - (Number(a.remaining_units) || 0))[0];
    const showBucket = bestBucket || activeBalances[0];

    if (showBucket) {
      const rem = Number(showBucket.remaining_units) || 0;
      const pct = totalCap > 0 ? Math.round((totalRem / totalCap) * 100) : 0;
      res.remainingTokens = totalRem;
      res.totalTokens = totalCap;
      res.percent = pct;
      res.quotaLeft = `${formatTokens(totalRem)} (${pct}%)`;

      const modelParts = Object.values(modelQuotas)
        .filter(m => m.remaining > 0)
        .map(m => `${m.model.replace(/^GLM-/, '')}: ${m.remainingFormatted}/${m.totalFormatted}`);
      res.quotaSummary = modelParts.length ? modelParts.join(' · ') : `${formatTokens(totalRem)} left`;

      if (totalRem <= 0) {
        markAccountEmpty(acc.name, 'all balances drained');
      } else {
        clearAccountExhaustion(acc.name);
      }
    } else {
      res.quotaLeft = act ? 'active' : null;
    }
  } catch (e) {
    res.err = e.message;
  }

  accountPlans.set(acc.name, res);
  return res;
}

async function refreshPlan() {
  const allAccounts = loadAccounts().accounts.filter(a => fs.existsSync(accountCredFile(a)));
  for (const a of allAccounts) {
    await refreshAccountPlan(a).catch(() => {});
  }

  let totalRemaining = 0;
  let totalCap = 0;
  const summaries = [];
  const activePlan = accountPlans.get(activeAccount().name);

  for (const a of allAccounts) {
    const p = accountPlans.get(a.name);
    if (p && !p.err) {
      totalRemaining += p.remainingTokens;
      totalCap += p.totalTokens;
      if (p.quotaLeft) summaries.push(`${a.name}: ${p.quotaLeft}`);
    }
  }

  planCache.at = Date.now();
  planCache.active = allAccounts.some(a => accountPlans.get(a.name)?.active);
  planCache.remainingTokens = totalRemaining;
  planCache.totalTokens = totalCap;
  planCache.percent = totalCap > 0 ? Math.round((totalRemaining / totalCap) * 100) : 0;
  planCache.balances = activePlan ? activePlan.balances : [];
  const combinedModelQuotas = {};
  for (const a of allAccounts) {
    const p = accountPlans.get(a.name);
    if (p && p.modelQuotas) {
      for (const [mName, mData] of Object.entries(p.modelQuotas)) {
        if (!combinedModelQuotas[mName]) {
          combinedModelQuotas[mName] = { model: mName, total: 0, used: 0, remaining: 0 };
        }
        combinedModelQuotas[mName].total += mData.total;
        combinedModelQuotas[mName].used += mData.used;
        combinedModelQuotas[mName].remaining += mData.remaining;
      }
    }
  }

  for (const [k, v] of Object.entries(combinedModelQuotas)) {
    v.percent = v.total > 0 ? Math.round((v.remaining / v.total) * 100) : 0;
    v.remainingFormatted = formatTokens(v.remaining);
    v.totalFormatted = formatTokens(v.total);
    v.label = `${v.remainingFormatted} / ${v.totalFormatted} (${v.percent}%)`;
  }
  planCache.modelQuotas = combinedModelQuotas;

  const modelParts = Object.values(combinedModelQuotas).map(m =>
    `${m.model.replace(/^GLM-/, '')}: ${m.remainingFormatted}/${m.totalFormatted}`
  );

  if (allAccounts.length > 1) {
    planCache.quotaLeft = `${formatTokens(totalRemaining)} (${planCache.percent}%)`;
    planCache.quotaSummary = modelParts.length ? modelParts.join(' · ') : summaries.join(' · ');
  } else if (activePlan) {
    planCache.quotaLeft = activePlan.quotaLeft;
    planCache.quotaSummary = modelParts.length ? modelParts.join(' · ') : activePlan.quotaSummary;
  }
  return planCache;
}
function markQuotaDrained() {
  if (quotaState.lastQuotaAt < Date.now() - 1000) {
    quotaState.lastQuotaAt = Date.now();
    refreshPlan().catch(() => {});  // populate plan info in the background
  }
}

// ------------------------------------------------------- connectivity ------
// The local network may have no direct internet (VPN off), which made every
// upstream call hang until the CLI gave up. We probe direct first, then fall
// back to a local proxy, and give the result to the CLI child via env
// (Node honours HTTPS_PROXY when --use-env-proxy is on, which we inject).
function getSystemProxy() {
  const envProxy = process.env.GLM_BRIDGE_PROXY
    || process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.ALL_PROXY || process.env.all_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy;
  if (envProxy) return envProxy;

  if (process.platform === 'linux') {
    try {
      const mode = execFileSync('gsettings', ['get', 'org.gnome.system.proxy', 'mode'],
        { encoding: 'utf8', timeout: 800, stdio: ['ignore', 'pipe', 'ignore'] }).trim().replace(/'/g, '');
      if (mode === 'manual') {
        const host = execFileSync('gsettings', ['get', 'org.gnome.system.proxy.http', 'host'],
          { encoding: 'utf8', timeout: 800, stdio: ['ignore', 'pipe', 'ignore'] }).trim().replace(/'/g, '');
        const port = execFileSync('gsettings', ['get', 'org.gnome.system.proxy.http', 'port'],
          { encoding: 'utf8', timeout: 800, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (host && port && port !== '0') return `http://${host}:${port}`;
        const socksHost = execFileSync('gsettings', ['get', 'org.gnome.system.proxy.socks', 'host'],
          { encoding: 'utf8', timeout: 800, stdio: ['ignore', 'pipe', 'ignore'] }).trim().replace(/'/g, '');
        const socksPort = execFileSync('gsettings', ['get', 'org.gnome.system.proxy.socks', 'port'],
          { encoding: 'utf8', timeout: 800, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (socksHost && socksPort && socksPort !== '0') return `socks5://${socksHost}:${socksPort}`;
      }
    } catch {}
  } else if (process.platform === 'win32') {
    try {
      const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyServer'],
        { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] });
      const m = out.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
      if (m && m[1]) {
        const server = m[1];
        return server.includes('://') ? server : `http://${server}`;
      }
    } catch {}
  } else if (process.platform === 'darwin') {
    try {
      const out = execFileSync('scutil', ['--proxy'],
        { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] });
      const httpEnabled = /HTTPEnable\s*:\s*1/.test(out);
      const hostMatch = out.match(/HTTPProxy\s*:\s*(\S+)/);
      const portMatch = out.match(/HTTPPort\s*:\s*(\d+)/);
      if (httpEnabled && hostMatch && portMatch) {
        return `http://${hostMatch[1]}:${portMatch[1]}`;
      }
    } catch {}
  }
  return null;
}

function getProxyCandidates() {
  if (process.env.GLM_BRIDGE_PROXY !== undefined) {
    return [process.env.GLM_BRIDGE_PROXY].filter(Boolean);
  }
  const cands = [];
  const sys = getSystemProxy();
  if (sys) cands.push(sys);
  const envProxies = [
    process.env.HTTPS_PROXY, process.env.https_proxy,
    process.env.ALL_PROXY, process.env.all_proxy,
    process.env.HTTP_PROXY, process.env.http_proxy,
  ].filter(Boolean);
  cands.push(...envProxies);
  cands.push(
    'http://127.0.0.1:10809', 'http://127.0.0.1:7890', 'http://127.0.0.1:8118',
    'http://127.0.0.1:20171', 'http://127.0.0.1:10808', 'http://127.0.0.1:1080'
  );
  return [...new Set(cands)];
}
const PROBE_HOST = 'zcode.z.ai';
const PROBE_PATH = '/api/v1/zcode-plan/billing/current?app_version=3.14.4';
let resolvedProxy;      // undefined = unprobed, null = direct, string = proxy url
let resolvedProxyAt = 0;

// Minimal HTTPS GET that can tunnel through an http proxy (CONNECT).
function httpsGet(path, proxy, timeoutMs = 10000, extraHeaders = {}) {
  // curl does the CONNECT tunneling for us and is present on Linux, macOS and
  // Windows 10+. A hand-rolled TLS tunnel was tried and hung instead of failing.
  return new Promise(resolve => {
    const secs = Math.max(2, Math.ceil(timeoutMs / 1000));
    const args = ['-sS', '-m', String(secs), '-w', '\n__CODE__%{http_code}'];
    if (proxy) args.push('-x', proxy);
    for (const [k, v] of Object.entries(extraHeaders)) args.push('-H', `${k}: ${v}`);
    args.push(`https://${PROBE_HOST}${path}`);
    execFile('curl', args, { timeout: (secs + 3) * 1000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        const s = String(stdout || '');
        const i = s.lastIndexOf('\n__CODE__');
        if (i < 0) return resolve({ status: 0, body: '' });
        resolve({ status: Number(s.slice(i + 9)) || 0, body: s.slice(0, i) });
      });
  });
}

async function resolveProxy(force = false) {
  if (!force && resolvedProxy !== undefined && Date.now() - resolvedProxyAt < 5 * 60_000) return resolvedProxy;
  const direct = await httpsGet(PROBE_PATH, null).catch(() => ({ status: 0 }));
  if (direct.status >= 200 && direct.status < 500) {
    if (resolvedProxy !== null && resolvedProxy !== undefined) log('connectivity: direct route OK');
    resolvedProxy = null;
    resolvedProxyAt = Date.now();
    return resolvedProxy;
  }
  for (const p of getProxyCandidates()) {
    const r = await httpsGet(PROBE_PATH, p).catch(() => ({ status: 0 }));
    if (r.status >= 200 && r.status < 500) {
      log(`connectivity: direct blocked, using proxy ${p} (upstream ${r.status})`);
      resolvedProxy = p;
      resolvedProxyAt = Date.now();
      return resolvedProxy;
    }
  }
  log('connectivity: no working route (direct and proxies failed)');
  resolvedProxy = null;
  resolvedProxyAt = Date.now();
  return null;
}

// Env handed to the CLI child and to minting so their HTTP goes via the proxy.
function proxyEnv() {
  const p = resolvedProxy;
  if (!p) return {};
  return {
    HTTPS_PROXY: p, HTTP_PROXY: p, https_proxy: p, http_proxy: p,
    ALL_PROXY: p, all_proxy: p,
    NO_PROXY: 'localhost,127.0.0.1,::1',
    no_proxy: 'localhost,127.0.0.1,::1',
    // Node only applies proxy env to global clients when this flag is on.
    // NB: do not "dedupe" by testing the incoming value against the flag we
    // are adding — that filters out the flag itself and yields an empty string.
    NODE_OPTIONS: (() => {
      const cur = (process.env.NODE_OPTIONS || '').trim();
      if (cur.includes('--use-env-proxy')) return cur;
      return cur ? `${cur} --use-env-proxy` : '--use-env-proxy';
    })(),
    GLM_BRIDGE_PROXY: p,
    MINT_PROXY: p,
  };
}

// The upstream decides whether model requests need a captcha token at all
// (`configs.captcha.skip_model_request`). When it is true we must not mint:
// minting needs Chromium, can fail, and burning tokens we do not need leaves
// the bridge refusing requests (HTTP 503 from 9router) once the pool drains.
// The policy is cached for a few minutes and refreshed in the background.
const CAPTCHA_CONFIG_URL = `https://zcode.z.ai/api/v1/client/configs?app_version=${encodeURIComponent(process.env.ZCODE_APP_VERSION || '3.14.4')}&platform=${IS_WIN ? 'win32-x64' : 'linux-x64'}`;
let captchaPolicy = { at: 0, required: null };

async function captchaPolicyRequired() {
  if (captchaPolicy.required !== null && Date.now() - captchaPolicy.at < 5 * 60_000) {
    return captchaPolicy.required;
  }
  try {
    const url = new URL(CAPTCHA_CONFIG_URL);
    const r = await httpsGet(url.pathname + url.search, resolvedProxy, 10000,
      { authorization: 'Bearer ' + loadJwt() });
    if (!r.status) throw new Error('unreachable');
    const j = JSON.parse(r.body || '{}');
    const c = j && j.data && j.data.configs && j.data.configs.captcha;
    const required = !!(c && c.enabled !== false && c.skip_model_request !== true);
    if (required !== captchaPolicy.required) {
      log(`captcha policy changed -> ${required ? 'required (minting enabled)' : 'not required (skip_model_request)'}`);
    }
    captchaPolicy = { at: Date.now(), required };
    return required;
  } catch (e) {
    if (captchaPolicy.required === null) {
      log('captcha policy unknown, assuming not required:', e.message);
      captchaPolicy = { at: Date.now(), required: false };
    }
    return captchaPolicy.required;
  }
}

// Called when the upstream rejects a request as captcha-blocked, so we can
// recover even if the config endpoint said otherwise.
function forceCaptchaRequired(reason) {
  if (captchaPolicy.required !== true) log('captcha forced required:', reason);
  captchaPolicy = { at: Date.now(), required: true };
  ensureTokens();
}

async function waitForToken(ms) {
  let tok = nextToken();
  if (tok) return tok;
  ensureTokens();
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await sleep(500);   // async: never blocks the HTTP server
    loadTokens();
    tok = nextToken();
    if (tok) return tok;
  }
  return null;
}

async function captchaHeader() {
  if (!(await captchaPolicyRequired())) return {};   // upstream does not want one
  const tok = await waitForToken(90_000);   // mint takes ~60s when pool is cold
  if (!tok) return null;                             // required but we have none
  const param = Buffer.from(JSON.stringify({
    captchaId: CAPTCHA.captchaId,
    sceneId: CAPTCHA.sceneId,
    isSign: true,
    securityToken: tok,
  })).toString('base64');
  return { 'X-Aliyun-Captcha-Verify-Param': param, 'X-Aliyun-Captcha-Verify-Region': CAPTCHA.region };
}

// ------------------------------------------------------ builtin + revision ---
function findBuiltinFile() {
  const roots = [path.join(zcodeDir(), 'v2', 'runtime', 'provider')];
  const hits = [];
  for (const root of roots) {
    try {
      const walk = (dir, depth) => {
        if (depth > 6) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p, depth + 1);
          else if (e.name === 'zcode-builtin.json') hits.push(p);
        }
      };
      walk(root, 0);
    } catch { /* no runtime dir */ }
  }
  hits.sort((a, b) => {
    try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; }
  });
  if (hits[0]) return hits[0];
  const cliRoot = resolveCliRoot();
  const fallback = cliRoot && path.join(path.dirname(cliRoot), 'config', 'provider', 'zcode-builtin.json');
  const fallbackWin = cliRoot && path.join(path.dirname(cliRoot), '..', 'config', 'provider', 'zcode-builtin.json');
  if (fallback && fs.existsSync(fallback)) return fallback;
  if (fallbackWin && fs.existsSync(fallbackWin)) return fallbackWin;
  // Windows: desktop exe at <root>/ZCode.exe, resources at <root>/resources/glm/...
  if (cliRoot && IS_WIN) {
    const winPath = path.join(path.dirname(path.dirname(cliRoot)), 'config', 'provider', 'zcode-builtin.json');
    if (fs.existsSync(winPath)) return winPath;
  }
  return null;
}

function builtinRevisionFor(file) {
  const rev = JSON.parse(fs.readFileSync(file, 'utf8')).revision;
  const h = crypto.createHash('sha256').update(path.resolve(file)).digest('hex');
  return `zcode-builtin:${rev}:${h}`;
}

function statesFor(providers) {
  const states = {};
  let currentGiven = false;
  for (const p of Object.keys(providers)) {
    const acc = providers[p] && providers[p].access;
    const entitled = !!(acc && acc.type === 'zhipu-account' && acc.entitled);
    if (!entitled) {
      states[p] = { availability: 'unavailable', entitled: false, unavailableReason: 'not-entitled' };
    } else {
      const isCurrent = !currentGiven && /start-plan$/.test(p);
      if (isCurrent) currentGiven = true;
      states[p] = { availability: 'available', entitled: true, current: isCurrent };
    }
  }
  // guarantee every entitled provider has a boolean current (protocol requires it)
  for (const [p, s] of Object.entries(states)) {
    if (s.entitled && typeof s.current !== 'boolean') s.current = false;
  }
  return states;
}

function ensureStartPlanModels(providers, inner) {
  const sp = providers['account:zai-start-plan'];
  if (sp) {
    const list = Array.isArray(sp.builtinModelIds) ? sp.builtinModelIds : [];
    if (!list.includes('GLM-5.3')) {
      sp.builtinModelIds = ['GLM-5.3', ...list.filter(m => m !== 'GLM-5.3')];
    }
  }
  if (inner && Array.isArray(inner[1])) {
    for (const p of inner[1]) {
      if (p.providerId === 'account:zai-start-plan' && p.config) {
        const list = Array.isArray(p.config.builtinModelIds) ? p.config.builtinModelIds : [];
        if (!list.includes('GLM-5.3')) {
          p.config.builtinModelIds = ['GLM-5.3', ...list.filter(m => m !== 'GLM-5.3')];
        }
      }
    }
  }
}

function loadAccountRevision(builtinFile) {
  const computed = builtinRevisionFor(builtinFile);
  // 1) newest desktop log line (desktop host is the source of truth)
  try {
    const logDir = path.join(zcodeDir(), 'v2', 'logs');
    if (!fs.existsSync(logDir)) throw new Error('logs dir does not exist');
    const files = fs.readdirSync(logDir).filter(f => f.endsWith('.log')).sort().reverse();
    for (const f of files) {
      const txt = fs.readFileSync(path.join(logDir, f), 'utf8');
      const re = /receivedRevision":"(account:\[(?:\\.|[^"\\])+)"/g;
      let m, last = null;
      while ((m = re.exec(txt))) last = m[1];
      if (last) {
        const decoded = JSON.parse('"' + last + '"'); // unescape \" etc.
        const inner = JSON.parse(decoded.slice('account:'.length));
        inner[0] = computed;
        const revision = 'account:' + JSON.stringify(inner);
        const providers = {};
        for (const p of inner[1]) providers[p.providerId] = p.config;
        ensureStartPlanModels(providers, inner);
        const out = { revision, basedOnZCodeBuiltinRevision: computed, providers, states: statesFor(providers) };
        fs.writeFileSync(CACHE_PATH, JSON.stringify(out, null, 2));
        log('account revision parsed from desktop log');
        return out;
      }
    }
  } catch (e) { log('log parse failed:', e.message); }
  // 2) cache
  try {
    const cached = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    cached.basedOnZCodeBuiltinRevision = computed;
    const inner = JSON.parse(cached.revision.slice(cached.revision.indexOf(':') + 1));
    inner[0] = computed;
    cached.revision = 'account:' + JSON.stringify(inner);
    ensureStartPlanModels(cached.providers, inner);
    cached.states = statesFor(cached.providers);
    log('account revision loaded from cache');
    return cached;
  } catch (e) { log('cache load failed:', e.message); }
  // 3) last resort: derive from builtin provider rules; assume start-plan entitled
  try {
    const builtin = JSON.parse(fs.readFileSync(builtinFile, 'utf8'));
    const rules = builtin.config.providerConfigRules.providerRules || [];
    const providers = {};
    for (const r of rules) {
      const c = r.config || {};
      // protocol accepts only {type, entitled} on account access (no mode/accountType)
      const access = { type: 'zhipu-account', entitled: r.providerId === 'account:zai-start-plan' };
      providers[r.providerId] = { access, builtinModelIds: c.builtinModelIds };
    }
    const inner = [computed, Object.entries(providers).map(([providerId, config]) => ({ providerId, config }))];
    ensureStartPlanModels(providers, inner);
    const out = { revision: 'account:' + JSON.stringify(inner), basedOnZCodeBuiltinRevision: computed, providers, states: statesFor(providers) };
    fs.writeFileSync(CACHE_PATH, JSON.stringify(out, null, 2));
    log('account revision derived from builtin rules');
    return out;
  } catch (e) { log('builtin derive failed:', e.message); }
  throw new Error('unable to build account revision');
}

// ------------------------------------------------------------- CLI resolve ---
function findMountedCli() {
  try {
    if (IS_WIN) return null; // Windows: no AppImage mounts; installer-provided CLI
    const mounts = fs.readdirSync('/tmp').filter(d => d.startsWith('.mount_ZCode'));
    for (const m of mounts.sort().reverse()) {
      const p = path.join('/tmp', m, 'resources', 'glm', 'zcode.cjs');
      if (fs.existsSync(p)) return p;
    }
  } catch { /* ignore */ }
  return null;
}
function resolveCliRoot() {
  if (process.env.GLM_BRIDGE_CLI) return process.env.GLM_BRIDGE_CLI;
  // Prefer our own extracted copy: it means the ZCode desktop can be closed
  // and the /tmp AppImage mount can disappear without breaking the bridge.
  const extracted = path.join(ASSET_DIR, 'squashfs-root', 'resources', 'glm', 'zcode.cjs');
  if (fs.existsSync(extracted)) return extracted;
  if (IS_WIN) {
    // Windows: ZCode desktop (Electron) ships resources beside the exe
    if (APPIMAGE) return APPIMAGE;
    log('Windows: zcode.cjs not found under %LOCALAPPDATA%\\Programs\\ZCode');
    return null;
  }
  const mounted = findMountedCli();
  if (mounted) {
    log('using live AppImage mount, extracting a private copy for offline use');
    try {
      execFileSync(APPIMAGE || mounted, ['--appimage-extract'], { cwd: ASSET_DIR, stdio: 'pipe', timeout: 300_000 });
    } catch (e) { log('extract failed:', e.message.slice(0, 200)); }
    if (fs.existsSync(extracted)) return extracted;
    return mounted;
  }
  if (APPIMAGE) {
    log('no AppImage mount, extracting once ->', ASSET_DIR);
    try {
      execFileSync(APPIMAGE, ['--appimage-extract'], { cwd: ASSET_DIR, stdio: 'pipe', timeout: 300_000 });
      if (fs.existsSync(extracted)) return extracted;
    } catch (e) { log('extract failed:', e.message.slice(0, 300)); }
  }
  return null;
}

// -------------------------------------------------------- protocol client -----
const rejectedModels = new Set();
class ZcodeClient {
  constructor(account = null) {
    this.account = account || activeAccount();
    this.child = null;
    this.ready = false;
    this.id = 0;
    this.activeRequests = 0;
    this.pending = new Map();
    this.restartDelay = 1000;
    this.start();
  }

  start() {
    const cli = resolveCliRoot();
    if (!cli) {
      this.waitReason = 'zcode.cjs not found — install/open the ZCode desktop app once (needs ~/.zcode credentials), or set GLM_BRIDGE_CLI; retrying every 10s';
      log(this.waitReason);
      setTimeout(() => this.start(), 10_000);
      return;
    }
    const builtinFile = findBuiltinFile();
    if (!builtinFile) {
      this.waitReason = 'zcode-builtin.json not found next to the CLI; retrying every 10s';
      log(this.waitReason);
      setTimeout(() => this.start(), 10_000);
      return;
    }
    this.waitReason = null;
    const acc = this.account || activeAccount();
    this.account = acc;
    const accZcodeDir = path.join(acc.dir, '.zcode');
    const ws = workspace(acc);
    const env = {
      ...process.env,
      ...proxyEnv(),
      // Per-account data root: the child resolves <dir>/.zcode/... itself.
      ZCODE_DATA_BASE_DIR: acc.dir,
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinFile,
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: path.join(accZcodeDir, 'v2', 'provider_config.json'),
    };
    try { fs.mkdirSync(ws, { recursive: true }); } catch { /* cwd below may exist */ }
    log('spawning CLI:', cli, '| builtin:', builtinFile, '| account:', acc.name);
    this.lastStderr = null;
    this.waitReason = 'spawning CLI';
    this.child = spawn(process.execPath, [cli, 'app-server', '--stdio', '--surface', 'terminal'], {
      cwd: ws, env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.builtinFile = builtinFile;
    this.ready = false;

    let buf = '';
    this.child.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { log('cli stdout(non-json):', line.slice(0, 200)); continue; }
        this.onMessage(m);
      }
    });
    this.child.stderr.on('data', d => {
      for (const l of String(d).split('\n')) if (l.trim()) {
        this.lastStderr = l.slice(0, 300);
        log('cli:', this.lastStderr);
      }
    });
    this.child.on('exit', code => {
      this.waitReason = `CLI exited (code ${code}), restarting in ${this.restartDelay} ms${this.lastStderr ? ` — last stderr: ${this.lastStderr}` : ''}`;
      log(this.waitReason);
      this.ready = false;
      for (const [, p] of this.pending) p.resolve({ error: { message: 'CLI exited' } });
      this.pending.clear();
      setTimeout(() => this.start(), this.restartDelay);
      this.restartDelay = Math.min(this.restartDelay * 2, 30_000);
    });

    this.syncAccountConfig();
  }

  onMessage(m) {
    // server -> client request: has `method` and `id`
    if (m.method && m.id !== undefined) {
      Promise.resolve(this.answerServerRequest(m)).catch(e =>
        log('answerServerRequest rejected:', e.message));
      return;
    }
    // client -> server response: has `id` and is in `this.pending`
    if (m.id !== undefined && this.pending.has(m.id)) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      p.resolve(m);
      return;
    }
    // notifications: state.updated, storageState, mcpTelemetry — ignored
  }

  async answerServerRequest(m) {
    let result = {};
    try {
      if (m.method === 'session/requestRuntimePreferences') {
        result = { nativeSearchEnhancementsEnabled: false };
      } else if (m.method === 'interaction/requestProviderRuntimeHeaders') {
        const reason = (m.params || {}).reason || 'model-request';
        // Fast path: GLM-5.3-Flash and standard models NEVER need captcha.
        // Only GLM-5.3 (premium) or explicit captcha-retry requests use tokens.
        // NEVER block an incoming request on Playwright (which takes 30-60s!)
        // If a token is in the pool, use it; if empty, refill in the background
        // and proceed immediately.
        const needsCaptcha = (this.inFlightModel === 'GLM-5.3') || reason === 'captcha-retry';
        let hdrs = {};
        if (needsCaptcha) {
          const tok = nextToken();
          if (tok) {
            hdrs = { 'x-device-token': tok };
          } else {
            ensureTokens(); // background non-blocking refill
          }
        }
        const jwt = loadJwt(this.account);
        result = { headersApplied: true, requestAuth: { apiKey: jwt, headers: hdrs } };
        log(`runtime headers applied (acc=${this.account ? this.account.name : 'default'}, reason=${reason}, model=${this.inFlightModel || '?'}, captcha=${Object.keys(hdrs).length ? 'token' : 'none'}, pool=${tokens.length})`);
      } else {
        log('unhandled server request', m.method, JSON.stringify(m.params || {}).slice(0, 200));
        result = {};
      }
    } catch (e) {
      log('answerServerRequest error:', e.message);
      result = m.method === 'interaction/requestProviderRuntimeHeaders'
        ? { headersApplied: false, errorMessage: e.message } : {};
    }
    try {
      this.child.stdin.write(JSON.stringify({ id: m.id, result }) + '\n');
    } catch (e) { log('stdin write failed:', e.message); }
  }

  send(method, params, timeoutMs = 30_000, signal = null) {
    return new Promise(resolve => {
      if (!this.child || !this.child.stdin.writable) {
        resolve({ error: { message: 'CLI not running' } });
        return;
      }
      if (signal && signal.aborted) {
        resolve({ error: { message: 'request aborted by client' } });
        return;
      }
      const id = 'req_' + (++this.id);
      const tStart = Date.now();
      let timer = null;
      let onAbort = null;
      const cleanup = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      };
      this.pending.set(id, {
        resolve: val => {
          cleanup();
          resolve(val);
        }
      });
      timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          cleanup();
          const elapsed = Date.now() - tStart;
          log(`[send TIMEOUT acc=${this.account ? this.account.name : '?'}] ${id} ${method} elapsed=${elapsed}ms timeoutMs=${timeoutMs}`);
          try {
            if (this.child) {
              log(`killing hung child CLI for "${this.account ? this.account.name : '?'}" (PID ${this.child.pid})`);
              this.ready = false;
              this.child.kill('SIGKILL');
            }
          } catch {}
          resolve({ error: { message: `timeout waiting for ${method}` } });
        }
      }, timeoutMs);
      if (signal) {
        onAbort = () => {
          if (this.pending.has(id)) {
            this.pending.delete(id);
            cleanup();
            resolve({ error: { message: 'request aborted by client' } });
          }
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  async syncAccountConfig() {
    // wait for the runtime to come up, then push account config (retry a few times)
    for (let i = 0; i < 20 && !this.ready; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (!this.child || this.child.exitCode !== null) return;
      // probe: storage handshake happens first; try sync every 2s
      if (i % 4 !== 3) continue;
      let acct;
      try { acct = loadAccountRevision(this.builtinFile); } catch (e) { log('revision error:', e.message); continue; }
      const r = await this.send('provider/updateAccountConfig', {
        revision: acct.revision,
        basedOnZCodeBuiltinRevision: acct.basedOnZCodeBuiltinRevision,
        providers: acct.providers,
        states: acct.states,
      }, 10_000);
      if (r.result && r.result.status) {
        this.ready = true;
        this.restartDelay = 1000;
        log(`account config synced (${r.result.status}, providers=${r.result.providerCount})`);
        return;
      }
      log('updateAccountConfig attempt failed:', JSON.stringify(r.error || r).slice(0, 300));
    }
    log('WARN: account config not synced after retries');
  }

  // Serialize upstream calls: Aliyun captcha can reject duplicate concurrent submits.
  generate({ systemBlocks, messages, tools, maxOutputTokens, reasoningLevel, modelId, signal }) {
    this.activeRequests = (this.activeRequests || 0) + 1;
    const run = async () => {
      try {
        if (!this.ready) {
          // one nudge in case sync is lagging
          await this.syncAccountConfig();
          if (!this.ready) return { error: { message: 'bridge warming up, retry shortly' } };
        }
        if (signal && signal.aborted) return { error: { message: 'request aborted by client' } };
      // Known-rejected models (registry lacks them) go straight to Flash —
      // otherwise every glm-5.3 request paid a ~10s upstream rejection first.
      const requestedModel = modelId || 'GLM-5.3-Flash';
      const effectiveModel = (rejectedModels.has(requestedModel))
        ? 'GLM-5.3-Flash' : requestedModel;
      // Premium model billing: the upstream silently downgrades captcha-less
      // GLM-5.3 requests to GLM-5.3-Flash (verified by bucket deltas). Flag
      // the client so its runtime-headers responder attaches a token.
      this.inFlightModel = effectiveModel;
      const opId = 'op-' + crypto.randomUUID();
      const params = {
        operationId: opId,
        workspace: { workspacePath: workspace(this.account), workspaceKey: workspace(this.account) },
        selection: {
          providerId: 'account:zai-start-plan',
          modelId: effectiveModel,
          options: { reasoningLevel: reasoningLevel || 'low' },
        },
        messages: [...systemBlocks, ...messages],
        querySource: 'bridge',
        maxOutputTokens,
      };
      if (tools && tools.length) params.tools = tools;
      let onAbort = null;
      if (signal) {
        onAbort = () => {
          this.send('workspace/cancelGenerateText', { operationId: opId }).catch(() => {});
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      const sendTimeoutMs = Number(process.env.GLM_BRIDGE_TIMEOUT_MS) || 300_000;
      const sendOnce = () => this.send('workspace/generateText', params, sendTimeoutMs, signal);
      let r;
      try {
        r = await sendOnce();
      } finally {
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      }
      if (signal && signal.aborted) return { error: { message: 'request aborted by client' } };
      // If the upstream starts demanding captcha tokens again, recover on the
      // spot instead of failing the request: flip the policy and retry once.
      if (r.error && /3012|unusual activity|captcha/i.test(JSON.stringify(r.error))) {
        forceCaptchaRequired('upstream rejected the request');
        await sleep(400);
        r = await sendOnce();
      }
      // The cached account revision may not list a newly added model (e.g.
      // GLM-5.3 joined the plan after the desktop last wrote its log). If the
      // upstream rejects the model as unknown/unentitled, retry once on the
      // plan's baseline Flash and remember what worked.
      //
      // IMPORTANT: quota exhaustion ("exceed quota limit") is PER-ACCOUNT —
      // it must NOT blacklist GLM-5.3 globally, or one drained 3M bucket
      // silently switches every other account (with full 3M buckets) to
      // Flash too. Only a genuine registry/entitlement error marks the model
      // rejected; quota errors fall back for THIS request only.
      const accName = this.account ? this.account.name : 'default';
      if (r.error && params.selection.modelId !== 'GLM-5.3-Flash') {
        const errText = JSON.stringify(r.error);
        const isQuotaErr = /exceed quota|1005|balance.*empty|insufficient.*quota/i.test(errText);
        // Concurrency/rate limits are TRANSIENT: never a registry rejection.
        const isTransient = /concurrency|rate limit|too many|timeout|timed out/i.test(errText);
        // Registry rejection = the model id itself is unknown/unentitled.
        // NOTE: "model" appears in every AiSdk error string, so it must not
        // be part of the match.
        const isRegistryErr = !isQuotaErr && !isTransient
          && /entitle|not_found|notfound|not\s*(?:supported|available|registered)|unknown model|invalid model|not_entitled/i.test(errText);
        if (params.selection.modelId === 'GLM-5.3' && (isQuotaErr || isRegistryErr)) {
          if (isRegistryErr && !rejectedModels.has('GLM-5.3')) {
            log(`model GLM-5.3 registry-rejected (${errText.slice(0, 160)}), blacklisting globally`);
            rejectedModels.add('GLM-5.3');
          } else if (isQuotaErr) {
            log(`account "${accName}" GLM-5.3 quota exhausted, using Flash for this request`);
          } else {
            log(`model ${params.selection.modelId} rejected (${errText.slice(0, 160)}), falling back to GLM-5.3-Flash`);
          }
          // Never silently degrade GLM-5.3 -> Flash: that bills the Flash
          // bucket and defeats the whole point of separate pools. Transient
          // and quota errors propagate so generateWithFailover can retry on
          // another account (or the caller can retry); only a registry
          // rejection is permanent and falls back here.
          if (!isRegistryErr) {
            return { error: r.error, isQuotaExhausted: isQuotaErr, isTransient: !isQuotaErr };
          }
          params.selection.modelId = 'GLM-5.3-Flash';
          r = await sendOnce();
        }
      }
      if (r.error) {
        const msg = JSON.stringify(r.error);
        log('generateText error (req=' + requestedModel + ' eff=' + effectiveModel + ' acc=' + (this.account ? this.account.name : 'default') + '):', msg.slice(0, 3000));
        const isQuota = /exceed quota|1005|balance.*empty|insufficient.*quota/i.test(msg);
        return { error: r.error, isQuotaExhausted: isQuota };
      }
      let result = r.result;
      // Thinking can swallow a small output budget: retry once with a bigger cap.
      const empty = result && !result.text && !(result.toolCalls && result.toolCalls.length)
        && result.finishReason === 'length';
      if (empty && params.maxOutputTokens < 8192) {
        log('empty length-truncated response, retrying with maxOutputTokens=8192');
        params.maxOutputTokens = 8192;
        params.operationId = 'op-' + crypto.randomUUID();
        const sendTimeoutMs = Number(process.env.GLM_BRIDGE_TIMEOUT_MS) || 300_000;
        const r2 = await this.send('workspace/generateText', params, sendTimeoutMs, signal);
        if (r2.result) result = r2.result;
        else if (r2.error) return { error: r2.error };
      }
      // A successful completion proves quota is back: drop the rotation park
      // so this account can be selected again (checked lazily, one read).
      quotaState.lastOkAt = Date.now();
      try {
        const a = loadAccounts();
        const cur = a.accounts.find(x => x.name === a.active);
        if (cur && cur.exhaustedUntil) { delete cur.exhaustedUntil; saveAccounts(a); }
      } catch { /* non-fatal */ }
        return { result };
      } finally {
        this.activeRequests = Math.max(0, (this.activeRequests || 1) - 1);
      }
    };
    return run();
  }
}

// ------------------------------------------------------- message conversion --
// ZCode protocol message shapes:
//   {role:'system'|'user', content:string}
//   {role:'assistant', content:string, toolCalls?:[{id,name,input}]}
//   {role:'tool', content:string, toolCallId, toolName, isError?}

function textOf(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(b => b && (b.type === 'text' || b.type === 'input_text' || b.type === 'output_text'))
      .map(b => b.text || '')
      .join('');
  }
  return String(content);
}

const REQUIRED_SYSTEM = (() => {
  try {
    const blocks = JSON.parse(fs.readFileSync(SYSBLOCKS_PATH, 'utf8'));
    return blocks.map(b => ({ role: 'system', content: b.text }));
  } catch (e) {
    log('FATAL sysblocks.json missing/invalid:', e.message);
    process.exit(1);
  }
})();

function buildToolNameMap(openaiMessages) {
  const map = new Map();
  for (const m of openaiMessages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const t of m.tool_calls) if (t.id && t.function) map.set(t.id, t.function.name);
    }
  }
  return map;
}

function openaiToZcode(msgs) {
  const nameById = buildToolNameMap(msgs);
  const out = [];
  for (const m of msgs) {
    if (m.role === 'system') {
      out.push({ role: 'system', content: textOf(m.content) });
    } else if (m.role === 'user') {
      out.push({ role: 'user', content: textOf(m.content) });
    } else if (m.role === 'assistant') {
      const entry = { role: 'assistant', content: textOf(m.content) };
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        entry.toolCalls = m.tool_calls.map(t => ({
          id: t.id || crypto.randomUUID(),
          name: (t.function && t.function.name) || t.name || 'unknown',
          input: parseJsonSafe((t.function && t.function.arguments) || t.input || '{}'),
        }));
      }
      out.push(entry);
    } else if (m.role === 'tool') {
      out.push({
        role: 'tool',
        content: textOf(m.content),
        toolCallId: m.tool_call_id || m.toolCallId || '',
        toolName: m.name || m.toolName || nameById.get(m.tool_call_id) || 'unknown',
        ...(m.is_error || m.isError ? { isError: true } : {}),
      });
    }
  }
  return out;
}

function anthropicToZcode(body) {
  const nameById = new Map();
  for (const m of body.messages || []) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) if (b.type === 'tool_use') nameById.set(b.id, b.name);
    }
  }
  const out = [];
  for (const m of body.messages || []) {
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: textOf(m.content) }];
    if (m.role === 'user') {
      // tool_result blocks become tool messages; plain text becomes user message
      const texts = [];
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          out.push({
            role: 'tool',
            content: textOf(b.content),
            toolCallId: b.tool_use_id,
            toolName: nameById.get(b.tool_use_id) || 'unknown',
            ...(b.is_error ? { isError: true } : {}),
          });
        } else if (b.type === 'text') {
          texts.push(b.text);
        }
        // thinking/signature blocks dropped
      }
      if (texts.length) out.push({ role: 'user', content: texts.join('\n') });
    } else if (m.role === 'assistant') {
      const texts = [];
      const toolCalls = [];
      for (const b of blocks) {
        if (b.type === 'text') texts.push(b.text);
        else if (b.type === 'tool_use') toolCalls.push({ id: b.id || crypto.randomUUID(), name: b.name, input: b.input || {} });
        // redacted_thinking/thinking dropped
      }
      const entry = { role: 'assistant', content: texts.join('\n') };
      if (toolCalls.length) entry.toolCalls = toolCalls;
      out.push(entry);
    }
  }
  return out;
}

function parseJsonSafe(s) {
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return { _raw: s }; }
}

// ------------------------------------------------------------- HTTP layer ----
// Lazy: control commands (status/stop/logs) must not boot the whole runtime.
const clientPool = new Map();
function getClientForAccount(acc) {
  if (!acc) acc = activeAccount();
  let c = clientPool.get(acc.name);
  if (!c || !c.child || c.child.exitCode !== null) {
    c = new ZcodeClient(acc);
    clientPool.set(acc.name, c);
  }
  return c;
}
function getClient() {
  return getClientForAccount(activeAccount());
}

let roundRobinIdx = 0;
function getNextClient(excludeNames = new Set(), requestedModel = null) {
  const routing = getRoutingMode();
  const allUsable = getUsableAccounts();
  const usable = allUsable.filter(a => {
    if (excludeNames.has(a.name)) return false;
    if (requestedModel && !accountHasModelTokens(a.name, requestedModel)) return false;
    const c = clientPool.get(a.name);
    if (c && !c.ready) return false;
    return true;
  });
  const finalUsable = usable.length ? usable : allUsable.filter(a => !excludeNames.has(a.name));
  if (!usable.length) {
    // If all usable accounts are excluded or none usable, try any logged-in account not excluded
    const all = loadAccounts().accounts.filter(a => fs.existsSync(accountCredFile(a)));
    const remaining = all.filter(a => !excludeNames.has(a.name));
    const fallback = remaining.length ? remaining[0] : (all[0] || activeAccount());
    return getClientForAccount(fallback);
  }

  if (routing === 'fill-first') {
    const active = activeAccount();
    const actUsable = finalUsable.find(x => x.name === active.name);
    return getClientForAccount(actUsable || finalUsable[0]);
  }

  // Least-busy load balancing across usable accounts:
  // Routes traffic away from accounts currently processing heavy multi-turn prompts
  // (e.g. Claude Code 150k contexts) to completely idle accounts.
  let best = finalUsable[0];
  let minActive = Infinity;
  for (let i = 0; i < finalUsable.length; i++) {
    const idx = (roundRobinIdx + i) % finalUsable.length;
    const acc = finalUsable[idx];
    const c = clientPool.get(acc.name);
    const active = c ? (c.activeRequests || 0) : 0;
    if (active < minActive) {
      minActive = active;
      best = acc;
      if (active === 0) {
        roundRobinIdx = (idx + 1) % finalUsable.length;
        break; // Found an idle account, dispatch immediately!
      }
    }
  }
  return getClientForAccount(best);
}

function warmClientPool() {
  const usable = getUsableAccounts();
  for (const acc of usable) {
    getClientForAccount(acc);
  }
}

function shutdownClientPool() {
  for (const [, c] of clientPool) {
    try { if (c.child) c.child.kill('SIGTERM'); } catch {}
  }
}

function respawnClientPool() {
  for (const [, c] of clientPool) {
    try { if (c.child) c.child.kill('SIGHUP'); } catch {}
  }
}

async function generateWithFailover(options) {
  const requestedModel = options.modelId || 'GLM-5.3-Flash';
  const triedAccounts = new Set();
  const allAccounts = loadAccounts().accounts.filter(a => fs.existsSync(accountCredFile(a)));
  const maxAttempts = Math.max(1, allAccounts.length);
  let lastOut = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (options.signal && options.signal.aborted) {
      log('request already aborted by client, skipping failover');
      return lastOut || { error: { message: 'request aborted by client' } };
    }
    const c = getNextClient(triedAccounts, requestedModel);
    if (!c) break;
    const accName = (c && c.account) ? c.account.name : activeAccount().name;
    triedAccounts.add(accName);
    log(`dispatching request to account "${accName}" (mode: ${getRoutingMode()})`);

    let out = await c.generate(options);
    if (options.signal && options.signal.aborted) {
      log(`request aborted by client (acc=${accName}), stopping failover`);
      return out;
    }
    // Per-model empty: if this account drained the bucket covering the
    // requested model but OTHER accounts still have tokens for it, retry
    // there instead of failing over the whole request.
    if (out.error && !out.isQuotaExhausted) {
      const errText = JSON.stringify(out.error);
      const isModelQuota = /exceed quota|1005|insufficient.*quota|balance.*empty/i.test(errText);
      const modelInFlight = options.modelId || requestedModel;
      if (isModelQuota && !accountHasModelTokens(accName, modelInFlight)) {
        log(`account "${accName}" has no ${modelInFlight} tokens left, trying another account`);
        continue;
      }
    }

    if (!out.error) {
      clearAccountExhaustion(accName);
      return out;
    }

    lastOut = out;
    const isExhausted = out.isQuotaExhausted || /exceed quota|1005|balance.*empty|insufficient.*quota/i.test(JSON.stringify(out.error));

    if (isExhausted) {
      log(`account "${accName}" quota exhausted, marking paused`);
      markAccountExhausted(accName, '1005 quota exhausted');

      const remainingUsable = getUsableAccounts().filter(a =>
        !triedAccounts.has(a.name) && accountHasModelTokens(a.name, requestedModel));
      if (remainingUsable.length > 0) {
        log(`automatically failing over request to next account "${remainingUsable[0].name}"...`);
        continue;
      } else {
        markQuotaDrained();
        return {
          error: {
            message: 'All ZCode accounts exhausted (upstream code 1005). Wait for daily renewal (19:30) or add more accounts via `zbridge`.',
            type: 'insufficient_quota',
            code: 1005,
          }
        };
      }
    }

    // Transient upstream errors (concurrency/rate limits, timeouts): retry on
    // a DIFFERENT account after a short backoff instead of surfacing a 502 to
    // 9router. Concurrency hits are per-user upstream; another account (a
    // different Z.ai user) is very likely free.
    const errText2 = JSON.stringify(out.error);
    const isTransientErr = /concurrency|rate limit|too many|timeout|timed out|unusual activity|captcha/i.test(errText2);
    if (isTransientErr && attempt + 1 < maxAttempts) {
      log(`account "${accName}" transient error (${errText2.slice(0, 120)}), instantly failing over to next account`);
      continue;
    }
    // Non-quota error: return immediately (failover only covers 1005).
    return out;
  }

  return lastOut || { error: { message: 'All accounts failed' } };
}

// Start plan (rev-30 builtin, CLI 3.14.4): GLM-5.3-Flash, GLM-5.2, GLM-5-Turbo.
// Plain GLM-5.3 belongs to the coding-plan providers; if the start plan
// rejects it, generate() falls back to Flash automatically.
const MODEL_ALIAS = new Map([
  ['glm-5.3', 'GLM-5.3'],
  ['glm-5.3-flash', 'GLM-5.3-Flash'],
  ['glm-flash', 'GLM-5.3-Flash'],
  ['glm-5.2', 'GLM-5.2'],
  ['glm-5-turbo', 'GLM-5-Turbo'],
  ['glm-turbo', 'GLM-5-Turbo'],
]);
function resolveModel(name) {
  if (!name) return 'GLM-5.3-Flash';
  const key = String(name).toLowerCase();
  if (MODEL_ALIAS.has(key)) return MODEL_ALIAS.get(key);
  // tolerate prefixed/suffixed ids harnesses send (e.g. "zcode/glm-5.3",
  // "glm-5.3-flash@preview")
  if (/turbo/.test(key)) return 'GLM-5-Turbo';
  if (/flash/.test(key)) return 'GLM-5.3-Flash';
  if (/5\.3/.test(key)) return 'GLM-5.3';
  if (/5\.2/.test(key)) return 'GLM-5.2';
  return 'GLM-5.3-Flash'; // default; echo requested id in responses
}

function clampMaxTokens(n, dflt = 8192) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return dflt;
  // ZCode thinking (reasoningLevel max) consumes output budget first; tiny caps
  // reliably return empty content, so floor the upstream cap.
  return Math.max(512, Math.min(128_000, Math.floor(v)));
}

function reasoningFromRequest(body) {
  // GLM spends most of its wall time on "thinking" at max effort: the visible
  // text only appears afterwards, so harnesses measure a low t/s. Default to
  // the level ZCode's own thinking budget maps to fastest-but-usable, and let
  // the caller (or GLM_BRIDGE_REASONING) opt into slower/deeper thinking.
  const env = (process.env.GLM_BRIDGE_REASONING || '').toLowerCase();
  const eff = (body.reasoning_effort || body.reasoningEffort || '').toLowerCase();
  const pick = v => (v === 'low' || v === 'high' || v === 'max' ? v : (env || 'low'));
  if (eff) return pick(eff === 'minimal' ? 'low' : eff);
  if (body.thinking && body.thinking.type === 'enabled') {
    // Anthropic thinking budget: small budgets mean the caller wants it cheap.
    const b = Number(body.thinking.budget_tokens || 0);
    return env || (b && b <= 4096 ? 'low' : 'high');
  }
  return env || 'low';
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function openaiToolDefs(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const t of tools) {
    if (t.type === 'function' && t.function) {
      out.push({
        name: t.function.name,
        ...(t.function.description ? { description: t.function.description } : {}),
        inputSchema: t.function.parameters || { type: 'object', properties: {} },
      });
    } else if (t.name) {
      out.push({ name: t.name, ...(t.description ? { description: t.description } : {}), inputSchema: t.inputSchema || t.input_schema || { type: 'object', properties: {} } });
    }
  }
  return out;
}

function toOpenAIToolCalls(toolCalls) {
  return toolCalls.map(t => ({
    id: t.id,
    type: 'function',
    function: { name: t.name, arguments: JSON.stringify(t.input && t.input._raw !== undefined ? t.input._raw : (t.input || {})) },
  }));
}

async function handleChatCompletions(req, res, body) {
  log(`[chat/completions] model=${body.model} stream=${body.stream} msgs=${(body.messages || []).length} prompt=${JSON.stringify((body.messages || [])[0]?.content || '').slice(0, 60)}`);
  const requestedModel = body.model || 'GLM-5.3-Flash';
  const model = resolveModel(requestedModel);
  const systemBlocks = [
    ...REQUIRED_SYSTEM,
    ...(Array.isArray(body.messages) ? body.messages.filter(m => m.role === 'system') : []),
  ].map(m => ({ role: 'system', content: textOf(m.content) }));
  const messages = openaiToZcode((body.messages || []).filter(m => m.role !== 'system'));
  if (!messages.length) return sendJson(res, 400, { error: { message: 'messages required', type: 'invalid_request_error' } });

  const created = Math.floor(Date.now() / 1000);
  const id = 'chatcmpl-' + crypto.randomUUID();

  if (body.stream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const chunk = delta => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: requestedModel, choices: [delta] })}\n\n`;
    res.write(chunk({ index: 0, delta: { role: 'assistant' }, finish_reason: null }));

    const out = await generateWithFailover({
      systemBlocks,
      messages,
      tools: openaiToolDefs(body.tools),
      maxOutputTokens: clampMaxTokens(body.max_tokens ?? body.max_completion_tokens),
      reasoningLevel: reasoningFromRequest(body),
      modelId: model,
      signal: req.signal,
    });
    if (out.error) {
      res.write(`data: ${JSON.stringify({ error: { message: `upstream: ${out.error.message || JSON.stringify(out.error)}`, type: 'upstream_error' } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    const r = out.result || {};
    const toolCalls = (r.toolCalls && r.toolCalls.length) ? toOpenAIToolCalls(r.toolCalls) : null;
    const usage = r.usage || {};
    const finish = toolCalls ? 'tool_calls' : (r.finishReason === 'stop' || !r.finishReason ? 'stop' : r.finishReason);

    if (r.text) {
      const words = r.text.match(/\S+|\s+/g) || [r.text];
      for (const w of words) res.write(chunk({ index: 0, delta: { content: w } }));
    }
    if (toolCalls) res.write(chunk({ index: 0, delta: { tool_calls: toolCalls.map((t, i) => ({ index: i, ...t })) } }));
    res.write(chunk({ index: 0, delta: {}, finish_reason: finish }));
    if (body.stream_options && body.stream_options.include_usage) {
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: requestedModel, choices: [], usage: {
        prompt_tokens: usage.inputTokens || 0, completion_tokens: usage.outputTokens || 0, total_tokens: usage.totalTokens || 0,
      } })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  const out = await generateWithFailover({
    systemBlocks,
    messages,
    tools: openaiToolDefs(body.tools),
    maxOutputTokens: clampMaxTokens(body.max_tokens ?? body.max_completion_tokens),
    reasoningLevel: reasoningFromRequest(body),
    modelId: model,
    signal: req.signal,
  });
  if (out.error) {
    return sendJson(res, 502, { error: { message: `upstream: ${out.error.message || JSON.stringify(out.error)}`, type: 'upstream_error' } });
  }
  const r = out.result || {};
  const toolCalls = (r.toolCalls && r.toolCalls.length) ? toOpenAIToolCalls(r.toolCalls) : null;
  const usage = r.usage || {};
  const message = { role: 'assistant', content: r.text || '' };
  if (toolCalls) message.tool_calls = toolCalls;
  const finish = toolCalls ? 'tool_calls' : (r.finishReason === 'stop' || !r.finishReason ? 'stop' : r.finishReason);
  sendJson(res, 200, {
    id, object: 'chat.completion', created, model: requestedModel,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: {
      prompt_tokens: usage.inputTokens || 0,
      completion_tokens: usage.outputTokens || 0,
      total_tokens: usage.totalTokens || 0,
    },
  });
}

async function handleAnthropicMessages(req, res, body, stream) {
  const requestedModel = body.model || 'GLM-5.3-Flash';
  let sysBlocks = [];
  if (typeof body.system === 'string') sysBlocks = [{ role: 'system', content: body.system }];
  else if (Array.isArray(body.system)) {
    sysBlocks = body.system.filter(b => b && typeof b.text === 'string').map(b => ({ role: 'system', content: b.text }));
  }
  const systemBlocks = [...REQUIRED_SYSTEM, ...sysBlocks];
  const messages = anthropicToZcode(body);
  if (!messages.length) return sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'messages required' } });

  const id = 'msg_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  const created = Math.floor(Date.now() / 1000);

  if (stream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    res.write(ev('message_start', { type: 'message_start', message: {
      id, type: 'message', role: 'assistant', model: requestedModel, content: [],
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    } }));

    const out = await generateWithFailover({
      systemBlocks,
      messages,
      tools: openaiToolDefs((body.tools || []).map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      }))),
      maxOutputTokens: clampMaxTokens(body.max_tokens),
      reasoningLevel: reasoningFromRequest(body),
      modelId: resolveModel(requestedModel),
      signal: req.signal,
    });
    if (out.error) {
      res.write(ev('error', { type: 'error', error: { type: 'api_error', message: `upstream: ${out.error.message || JSON.stringify(out.error)}` } }));
      res.end();
      return;
    }
    const r = out.result || {};
    const stopReason = (r.toolCalls && r.toolCalls.length) ? 'tool_use' : 'end_turn';
    const usage = r.usage || {};
    let idx = 0;
    if (r.text) {
      res.write(ev('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } }));
      const words = r.text.match(/\S+|\s+/g) || [r.text];
      for (const w of words) {
        res.write(ev('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: w } }));
      }
      res.write(ev('content_block_stop', { type: 'content_block_stop', index: idx }));
      idx++;
    }
    for (const t of (r.toolCalls || [])) {
      res.write(ev('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: t.id, name: t.name, input: {} } }));
      res.write(ev('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(t.input || {}) } }));
      res.write(ev('content_block_stop', { type: 'content_block_stop', index: idx }));
      idx++;
    }
    if (idx === 0) {
      res.write(ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
      res.write(ev('content_block_stop', { type: 'content_block_stop', index: 0 }));
    }
    res.write(ev('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: usage.outputTokens || 0 } }));
    res.write(ev('message_stop', { type: 'message_stop' }));
    res.end();
    return;
  }

  const out = await generateWithFailover({
    systemBlocks,
    messages,
    tools: openaiToolDefs((body.tools || []).map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }))),
    maxOutputTokens: clampMaxTokens(body.max_tokens),
    reasoningLevel: reasoningFromRequest(body),
    modelId: resolveModel(requestedModel),
    signal: req.signal,
  });
  if (out.error) {
    return sendJson(res, 502, { type: 'error', error: { type: 'api_error', message: `upstream: ${out.error.message || JSON.stringify(out.error)}` } });
  }
  const r = out.result || {};
  const content = [];
  if (r.text) content.push({ type: 'text', text: r.text });
  for (const t of (r.toolCalls || [])) content.push({ type: 'tool_use', id: t.id, name: t.name, input: t.input || {} });
  const stopReason = (r.toolCalls && r.toolCalls.length) ? 'tool_use' : 'end_turn';
  const usage = r.usage || {};
  return sendJson(res, 200, {
    id, type: 'message', role: 'assistant', model: requestedModel,
    content, stop_reason: stopReason, stop_sequence: null,
    usage: { input_tokens: usage.inputTokens || 0, output_tokens: usage.outputTokens || 0 },
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 25 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function checkAuth(req) {
  const h = req.headers.authorization || '';
  const key = h.startsWith('Bearer ') ? h.slice(7) : (req.headers['x-api-key'] || '');
  return key === config.key;
}

const server = http.createServer(async (req, res) => {
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) {
      ac.abort();
    }
  });
  req.signal = ac.signal;
  const url = new URL(req.url, 'http://localhost');
  try {
    log(`[http] ${req.method} ${url.pathname} from port ${req.socket.remotePort} UA=${req.headers['user-agent'] || 'none'}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      const accountsData = loadAccounts();
      const anyCreds = accountsData.accounts.some(a => fs.existsSync(accountCredFile(a)));
      const clients = Array.from(clientPool.values());
      const cliRunning = clients.some(c => c.child && c.child.exitCode === null);
      const anyReady = clients.some(c => c.ready);
      const activeC = getClientForAccount(activeAccount());

      const accountsList = accountsData.accounts.map(a => {
        const hasCreds = fs.existsSync(accountCredFile(a));
        const p = accountPlans.get(a.name);
        const c = clientPool.get(a.name);
        const isExhausted = !!((a.exhaustedUntil && a.exhaustedUntil > Date.now()) ||
                               (a.quotaEmptyUntil && a.quotaEmptyUntil > Date.now()));
        return {
          name: a.name,
          active: a.name === accountsData.active,
          hasCredentials: hasCreds,
          ready: !!(c && c.ready),
          exhausted: isExhausted,
          exhaustedUntil: a.exhaustedUntil || null,
          quotaEmptyUntil: a.quotaEmptyUntil || null,
          quotaLeft: p ? p.quotaLeft : null,
          remainingTokens: p ? p.remainingTokens : null,
          totalTokens: p ? p.totalTokens : null,
        };
      });

      const drained = quotaState.lastQuotaAt > quotaState.lastOkAt;
      let action = null;
      if (drained) {
        if (planCache.active === false) {
          action = 'CLAIM NEEDED: open the ZCode desktop app and click Claim on the 100M tokens card'
            + ' (or run: glm-bridge claim) — the bridge\'s headless claim is blocked by captcha (3007)';
        } else if (planCache.active && planCache.endsAt) {
          const mins = Math.max(0, Math.round((planCache.endsAt * 1000 - Date.now()) / 60000));
          action = `plan active but quota drained — renews in ~${mins} min`
            + ` (at ${new Date(planCache.endsAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })});`
            + ' if a claim card is offered in the ZCode GUI, claiming it speeds this up';
        } else {
          action = 'quota drained — checking plan state; if no plan shows in the ZCode GUI, claim the 100M card there';
        }
      }
      if (Date.now() - planCache.at > 30_000) refreshPlan().catch(() => {});
      return sendJson(res, 200, {
        ok: true,
        ready: anyReady || !!(activeC && activeC.ready),
        routing: getRoutingMode(),
        account: activeAccount().name,
        accounts: accountsData.accounts.length,
        accountsList,
        captchaPool: tokens.length,
        cliRunning,
        credentials: anyCreds,
        quota: drained ? 'drained' : 'ok',
        quotaLeft: planCache.quotaLeft || null,
        quotaSummary: planCache.quotaSummary || null,
        quotaPercent: planCache.percent ?? null,
        quotaTokens: planCache.remainingTokens ?? null,
        quotaTotal: planCache.totalTokens ?? null,
        quotaDetails: planCache.balances || [],
        modelQuotas: planCache.modelQuotas || accountPlans.get(activeAccount().name)?.modelQuotas || {},
        plan: planCache.active === null ? 'unknown' : (planCache.active ? 'active' : 'missing'),
        action,
        detail: !cliRunning ? (activeC?.waitReason || 'CLI not running')
          : !anyCreds ? 'CLI running but ZCode credentials missing'
          : (anyReady || activeC?.ready) ? null : (activeC?.waitReason || 'CLI up, syncing account config'),
      });
    }
    if (req.method === 'POST' && url.pathname === '/reload') {
      warmClientPool();
      refreshPlan().catch(() => {});
      return sendJson(res, 200, { ok: true, accounts: loadAccounts().accounts.length });
    }
    if (!checkAuth(req)) return sendJson(res, 401, { error: { message: 'invalid api key', type: 'invalid_request_error' } });

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      // Distinct ids only (no case-duplicates — those showed up as
      // "2 glm5.3 flash" on 9router import). glm-5.3 is served via the
      // rejected-model fallback until an account has it entitled.
      return sendJson(res, 200, { object: 'list', data: [
        { id: 'glm-5.3', object: 'model', owned_by: 'zcode-start-plan', created: created_ts },
        { id: 'glm-5.3-flash', object: 'model', owned_by: 'zcode-start-plan', created: created_ts },
      ] });
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const raw = await readBody(req);
      let body; try { body = JSON.parse(raw || '{}'); } catch { return sendJson(res, 400, { error: { message: 'invalid JSON', type: 'invalid_request_error' } }); }
      return await handleChatCompletions(req, res, body);
    }
    if (req.method === 'POST' && url.pathname === '/v1/messages') {
      const raw = await readBody(req);
      let body; try { body = JSON.parse(raw || '{}'); } catch { return sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'invalid JSON' } }); }
      return await handleAnthropicMessages(req, res, body, body.stream === true);
    }
    if (req.method === 'POST' && url.pathname === '/v1/messages/count_tokens') {
      const raw = await readBody(req);
      let body; try { body = JSON.parse(raw || '{}'); } catch { /* fallthrough */ }
      const est = Math.max(1, Math.ceil(JSON.stringify(body || {}).length / 4));
      return sendJson(res, 200, { input_tokens: est });
    }
    sendJson(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
  } catch (e) {
    log('http error:', e.stack || e.message);
    if (!res.headersSent) sendJson(res, 500, { error: { message: e.message, type: 'server_error' } });
    else try { res.end(); } catch { /* ignore */ }
  }
});

const created_ts = Math.floor(Date.now() / 1000);

// ------------------------------------------------------------- CLI wrapper ---
// `glm-bridge start|stop|restart|status|logs|run` — cross-platform.
// Default (no args / `run`): run in foreground (systemd/schtasks uses this).
const argv = process.argv.slice(2);
const sub = (argv[0] || 'run').toLowerCase();

function isAlive(pid) {
  try {
    if (IS_WIN) {
      const txt = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
        { stdio: 'pipe', timeout: 10_000 }).toString();
      return txt.split(/\r?\n/)[0].startsWith('"');
    }
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

function readPid() {
  try { return Number(fs.readFileSync(PID_PATH, 'utf8').trim()) || null; } catch { return null; }
}

function writePid(pid) { fs.writeFileSync(PID_PATH, String(pid)); }
// Find whoever currently holds our TCP port (a stale instance from an earlier
// run would otherwise survive `stop` and block the next `start`).
function portHolders() {
  const out = [];
  const mine = new Set([readPid(), process.pid].filter(Boolean));
  const add = pid => { if (pid && !mine.has(pid)) out.push(pid); };
  try {
    if (IS_WIN) {
      const txt = execFileSync('netstat', ['-ano'], { stdio: 'pipe', timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }).toString();
      for (const line of txt.split(/\r?\n/)) {
        if (new RegExp(`[:.]${config.port}\\s`).test(line) && /LISTENING/i.test(line)) {
          add(Number(line.trim().split(/\s+/).pop()));
        }
      }
    } else {
      for (const bin of ['ss', 'lsof', 'fuser']) {
        try {
          if (bin === 'ss') {
            const txt = execFileSync('ss', ['-ltnpH'], { stdio: 'pipe', timeout: 10_000 }).toString();
            for (const line of txt.split(/\n/)) {
              if (line.includes(`:${config.port} `)) {
                for (const m of line.matchAll(/pid=(\d+)/g)) add(Number(m[1]));
              }
            }
          } else if (bin === 'lsof') {
            const txt = execFileSync('lsof', ['-ti', `tcp:${config.port}`, '-sTCP:LISTEN'], { stdio: 'pipe', timeout: 10_000 }).toString();
            for (const l of txt.split(/\n/)) if (l.trim()) add(Number(l.trim()));
          } else {
            const txt = execFileSync('fuser', [`${config.port}/tcp`], { stdio: 'pipe', timeout: 10_000 }).toString();
            for (const l of txt.split(/\s+/)) if (l) add(Number(l));
          }
          if (out.length) break;
        } catch { /* try next tool */ }
      }
    }
  } catch { /* best effort */ }
  return [...new Set(out)];
}

function spawnDetached() {
  const out = fs.openSync(LOG_PATH, 'a');
  const child = spawn(process.execPath, [__filename, 'run'], {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, GLM_BRIDGE_QUIET: '1' },
  });
  child.unref();
  return child.pid;
}

const SERVICE_NAME = 'glm-bridge';

// ------------------------------------------------------------- plan claim ----
// The ZCode "Start Plan" offer (100M tokens) refreshes daily and must be
// claimed, otherwise the bridge hits "exceed quota limit" (1005). Claiming
// needs the desktop's Aliyun captcha flow, so we delegate to claim-plan.js,
// which replays that flow in a headless browser and then POSTs the claim.
const CLAIM_SCRIPT = path.join(ASSET_DIR, 'claim-plan.js');
const CLAIM_AT = process.env.GLM_BRIDGE_CLAIM_AT || '19:30';
const CLAIM_PLAN = process.env.GLM_BRIDGE_PLAN || 'zcode-v3-start-plan';
const CLAIM_DISABLED = process.env.GLM_BRIDGE_CLAIM_DISABLE === '1';
let claiming = false;
let lastClaimAttempt = 0;

function runClaim(force) {
  if (claiming) return Promise.resolve({ ok: false, reason: 'claim already in flight' });
  if (!force && Date.now() - lastClaimAttempt < 10 * 60_000) {
    return Promise.resolve({ ok: false, reason: 'throttled' });
  }
  if (!fs.existsSync(CLAIM_SCRIPT)) {
    return Promise.resolve({ ok: false, reason: 'claim-plan.js missing' });
  }
  claiming = true;
  lastClaimAttempt = Date.now();
  const targets = loadAccounts().accounts.filter(a => fs.existsSync(accountCredFile(a)));
  if (!targets.length) {
    claiming = false;
    return Promise.resolve({ ok: false, reason: 'no logged-in accounts' });
  }
  const claimOne = (acc) => new Promise(resolve => {
    const argv = [CLAIM_SCRIPT, '--plan', CLAIM_PLAN, '--json'];
    if (force) argv.push('--force');
    log(`claim: starting for account "${acc.name}"` + (force ? ' (scheduled daily run)' : ''));
    execFile(process.execPath, argv,
      { env: { ...process.env, ...proxyEnv(), ZCODE_CREDENTIALS: accountCredFile(acc) },
        timeout: 12 * 60_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        const line = String(stdout || '').trim().split('\n').filter(Boolean).pop();
        let res = null;
        try { res = JSON.parse(line); } catch { /* fall through */ }
        if (!res) res = { ok: false, detail: String(stdout).slice(0, 300) || (err && err.message) || 'no output' };
        log(`claim[${acc.name}]: ` + JSON.stringify(res).slice(0, 600));
        resolve({ account: acc.name, ...res });
      });
  });
  return (async () => {
    const results = [];
    for (const acc of targets) results.push(await claimOne(acc));
    claiming = false;
    const okAll = results.every(r => r.ok || r.claimed);
    return { ok: okAll, results };
  })();
}

function scheduleClaims() {
  if (CLAIM_DISABLED) { log('claim: auto-claim disabled (GLM_BRIDGE_CLAIM_DISABLE=1)'); return; }
  const parts = String(CLAIM_AT).split(':');
  const hh = Number(parts[0]);
  const mm = Number(parts[1]);
  const now = new Date();
  const next = new Date(now);
  next.setHours(Number.isFinite(hh) ? hh : 19, Number.isFinite(mm) ? mm : 30, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const wait = next - now;
  log(`claim: daily attempt at ${CLAIM_AT} (in ${Math.round(wait / 60000)} min); ` +
      `self-heal check every 30 min while the plan is inactive`);
  setTimeout(() => {
    runClaim(true).finally(() => setTimeout(scheduleClaims, 5000));
  }, wait);
  setInterval(() => { runClaim(false).catch(() => {}); }, 30 * 60_000);
}
// ------------------------------------------------------- autostart / tray ---
function autostartOn() {
  if (IS_WIN) {
    // /XML output is not localized and distinguishes disabled tasks from
    // existing ones (plain /Query returns 0 even for a disabled task).
    try {
      const xml = execFileSync('schtasks', ['/Query', '/TN', SERVICE_NAME, '/XML'],
        { stdio: 'pipe', timeout: 15_000 }).toString();
      return /<Enabled>true<\/Enabled>/.test(xml);
    } catch { return false; }
  }
  // systemd user unit if installed, else the XDG autostart entry
  try { execFileSync('systemctl', ['--user', 'is-enabled', SERVICE_NAME + '.service'], { stdio: 'pipe', timeout: 15_000 }); return true; }
  catch (e) { if (String(e.stdout || '').trim() === 'enabled') return true; }
  return fs.existsSync(path.join(HOME, '.config', 'autostart', SERVICE_NAME + '.desktop'));
}
function setAutostart(on) {
  if (IS_WIN) {
    try {
      if (on) execFileSync('schtasks', ['/Change', '/TN', SERVICE_NAME, '/ENABLE'], { stdio: 'pipe' });
      else execFileSync('schtasks', ['/Change', '/TN', SERVICE_NAME, '/DISABLE'], { stdio: 'pipe' });
    } catch (e) { console.error('autostart change failed:', e.message); }
    return;
  }
  const unit = path.join(HOME, '.config', 'systemd', 'user', SERVICE_NAME + '.service');
  const desktop = path.join(HOME, '.config', 'autostart', SERVICE_NAME + '.desktop');
  if (fs.existsSync(unit)) {
    try { execFileSync('systemctl', ['--user', on ? 'enable' : 'disable', SERVICE_NAME + '.service'], { stdio: 'pipe' }); }
    catch (e) { console.error('systemctl failed:', e.message); }
    return;
  }
  if (on) {
    fs.mkdirSync(path.dirname(desktop), { recursive: true });
    fs.writeFileSync(desktop, `[Desktop Entry]\nType=Application\nName=GLM bridge\nExec="${process.execPath}" "${ASSET_DIR}/glm-bridge.js" run\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`);
  } else { fs.rmSync(desktop, { force: true }); }
}
function killTray() {
  try {
    const t = Number(fs.readFileSync(TRAY_PID_PATH, 'utf8').trim());
    if (t) {
      // tray.sh is spawned detached (its own process group): kill the group so
      // the yad child dies too, otherwise systemd's cgroup stop times out.
      try { process.kill(-t, 'SIGTERM'); } catch { process.kill(t, 'SIGTERM'); }
    }
  } catch { /* no tray */ }
  fs.rmSync(TRAY_PID_PATH, { force: true });
}
function startTray() {
  if (IS_WIN) {
    const ps1 = path.join(ASSET_DIR, 'tray.ps1');
    if (!fs.existsSync(ps1)) { console.error('tray.ps1 missing'); process.exitCode = 1; return; }
    spawn('powershell', ['-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', ps1],
      { stdio: 'ignore', detached: true }).unref();
    console.log('tray started (Windows NotifyIcon)');
    return;
  }
  const py = path.join(ASSET_DIR, 'tray.py');
  if (fs.existsSync(py)) {
    spawn('python3', [py], { stdio: 'ignore', detached: true, env: { ...process.env, GLM_BRIDGE_HOME: STATE_DIR } }).unref();
    console.log('tray started (AppIndicator)');
    return;
  }
  const sh = path.join(ASSET_DIR, 'tray.sh');
  if (!fs.existsSync(sh)) { console.error('tray helper missing'); process.exitCode = 1; return; }
  spawn('sh', [sh], { stdio: 'ignore', detached: true, env: { ...process.env, GLM_BRIDGE_HOME: STATE_DIR } }).unref();
  console.log('tray started (legacy)');
}

// ------------------------------------------------------ account commands ----
async function cliLogin(name) {
  const cli = resolveCliRoot();
  if (!cli) { console.error('zcode.cjs not found — install ZCode first (or set GLM_BRIDGE_CLI)'); process.exitCode = 1; return; }
  const builtin = findBuiltinFile();
  const accs = loadAccounts();
  let acc = name ? accs.accounts.find(a => a.name === name) : null;
  if (name && !acc) {
    // new account: its own data base dir under STATE_DIR/accounts/<name>
    const dir = path.join(STATE_DIR, 'accounts', name);
    fs.mkdirSync(dir, { recursive: true });
    acc = { name, dir, addedAt: Date.now() };
    accs.accounts.push(acc);
    saveAccounts(accs);
    console.log(`created account "${name}" -> ${dir}`);
  }
  if (!acc) acc = activeAccount();
  const env = {
    ...process.env, ...proxyEnv(),
    ZCODE_DATA_BASE_DIR: acc.dir,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: path.join(acc.dir, '.zcode', 'v2', 'provider_config.json'),
  };
  if (builtin) env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = builtin;
  console.log(`\n================================================================================`);
  console.log(`  Logging in Z.AI Account "${acc.name}"`);
  console.log(`================================================================================\n`);
  console.log(`Starting login helper...`);

  // Retry loop: the OAuth init POST to chat.z.ai intermittently fails when
  // egress flaps ("Error: fetch failed") — the child exits before printing
  // any URL. Retry up to 3 times before giving up.
  const loginStartedAt = Date.now();
  let loginCode = 1;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) {
      console.log(`\nretrying login (attempt ${attempt}/3) in 3s...`);
      await new Promise(r => setTimeout(r, 3000));
    }
    loginCode = await new Promise(resolve => {
      // On Windows the CLI auto-opens the browser via `cmd /c start "" <url>`;
      // the URL is passed unquoted, so cmd splits it at the first '&' and the
      // browser opens a param-less authorize URL ("Field required" error).
      // Use --no-browser there and open the URL ourselves, quoted.
      const args = [cli, 'login'];
      if (process.platform === 'win32') args.push('--no-browser');
      const p = spawn(process.execPath, args, { env, stdio: ['inherit', 'pipe', 'pipe'] });
      let urlFound = false;

      const onData = (chunk) => {
        const text = chunk.toString();
        const urlMatch = text.match(/https:\/\/chat\.z\.ai\/api\/oauth\/authorize\S+/);
        if (urlMatch && !urlFound) {
          urlFound = true;
          const authUrl = urlMatch[0];
          // Windows-safe auto-open: quote the URL for cmd's `start`.
          try {
            if (process.platform === 'win32') {
              spawn('cmd.exe', ['/c', 'start', '', authUrl], { detached: true, stdio: 'ignore' }).unref();
            } else if (process.platform === 'darwin') {
              spawn('open', [authUrl], { detached: true, stdio: 'ignore' }).unref();
            } else {
              spawn('xdg-open', [authUrl], { detached: true, stdio: 'ignore' }).unref();
            }
            console.log(`Opening your browser...\n`);
          } catch { /* fall back to manual copy/paste */ }
          console.log(`\n┌────────────────────────────────────────────────────────────────────────┐`);
          console.log(`│  AUTHORIZATION LINK:                                                   │`);
          console.log(`│                                                                        │`);
          console.log(`│  ${authUrl}`);
          console.log(`│                                                                        │`);
          console.log(`│  ★ TO LINK A SECOND / DIFFERENT ACCOUNT:                               │`);
          console.log(`│    Open this link in a PRIVATE / INCOGNITO browser window so you can   │`);
          console.log(`│    sign in with a DIFFERENT phone number / account!                    │`);
          console.log(`└────────────────────────────────────────────────────────────────────────┘\n`);
          console.log(`Waiting for sign-in completion in browser (or Ctrl+C to cancel)...\n`);
        } else if (!urlFound) {
          process.stdout.write(text);
        }
      };

      p.stdout.on('data', onData);
      p.stderr.on('data', d => {
        const s = d.toString();
        if (!s.includes('ZCode Built-in Provider Config')) process.stderr.write(s);
      });
      p.on('exit', code => resolve(code === 0 ? 0 : 1));
    });
    // Success criteria: fresh credentials written during THIS login attempt.
    const credFile = accountCredFile(acc);
    const fresh = fs.existsSync(credFile) && fs.statSync(credFile).mtimeMs >= loginStartedAt;
    if (fresh) { loginCode = 0; break; }
    if (loginCode === 0 && !fresh) {
      console.log('\n⚠ process exited but no fresh credentials were written (stale credentials file present).');
      loginCode = 1;
    }
    // If the URL was shown, do NOT retry — the user may be mid-sign-in; wait
    // is handled above by the child blocking until completion or Ctrl+C.
  }

  if (loginCode === 0 && fs.existsSync(accountCredFile(acc))) {
    credCache.clear();
    clearAccountExhaustion(acc.name);
    console.log(`\n✔ Login successful for "${acc.name}"!`);
    // Auto-claim: a fresh account only carries the baseline 3M+5M daily plan;
    // the 100M trust offer is claimable right after signup — mint a captcha
    // token and claim it headlessly (same route as the GUI button).
    console.log(`  checking for claimable plan offers...`);
    try {
      const { execFile } = require('child_process');
      // claim-plan.js requires X-Device-Mid (preview returns 3001 without it).
      // A pure CLI login may not have written telemetry-state.json yet — the
      // GUI writes it on first API use. Create it with a random UUID if so.
      const v2Dir = path.join(acc.dir, '.zcode', 'v2');
      const telemetryFile = path.join(v2Dir, 'telemetry-state.json');
      if (!fs.existsSync(telemetryFile)) {
        try { fs.mkdirSync(v2Dir, { recursive: true }); } catch {}
        const mid = crypto.randomUUID();
        fs.writeFileSync(telemetryFile, JSON.stringify({ deviceMid: mid }, null, 2));
        log(`generated deviceMid ${mid} for "${acc.name}"`);
      }
      const claimScript = path.join(__dirname, 'claim-plan.js');
      if (fs.existsSync(claimScript)) {
        await new Promise(resolve => {
          execFile(process.execPath, [claimScript], {
            env: { ...process.env, ...proxyEnv(), ZCODE_CREDENTIALS: accountCredFile(acc) },
            timeout: 180_000,
          }, (err, stdout) => {
            const s = String(stdout || '').trim();
            if (s) console.log(`  claim: ${s}`);
            resolve();
          });
        });
      }
    } catch {}
    await refreshAccountPlan(acc).catch(() => {});
    const plan = accountPlans.get(acc.name);
    if (plan && plan.quotaLeft) {
      console.log(`  Initial Quota: ${plan.quotaLeft}`);
    }
    if (accs.active !== acc.name && name) {
      console.log(`  Switch active account: glm-bridge use ${name}`);
    }
    try {
      await fetch(`http://127.0.0.1:${config.port}/reload`, { method: 'POST', signal: AbortSignal.timeout(1500) });
    } catch {}
  } else if (loginCode !== 0) {
    console.log('\n✖ Login failed after 3 attempts (network error or cancelled).');
    process.exitCode = 1;
  } else {
    console.log('\n✖ Credentials not written — login may have timed out or been cancelled.');
    process.exitCode = 1;
  }
}
function cliLogout(name) {
  const accs = loadAccounts();
  const acc = name ? accs.accounts.find(a => a.name === name) : activeAccount();
  if (!acc) { console.error(`account "${name}" not found`); process.exitCode = 1; return; }
  fs.rmSync(accountCredFile(acc), { force: true });
  if (acc.name === 'main') {
    // also ask the CLI to clear shared state it may hold for $HOME
    try {
      const cli = resolveCliRoot();
      if (cli) execFileSync(process.execPath, [cli, 'logout'], { stdio: 'pipe', timeout: 30_000, env: { ...process.env, ZCODE_DATA_BASE_DIR: acc.dir } });
    } catch { /* best effort */ }
  }
  console.log(`logged out "${acc.name}"`);
}
function listAccounts() {
  const a = loadAccounts();
  const routing = getRoutingMode();
  console.log(`Routing mode: ${routing}\n`);
  for (const x of a.accounts) {
    const loggedIn = fs.existsSync(accountCredFile(x));
    const exhausted = (x.exhaustedUntil && x.exhaustedUntil > Date.now()) || (x.quotaEmptyUntil && x.quotaEmptyUntil > Date.now());
    const reason = x.exhaustedUntil ? `exhausted-until ${new Date(x.exhaustedUntil).toLocaleTimeString()}` : (x.quotaEmptyUntil ? 'quota-empty' : '');
    const p = accountPlans.get(x.name);
    const qStr = p && p.quotaLeft ? `\t${p.quotaLeft}` : '';
    console.log(`${x.name === a.active ? '*' : ' '} ${x.name}\t${loggedIn ? 'logged-in' : 'no-credentials'}` +
      `${exhausted ? '\t' + reason : '\tactive'}${qStr}\t${x.dir}`);
  }
}
function useAccount(name) {
  if (!name) { console.error('usage: glm-bridge use <name>'); process.exitCode = 1; return; }
  const a = loadAccounts();
  const acc = a.accounts.find(x => x.name === name);
  if (!acc) { console.error(`account "${name}" not found (see: glm-bridge accounts)`); process.exitCode = 1; return; }
  if (!fs.existsSync(accountCredFile(acc))) console.warn(`warn: "${name}" has no credentials — run: glm-bridge login ${name}`);
  a.active = name; saveAccounts(a);
  credCache.clear();
  console.log(`active account: ${name}`);
}

async function ctl() {
  // If something is already serving our port but the pid file is stale or
  // missing, adopt that process so status/stop act on the real owner.
  const adoptPortHolder = () => {
    const holders = portHolders();
    if (holders.length === 1) {
      try { writePid(holders[0]); } catch { /* ignore */ }
      return holders[0];
    }
    return null;
  };
  let pid = readPid();
  let alive = !!(pid && isAlive(pid));
  // If a service manager owns the bridge, delegate to it: otherwise systemd /
  // the Scheduled Task would immediately resurrect a process we just killed.
  const service = (() => {
    if (IS_WIN) {
      try {
        execFileSync('schtasks', ['/Query', '/TN', SERVICE_NAME], { stdio: 'pipe', timeout: 15_000 });
        return { kind: 'schtasks', name: SERVICE_NAME };
      } catch { return null; }
    }
    try {
      execFileSync('systemctl', ['--user', 'cat', SERVICE_NAME + '.service'], { stdio: 'pipe', timeout: 15_000 });
      return { kind: 'systemd', name: SERVICE_NAME };
    } catch { return null; }
  })();
  const svc = (action) => {
    try {
      if (service.kind === 'systemd') {
        execFileSync('systemctl', ['--user', action, service.name], { stdio: 'pipe', timeout: 30_000 });
      } else if (action === 'start') {
        execFileSync('schtasks', ['/Run', '/TN', service.name], { stdio: 'pipe', timeout: 30_000 });
      } else if (action === 'restart') {
        // schtasks has no restart: End is best-effort (task may not be running),
        // then Run it again — End alone left Windows restarts timing out.
        try { execFileSync('schtasks', ['/End', '/TN', service.name], { stdio: 'pipe', timeout: 30_000 }); } catch { /* not running */ }
        execFileSync('schtasks', ['/Run', '/TN', service.name], { stdio: 'pipe', timeout: 30_000 });
      } else {
        execFileSync('schtasks', ['/End', '/TN', service.name], { stdio: 'pipe', timeout: 30_000 });
      }
      return true;
    } catch { return false; }
  };
  const svcState = () => {
    try {
      if (service.kind === 'systemd') {
        return execFileSync('systemctl', ['--user', 'is-active', service.name], { stdio: 'pipe', timeout: 15_000 }).toString().trim();
      }
      execFileSync('schtasks', ['/Query', '/TN', service.name], { stdio: 'pipe', timeout: 15_000 });
      return 'running';
    } catch { return 'inactive'; }
  };
  const health = async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(2000) });
      return r.ok;
    } catch { return false; }
  };
  if (sub === 'start' || sub === 'restart') {
    if (sub === 'start' && (await health())) {
      console.log(alive ? `already running (pid ${pid})` : 'already running');
      return;
    }
    if (service) {
      svc(sub === 'restart' ? 'restart' : 'start');
    } else if (sub === 'restart') {
      stop();
      await new Promise(r => setTimeout(r, 1200));
    }
    if (service) {
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        if (await health()) { console.log(`started -> http://127.0.0.1:${config.port}/v1`); return; }
        await new Promise(r => setTimeout(r, 400));
      }
      console.error('start timed out; last log lines:');
      try { console.log(fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean).slice(-6).join('\n')); } catch {}
      process.exitCode = 1;
      return;
    }
    const newPid = spawnDetached();
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (await health()) {
        console.log(`started (pid ${newPid}) -> http://127.0.0.1:${config.port}/v1`);
        return;
      }
      if (newPid && !isAlive(newPid)) break; // died: report instead of waiting out the timeout
      await new Promise(r => setTimeout(r, 400));
    }
    console.error('start failed; last log lines:');
    try { console.log(fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean).slice(-6).join('\n')); } catch {}
    process.exitCode = 1;
  } else if (sub === 'stop') {
    if (service) {
      console.log(`stopping via ${service.kind}...`);
      svc('stop');
      await new Promise(r => setTimeout(r, 800));
      if (await health()) { console.log('service stop did not take; killing directly...'); stop(); }
      else console.log('stopped');
    } else { stop(); }
  } else if (sub === 'status') {
    const up = await health();
    if (up && !alive) { const adopted = adoptPortHolder(); if (adopted) { pid = adopted; alive = true; } }
    const via = service ? `${service.kind}:${svcState()}` : 'process';
    console.log(up ? `running (pid ${pid || 'unknown'}, ${via})` : `stopped (${via})`);
    if (up) {
      try {
        const h = await (await fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(3000) })).json();
        console.log(JSON.stringify(h));
        if (h.modelQuotas && Object.keys(h.modelQuotas).length) {
          console.log('\nModel Quotas:');
          for (const [mName, mData] of Object.entries(h.modelQuotas)) {
            console.log(`  • ${mName.padEnd(16)}: ${mData.label || mData.remainingFormatted}`);
          }
        }
      } catch { console.log('health: unreachable'); }
    } else if (!alive) {
      process.exitCode = 1;
    }
  } else if (sub === 'claim') {
    const force = argv.includes('--force');
    const r = await runClaim(force);
    let captchaBlocked = false;
    const report = (acct, x) => {
      const line = x.claimed ? 'claimed' : (x.ok ? (x.reason || 'ok') : 'FAILED ' + (x.detail || ''));
      console.log(`${acct}: ${line}`);
      if (!x.claimed && /3007|captcha/i.test(String(x.detail || ''))) captchaBlocked = true;
    };
    if (r.results) {
      for (const x of r.results) report(x.account, x);
      if (!r.ok) process.exitCode = 1;
    } else if (r.claimed) console.log('claimed: ' + (r.planId || CLAIM_PLAN));
    else {
      report('claim', r);
      if (!r.ok) process.exitCode = 1;
    }
    if (captchaBlocked) {
      console.error('\nheadless captcha was rejected (3007). GUI fallback:');
      console.error('  open the ZCode desktop app → click "Claim" on the 100M tokens card.');
      console.error('  The bridge picks the plan up automatically within a minute.');
    }
  } else if (sub === 'autostart') {
    console.log(autostartOn() ? 'on' : 'off');
  } else if (sub === 'autostart-toggle') {
    const now = autostartOn();
    setAutostart(!now);
    console.log(autostartOn() ? 'on' : 'off');
  } else if (sub === 'quit') {
    // Full stop: tray, service/process — the "Quit" tray item.
    killTray();
    if (service) { svc('stop'); stop(); } else { stop(); }
  } else if (sub === 'tray') {
    startTray();
  } else if (sub === 'login') {
    await cliLogin(argv[1]);
  } else if (sub === 'logout') {
    cliLogout(argv[1]);
  } else if (sub === 'accounts') {
    listAccounts();
  } else if (sub === 'use') {
    useAccount(argv[1]);
  } else if (sub === 'routing') {
    const mode = argv[1];
    if (mode) {
      try {
        setRoutingMode(mode);
        console.log(`routing mode set to: ${mode}`);
      } catch (e) {
        console.error(e.message);
        process.exitCode = 1;
      }
    } else {
      console.log(`current routing mode: ${getRoutingMode()}`);
    }
  } else if (sub === 'logs') {
    const n = Number(argv[1] || 40);
    try {
      const lines = fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean);
      console.log(lines.slice(-n).join('\n'));
    } catch { console.log('no logs yet'); }
  } else if (sub === 'run') {
    // handled in main()
  } else if (sub === 'help' || sub === '--help' || sub === '-h') {
    console.log('usage: glm-bridge [start|stop|restart|status|logs [n]|run|claim [--force]|quit|tray|autostart|autostart-toggle|login [name]|logout [name]|accounts|use <name>]');
  } else {
    console.error(`unknown command: ${sub}`);
    process.exitCode = 1;
  }

  function stop() {
    const targets = [];
    if (alive) targets.push(pid);
    targets.push(...portHolders());
    if (!targets.length) {
      console.log('not running');
      try { fs.rmSync(PID_PATH, { force: true }); } catch {}
      return;
    }
    for (const t of targets) {
      try {
        if (IS_WIN) execFileSync('taskkill', ['/PID', String(t), '/T', '/F'], { stdio: 'pipe', timeout: 10_000 });
        else { try { process.kill(-t, 'SIGTERM'); } catch { process.kill(t, 'SIGTERM'); } }
        console.log(`stopped (pid ${t})`);
      } catch (e) { console.error(`stop failed (pid ${t}):`, e.message); }
    }
    try { fs.rmSync(PID_PATH, { force: true }); } catch {}
  }
}

async function main() {
  if (sub === 'run') {
    boot();
    return;
  }
  if (['status','start','restart','stop','logs','claim','help','--help','-h',
       'quit','tray','autostart','autostart-toggle','login','logout','accounts','use','routing'].includes(sub)) {
    await ctl();
    return;
  }
  if (sub === 'tui') {
    const tui = path.join(ASSET_DIR, 'zbridge.js');
    if (!fs.existsSync(tui)) { console.error('zbridge.js missing'); process.exitCode = 1; return; }
    spawn(process.execPath, [tui], { stdio: 'inherit', env: { ...process.env, GLM_BRIDGE_HOME: STATE_DIR } })
      .on('exit', c => { process.exitCode = c || 0; });
    return;
  }
  console.error(`unknown command: ${sub}`);
  process.exitCode = 1;
}

function boot() {
  writePid(process.pid);
  loadTokens();
  saveTokens();

  server.listen(config.port, '127.0.0.1', () => {
    log(`glm-bridge listening on http://127.0.0.1:${config.port}/v1 (key: ${config.key})`);
  });

  // Spawn the CLI immediately; when the connectivity probe settles on a
  // non-direct route, the periodic checker respawns the child (SIGHUP ->
  // exit handler) so it inherits the proxy env. This keeps /health truthful
  // within seconds on machines where every probe times out (VPN off etc.).
  warmClientPool();
  resolveProxy(true)
    .then(() => refreshPlan())          // warm plan cache for /health actions
    .then(() => captchaPolicyRequired())
    .then(() => { if (tokens.length < 4) ensureTokens(); })   // pre-warm for GLM-5.3
    .catch(e => log('bootstrap error:', e.message));

  scheduleClaims();

  // System tray (best-effort): Auto-start toggle + Quit. Skip when disabled
  // or when there is no display / helper script.
  if (process.env.GLM_BRIDGE_TRAY !== '0') {
    try {
      const trayPid = Number(fs.existsSync(TRAY_PID_PATH) ? fs.readFileSync(TRAY_PID_PATH, 'utf8') : 0);
      const trayAlive = trayPid && isAlive(trayPid);
      if (!trayAlive) {
        if (IS_WIN) {
          const ps1 = path.join(ASSET_DIR, 'tray.ps1');
          if (fs.existsSync(ps1)) {
            spawn('powershell', ['-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', ps1],
              { stdio: 'ignore', detached: true }).unref();
            log('tray helper started (Windows NotifyIcon)');
          }
        } else {
          const py = path.join(ASSET_DIR, 'tray.py');
          const sh = path.join(ASSET_DIR, 'tray.sh');
          if (fs.existsSync(py)) {
            spawn('python3', [py],
              { stdio: 'ignore', detached: true, env: { ...process.env, GLM_BRIDGE_HOME: STATE_DIR } }).unref();
            log('tray helper started (AppIndicator)');
          } else if (fs.existsSync(sh)) {
            spawn('sh', [sh],
              { stdio: 'ignore', detached: true, env: { ...process.env, GLM_BRIDGE_HOME: STATE_DIR } }).unref();
            log('tray helper started (sh/yad)');
          }
        }
      }
    } catch (e) { log('tray start skipped:', e.message); }
  }

  setInterval(async () => {
    const before = resolvedProxy;
    await resolveProxy(true);
    if (resolvedProxy !== before) {
      log(`connectivity changed (${before || 'direct'} -> ${resolvedProxy || 'direct'}), respawning client pool`);
      respawnClientPool();
    }
    // Always keep a small captcha pool: GLM-5.3 (premium) requests MUST carry
    // a token or the upstream silently downgrades them to Flash (billing the
    // Flash bucket). Minting ~60s/token means the pool must be pre-warmed,
    // not built on demand.
    captchaPolicyRequired().then(() => { if (tokens.length < 4) ensureTokens(); }).catch(() => {});
  }, 5 * 60_000);

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      log('shutting down');
      // Kill the tray helper too: it lives in this cgroup, and systemd would
      // otherwise wait for it, time out and mark the unit failed on every stop.
      try { killTray(); } catch { /* ignore */ }
      try { shutdownClientPool(); } catch { /* ignore */ }
      try { fs.rmSync(PID_PATH, { force: true }); } catch {}
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000);
    });
  }
}

main().catch(e => { console.error(e); process.exit(1); });
