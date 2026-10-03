#!/usr/bin/env node
/*
 * claim-plan.js — claim the daily ZCode "Start Plan" offer.
 *
 * POST /api/v1/zcode-plan/billing/claim needs a fresh Aliyun captcha verify
 * param, and that param only exists once the Aliyun SDK has run inside a real
 * browser page. We therefore replay the desktop app's own init — popup mode,
 * a real <button> trigger, showErrorTip:false — on zcode.z.ai and capture what
 * captchaVerifyCallback hands back. Anything less and the callback never fires.
 *
 * Usage:
 *   node claim-plan.js [--plan <id>] [--force] [--dry-run] [--json]
 *
 * Prints one JSON line with --json:
 *   {"ok":true,"claimed":true,"planId":...,"detail":...}
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');

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

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const PLAN_ID = argOf('--plan', process.env.GLM_BRIDGE_PLAN || 'zcode-v3-start-plan');
const JSON_OUT = args.includes('--json');
const DRY = args.includes('--dry-run');
const FORCE = args.includes('--force');   // claim even if a plan already looks active
const PREVIEW_ONLY = args.includes('--preview');  // list claimable offers, no claim
// The GNOME proxy (10.70.109.39:8080) comes and goes with the corporate
// network. A dead proxy poisons BOTH the claim requests and the captcha
// browser (ERR_PROXY_CONNECTION_FAILED), so PROBE it per-run (resolveProxy()
// below, awaited at startup): only prefer it when direct egress is down AND
// the proxy answers.
let PROXY = '';
const MINT_PROXY = process.env.MINT_PROXY || process.env.GLM_BRIDGE_MINT_PROXY || '';

async function resolveProxy() {
  if (MINT_PROXY) return MINT_PROXY;
  const cands = [
    process.env.GLM_BRIDGE_PROXY,
    process.env.HTTPS_PROXY, process.env.https_proxy,
    process.env.ALL_PROXY, process.env.all_proxy,
    getSystemProxy(),
  ].filter(Boolean);
  const probe = (args) => new Promise(res => {
    execFile('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '-m', '6', ...args,
      'https://zcode.z.ai/'], { timeout: 9000 }, (e, out) => {
      res((Number(String(out).trim()) || 0) > 0);
    });
  });
  if (await probe([])) return '';                       // direct works — no proxy
  for (const p of cands) {
    const url = p.startsWith('http') ? p : `http://${p}`;
    if (await probe(['-x', url])) return url;           // first working proxy
  }
  return '';                                            // nothing works: try direct anyway
}

const HOME = os.homedir();
const say = m => { if (!JSON_OUT) process.stderr.write('[claim] ' + m + '\n'); };
const emit = obj => console.log(JSON.stringify(obj));

// The desktop attaches X-Device-Mid to EVERY API call (preview returns 3001
// without it); it lives beside the credentials in telemetry-state.json.
function deviceMid() {
  try {
    const credFile = process.env.ZCODE_CREDENTIALS || path.join(HOME, '.zcode', 'v2', 'credentials.json');
    const state = path.join(path.dirname(credFile), 'telemetry-state.json');
    const mid = JSON.parse(fs.readFileSync(state, 'utf8')).deviceMid;
    return typeof mid === 'string' && mid ? mid : '';
  } catch { return ''; }
}
const SOURCE_HEADERS = () => {
  const h = ['-H', 'X-ZCode-App-Version: 3.14.4',
             '-H', `X-Platform: ${process.platform}-${process.arch}`,
             '-H', 'X-Client-Language: en-US'];
  const mid = deviceMid();
  if (mid) h.push('-H', 'X-Device-Mid: ' + mid);
  return h;
};

// ------------------------------------------------------------- credentials --
function zcodeJwt() {
  const file = process.env.ZCODE_CREDENTIALS || path.join(HOME, '.zcode', 'v2', 'credentials.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const blob = raw['zcodejwttoken'];
  if (!blob) throw new Error('zcodejwttoken missing from credentials.json');
  if (!blob.startsWith('enc:v1:')) return blob;
  const [ivB, tagB, ctB] = blob.slice(6).split('.');
  const b = s => Buffer.from(s, 'base64url');
  const secret = process.env.ZCODE_CREDENTIAL_SECRET
    || `zcode-credential-fallback:${os.platform()}:${HOME}:${os.userInfo().username}`;
  const key = crypto.createHash('sha256').update(secret).digest();
  const d = crypto.createDecipheriv('aes-256-gcm', key, b(ivB));
  d.setAuthTag(b(tagB));
  return Buffer.concat([d.update(b(ctB)), d.final()]).toString('utf8');
}

// --------------------------------------------------------------- chromium ---
function findChromium() {
  if (process.env.GLM_BRIDGE_CHROMIUM) return process.env.GLM_BRIDGE_CHROMIUM;
  const roots = process.platform === 'win32'
    ? [path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'ms-playwright')]
    : process.platform === 'darwin'
      ? [path.join(HOME, 'Library', 'Caches', 'ms-playwright')]
      : [path.join(HOME, '.cache', 'ms-playwright')];
  const rel = [
    ['chrome-win', 'chrome.exe'],
    ['chrome-win64', 'chrome.exe'],
    ['chrome-linux64', 'chrome'],
    ['chrome-linux', 'chrome'],
    ['chrome-headless-shell-linux64', 'chrome-headless-shell'],
    ['chrome-mac/Google Chrome for Testing.app/Contents/MacOS', 'Google Chrome for Testing'],
  ];
  for (const root of roots) {
    let all = [];
    try { all = fs.readdirSync(root).filter(d => /^chromium/.test(d)).sort().reverse(); } catch { continue; }
    // Prefer full Chromium: the Aliyun SDK never completes inside
    // chrome-headless-shell — the verify callback simply never fires.
    const dirs = [
      ...all.filter(d => !d.includes('headless_shell')),
      ...all.filter(d => d.includes('headless_shell')),
    ];
    for (const d of dirs) for (const [dir, leaf] of rel) {
      const p = path.join(root, d, dir, leaf);
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error('no Playwright Chromium found (npx playwright install chromium)');
}

function loadPlaywright() {
  const cands = ['playwright-core', path.join(__dirname, 'node_modules', 'playwright-core'),
    path.join(HOME, 'zai-mint', 'node_modules', 'playwright-core'),
    process.env.GLM_BRIDGE_PW].filter(Boolean);
  for (const c of cands) { try { return require(c); } catch { /* next */ } }
  throw new Error('playwright-core not found (npm i playwright-core)');
}

// ---------------------------------------------------------------- captcha ---
// Replays the desktop's exact AliyunCaptcha init. The details that matter:
//   mode:'popup', a real HTMLButtonElement, button selector, showErrorTip:false
// Without the button the SDK initialises but never invokes the callback.
async function mintOnce(browser, attempt, opts = {}) {
  const context = await browser.newContext({
    viewport: { width: 1380, height: 860 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
    locale: 'en-US',
  });
  const page = await context.newPage();
  // Hide automation fingerprints the risk engine keys on.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    window.chrome = window.chrome || { runtime: {} };
  });
  try {
    await page.goto('https://zcode.z.ai/', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(3000);
    await page.evaluate(async () => {
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js';
        s.onload = res;
        s.onerror = () => rej(new Error('cdn-script-load-failed'));
        document.head.appendChild(s);
      });
      window.__cb = [];
      const c = document.createElement('div');
      c.id = 'zcode-aliyun-captcha-container';
      c.setAttribute('aria-hidden', 'true');
      c.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;height:0;width:0;overflow:visible;';
      const el = document.createElement('div');
      el.id = 'zcode-aliyun-captcha-element';
      const btn = document.createElement('button');
      btn.id = 'zcode-aliyun-captcha-button';
      btn.type = 'button';
      btn.style.cssText = 'position:absolute;left:40px;top:400px;width:200px;height:44px;z-index:2147483647;';
      c.appendChild(el);
      c.appendChild(btn);
      document.body.appendChild(c);
      window.AliyunCaptchaConfig = { region: 'sgp', prefix: 'no8xfe' };
      window.__inst = null;
      window.initAliyunCaptcha({
        SceneId: '11xygtvd',
        mode: 'popup',
        language: 'en',
        showErrorTip: false,
        element: '#zcode-aliyun-captcha-element',
        button: '#zcode-aliyun-captcha-button',
        // The desktop drives the SDK through the instance handle; without
        // startTracelessVerification() the SDK just sits there and never
        // invokes captchaVerifyCallback.
        getInstance: inst => { window.__inst = inst; return inst; },
        captchaVerifyCallback: async a => {
          window.__cb.push(typeof a === 'string' ? a : JSON.stringify(a));
          return { captchaResult: true };
        },
        // The desktop claims with the `success` callback's argument
        // (n.resolve(e) in app.asar) — capture it too, tagged, so we can
        // prefer it over captchaVerifyCallback's value.
        success: e => { window.__cb.push('SUCCESS:' + (typeof e === 'string' ? e : JSON.stringify(e))); },
        onBizResultCallback: async a => { window.__cb.push('BIZ:' + JSON.stringify(a)); },
      });
      await new Promise(r => setTimeout(r, 500));
      window.__btnReady = !!document.getElementById('zcode-aliyun-captcha-button');
    });
    // getInstance fires asynchronously — poll for the instance (the desktop
    // waits for it too), THEN run traceless. Calling it once at a fixed 2.5s
    // silently no-ops when the instance is late, which is why the button path
    // (interactive token → 3007) always ran instead.
    let instReady = false;
    for (let i = 0; i < 20; i++) {
      instReady = await page.evaluate(() => {
        if (!window.__inst) return false;
        if (typeof window.__inst.startTracelessVerification === 'function') {
          try { window.__inst.startTracelessVerification(); return true; }
          catch (e) { window.__cb = window.__cb || []; window.__cb.push('TRACELESS-ERR:' + e.message); return true; }
        }
        return true;
      });
      if (instReady) break;
      await page.waitForTimeout(500);
    }
    say('instance ready=' + instReady);
    // Shared picker: prefer the `success` arg (what the desktop claims with,
    // SUCCESS:-tagged), unwrap the tag; else the captchaVerifyCallback value.
    const pickCb = () => page.evaluate(() => {
      const all = (window.__cb || [])
        .filter(x => !String(x).startsWith('BIZ:') && !String(x).startsWith('TRACELESS-ERR'));
      if (!all.length) return null;
      const succ = all.find(x => String(x).startsWith('SUCCESS:'));
      const v = succ !== undefined ? String(succ).slice(8) : all[0];
      return v && v.length > 10 ? v : null;
    });
    // Wait for the traceless callback before ever touching the button.
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(1000);
      const cb = await pickCb();
      if (cb) { say('captcha param obtained traceless (attempt ' + attempt + ', ' + (i + 1) + 's)'); return opts.keepOpen ? { param: cb, page } : cb; }
    }
    const errs = await page.evaluate(() => (window.__cb || []).filter(x => String(x).startsWith('TRACELESS-ERR')).map(x => x.slice(0, 120)));
    if (errs.length) say('traceless error: ' + errs[0]);
    say('traceless silent, falling back to button click');
    // Real (trusted) click on the trigger button: this is what reliably
    // opens the captcha popup and fires the callback.
    let clicked = false;
    try { await page.click('#zcode-aliyun-captcha-button', { timeout: 15000 }); clicked = true; }
    catch {
      await page.evaluate(() => {
        const b = document.getElementById('zcode-aliyun-captcha-button');
        if (b) b.click();
      });
      clicked = true;
    }
    say('attempt: trusted click=' + clicked);
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(1000);
      const cb = await pickCb();
      if (cb) { say('captcha param obtained (attempt ' + attempt + ', ' + (i + 1) + 's)'); return opts.keepOpen ? { param: cb, page } : cb; }
      // If the popup never opened, drive the SDK through its instance handle.
      if (i === 12) {
        const via = await page.evaluate(() => {
          const i2 = window.__inst;
          if (i2 && typeof i2.startTracelessVerification === 'function') { i2.startTracelessVerification(); return 'startTracelessVerification'; }
          if (i2 && typeof i2.startInteractive === 'function') { i2.startInteractive(); return 'startInteractive'; }
          return 'no-instance-method';
        }).catch(e => 'error:' + e.message);
        say('instance fallback -> ' + via);
      }
    }
    return null;
  } finally {
    await page.context().close().catch(() => {});
  }
}

// The SDK intermittently completes without invoking the callback, so retry
// with a fresh page: Aliyun hands out a new device token each time.
async function mintParamSession(tries) {
  const pw = loadPlaywright();
  const exe = findChromium();
  // Stealth: Aliyun risk-scores the minting browser. Headless defaults
  // (webdriver flag, automation UA) mark the token high-risk → 3007 at
  // claim time even though the mint itself succeeded.
  const launch = { headless: true, executablePath: exe,
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'] };
  if (MINT_PROXY) launch.proxy = { server: MINT_PROXY };
  const attempts = Math.max(1, tries || Number(process.env.GLM_BRIDGE_CLAIM_TRIES || 4));
  const browser = await pw.chromium.launch(launch);
  try {
    for (let a = 1; a <= attempts; a++) {
      let page = null;
      try {
        const r = await mintOnce(browser, a, { keepOpen: true });
        if (r && r.param) return { param: r.param, page: r.page, browser };
      } catch (e) { say('attempt ' + a + ' failed: ' + e.message); }
      say('attempt ' + a + '/' + attempts + ': no captcha param');
      if (a < attempts) await new Promise(r2 => setTimeout(r2, 4000));
    }
  } catch (e) {
    await browser.close().catch(() => {});
    throw e;
  }
  await browser.close().catch(() => {});
  throw new Error('captcha callback never fired after ' + attempts + ' attempts');
}

// Legacy one-shot mint (closes the browser) — used by `--test-captcha`.
async function mintParam(tries) {
  const s = await mintParamSession(tries);
  await s.browser.close().catch(() => {});
  return s.param;
}

// ------------------------------------------------------------------ claim ---
function curlClaim(paramHeader, planId, useProxy) {
  const jwt = zcodeJwt();
  const args = ['-sS', '-m', '45', '-o', '-', '-w', '\n__CODE__%{http_code}',
    '-H', 'Content-Type: application/json',
    '-H', 'Authorization: Bearer ' + jwt,
    ...SOURCE_HEADERS(),
    '-H', 'X-Aliyun-Captcha-Verify-Region: sgp',
    '-H', 'X-Aliyun-Captcha-Verify-Param: ' + paramHeader,
    '-H', 'User-Agent: ZCode/3.14.4',
    '-d', JSON.stringify({ plan_id: planId })];
  if (useProxy) args.push('-x', PROXY);
  args.push('https://zcode.z.ai/api/v1/zcode-plan/billing/claim');
  return new Promise(resolve => {
    execFile('curl', args, { timeout: 60000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      const s = String(stdout || '');
      const i = s.lastIndexOf('\n__CODE__');
      if (i < 0) return resolve({ status: 0, body: String((err && err.message) || 'curl failed') });
      resolve({ status: Number(s.slice(i + 9)) || 0, body: s.slice(0, i) });
    });
  });
}

// Direct first (fast when egress is up), fall back to the local proxy.
async function claim(paramHeader, planId) {
  const direct = await curlClaim(paramHeader, planId, false);
  if (direct.status === 0) {
    say('direct route unavailable, retrying via proxy ' + PROXY);
    return curlClaim(paramHeader, planId, true);
  }
  return direct;
}

// Is the plan already active? (avoid pointless claims)
// Which plans are currently claimable? The desktop asks preview first and
// claims whatever it returns — the offer id changes (the active one yesterday
// was zcode-v3-start-plan-trust-1002, NOT the hardcoded zcode-v3-start-plan).
// Requires X-Device-Mid (3001 without it). Returns [] on any failure.
async function previewPlans() {
  const jwt = zcodeJwt();
  const url = 'https://zcode.z.ai/api/v1/zcode-plan/billing/preview'
    + '?app_version=3.14.4&platform=' + `${process.platform}-${process.arch}`;
  const args = ['-sS', '-m', '30', '-o', '-', '-w', '\n__CODE__%{http_code}',
    '-H', 'Authorization: Bearer ' + jwt,
    ...SOURCE_HEADERS(),
    '-H', 'User-Agent: ZCode/3.14.4', url];
  let out = await new Promise(res => execFile('curl', args,
    { timeout: 40000 }, (e, so) => res(String(so || ''))));
  let i = out.lastIndexOf('\n__CODE__');
  let code = i >= 0 ? Number(out.slice(i + 9)) || 0 : 0;
  if (code === 0 && PROXY) {
    out = await new Promise(res => execFile('curl', [...args.slice(0, -1), '-x', PROXY, url],
      { timeout: 40000 }, (e, so) => res(String(so || ''))));
    i = out.lastIndexOf('\n__CODE__');
  }
  if (i < 0) return null;
  const body = out.slice(0, i);
  try {
    const j = JSON.parse(body);
    if (!j || j.code !== 0 || !j.data) return null;
    return (j.data.plans || []).map(p => ({
      planId: String(p.plan_id || '').trim(),
      name: p.name || '',
      status: String(p.status || '').toLowerCase(),
    })).filter(p => p.planId && p.status !== 'active');
  } catch { return null; }
}

async function planActive() {
  const jwt = zcodeJwt();
  const url = 'https://zcode.z.ai/api/v1/zcode-plan/billing/current?app_version=3.14.4&platform='
    + `${process.platform}-${process.arch}`;
  const args = ['-sS', '-m', '30', '-o', '-', '-w', '\n__CODE__%{http_code}',
    '-H', 'Authorization: Bearer ' + jwt, '-H', 'User-Agent: ZCode/3.14.4'];
  const proxied = await new Promise(res => execFile('curl', [...args, '-x', PROXY, url],
    { timeout: 40000 }, (e, so) => res(String(so || ''))));
  const tryParse = s => {
    const i = String(s).lastIndexOf('\n__CODE__');
    if (i < 0) return null;
    try { return JSON.parse(String(s).slice(0, i)); } catch { return null; }
  };
  let j = tryParse(proxied);
  if (!j) {
    const direct = await new Promise(res => execFile('curl', [...args, url],
      { timeout: 40000 }, (e, so) => res(String(so || ''))));
    j = tryParse(direct);
  }
  const plans = (j && j.data && j.data.plans) || [];
  // Only a plan that is active *right now* counts. `plans.length > 0` used to
  // be enough, which kept an expired-but-still-listed plan suppressing every
  // claim after the first day — the "claim never works" bug.
  const nowSec = Math.floor(Date.now() / 1000);
  return plans.some(p => {
    if (String(p.status || '').toLowerCase() !== 'active') return false;
    return !Number.isFinite(p.ends_at) || p.ends_at > nowSec;
  });
}

(async () => {
  PROXY = await resolveProxy();
  say(PROXY ? `using proxy ${PROXY}` : 'using direct connection');
  if (PREVIEW_ONLY) {
    const prev = await previewPlans().catch(() => null);
    emit(prev === null ? { ok: false, reason: 'preview-unreachable' }
      : { ok: true, plans: prev });
    return;
  }
  // Preview FIRST. The baseline daily plan (zcode-v3-start-plan-0817, 3M+5M)
  // is auto-granted to every new account and is always "active", so checking
  // planActive() first would suppress claiming the 100M trust offer forever —
  // the "new account only gets 3M" bug. Only skip when preview ANSWERS empty.
  const prev = await previewPlans().catch(() => null);
  let targets;
  if (prev === null) {
    // Preview unreachable: fall back to planActive() heuristic.
    if (!FORCE && await planActive().catch(() => false)) {
      emit({ ok: true, claimed: false, reason: 'already-active', planId: PLAN_ID });
      return;
    }
    say('preview unreachable, falling back to plan id ' + PLAN_ID);
    targets = [{ planId: PLAN_ID, name: 'configured' }];
  } else if (!prev.length) {
    emit({ ok: true, claimed: false, reason: 'no-offers', planId: PLAN_ID,
      detail: 'preview answered with no claimable offers (plan active or campaign off)' });
    return;
  } else {
    targets = prev;
    say('preview offers: ' + prev.map(p => `${p.planId}${p.name ? ` (${p.name})` : ''}`).join(', '));
  }

  if (DRY) { emit({ ok: true, dryRun: true, targets: targets.map(t => t.planId) }); return; }

  // Proven path (2026-10-02): ONE fresh traceless param → ONE raw-json POST.
  // The param is single-use; extra encodings (signed-b64/b64-json) and extra
  // rounds only re-verify an already-consumed token → guaranteed 3007.
  // 2026-10-03: fresh accounts now 3007 with the cross-session (curl) claim —
  // Aliyun binds the verify param to the browser session that minted it. The
  // claim is therefore issued INSIDE the minting page (same cookies + TLS),
  // exactly like the GUI does; curl remains the fallback.
  const inPageClaim = async (page, planId) => {
    const jwt = zcodeJwt();
    return page.evaluate(async ({ jwt, planId }) => {
      const r = await fetch('/api/v1/zcode-plan/billing/claim', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + jwt,
          'X-Aliyun-Captcha-Verify-Region': 'sgp',
          'X-Aliyun-Captcha-Verify-Param': window.__captchaParam || '',
        },
        credentials: 'include',
        body: JSON.stringify({ plan_id: planId }),
      });
      return { status: r.status, body: await r.text() };
    }, { jwt, planId });
  };

  // mintParam must also keep the page open for the in-page claim: extend it to
  // return { param, page, browser } when a claim callback is provided.
  const results = [];
  for (const t of targets) {
    let claimed = false; let lastErr = null;
    for (let attempt = 0; attempt < 2 && !claimed; attempt++) {
      if (attempt > 0) { say('waiting 15s before re-mint (verify rate window)...'); await new Promise(r => setTimeout(r, 15000)); }
      say(`minting captcha param for ${t.planId} (attempt ${attempt + 1})...`);
      let minted = null;
      try {
        minted = await mintParamSession();   // { param, page, browser } — page stays open
      } catch (e) { lastErr = 'captcha mint failed: ' + e.message; say(lastErr); continue; }
      const { param, page, browser } = minted;
      let res = null;
      try {
        await page.evaluate(p => { window.__captchaParam = p; }, param);
        res = await inPageClaim(page, t.planId);
        say(`in-page claim -> HTTP ${res.status} ${String(res.body).slice(0, 200)}`);
      } catch (e) {
        say('in-page claim failed (' + e.message + '), falling back to curl');
      }
      if (!res || !(res.status === 200 && /"code"\s*:\s*0/.test(String(res.body)))) {
        res = await claim(param, t.planId);
        say(`raw-json (curl) -> HTTP ${res.status} ${String(res.body).slice(0, 200)}`);
      }
      await browser.close().catch(() => {});
      if (res.status === 200 && /"code"\s*:\s*0/.test(String(res.body))) {
        claimed = true;
        emit({ ok: true, claimed: true, planId: t.planId, detail: String(res.body).slice(0, 500) });
      } else if (/"code"\s*:\s*1001/.test(String(res.body))) {
        results.push({ planId: t.planId, ok: true, claimed: false, reason: 'target-gone' });
        say('offer vanished (1001) — nothing more to do for this target');
        break;
      } else {
        lastErr = `HTTP ${res.status} ${String(res.body).slice(0, 220)}`;
      }
    }
    if (claimed) return;
    results.push({ planId: t.planId, ok: false, detail: lastErr || 'no attempt' });
  }
  emit({ ok: false, claimed: false, planId: PLAN_ID,
    detail: results.map(r => `${r.planId}: ${r.reason || r.detail || ''}`).join('; ') || 'no attempt' });
  process.exit(1);
})().catch(e => {
  emit({ ok: false, claimed: false, planId: PLAN_ID, detail: (e && e.message) || String(e) });
  process.exit(1);
});
