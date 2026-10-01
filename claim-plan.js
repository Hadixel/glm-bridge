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
const { execFile } = require('child_process');

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const PLAN_ID = argOf('--plan', process.env.GLM_BRIDGE_PLAN || 'zcode-v3-start-plan');
const JSON_OUT = args.includes('--json');
const DRY = args.includes('--dry-run');
const FORCE = args.includes('--force');   // claim even if a plan already looks active
const PROXY = process.env.GLM_BRIDGE_PROXY || 'http://127.0.0.1:10809';
// The captcha browser must use the SAME route as the claim request or the
// verify param is rejected. Direct works whenever egress is up; the proxy is
// only needed when direct is blocked, and then for both.
const MINT_PROXY = process.env.MINT_PROXY || process.env.GLM_BRIDGE_MINT_PROXY || '';

const HOME = os.homedir();
const say = m => { if (!JSON_OUT) process.stderr.write('[claim] ' + m + '\n'); };
const emit = obj => console.log(JSON.stringify(obj));

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
async function mintOnce(browser, attempt) {
  const page = await (await browser.newContext({ viewport: { width: 1380, height: 860 } })).newPage();
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
        onBizResultCallback: async a => { window.__cb.push('BIZ:' + JSON.stringify(a)); },
      });
      await new Promise(r => setTimeout(r, 2500));
      window.__btnReady = !!document.getElementById('zcode-aliyun-captcha-button');
    });
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
      const cb = await page.evaluate(() => (window.__cb || []).filter(x => !String(x).startsWith('BIZ:')));
      if (cb.length) { say('captcha param obtained (attempt ' + attempt + ', ' + (i + 1) + 's)'); return cb[0]; }
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
async function mintParam(tries) {
  const pw = loadPlaywright();
  const exe = findChromium();
  const launch = { headless: true, executablePath: exe };
  if (MINT_PROXY) launch.proxy = { server: MINT_PROXY };
  const attempts = Math.max(1, tries || Number(process.env.GLM_BRIDGE_CLAIM_TRIES || 4));
  const browser = await pw.chromium.launch(launch);
  try {
    for (let a = 1; a <= attempts; a++) {
      try {
        const p = await mintOnce(browser, a);
        if (p) return p;
      } catch (e) { say('attempt ' + a + ' failed: ' + e.message); }
      say('attempt ' + a + '/' + attempts + ': no captcha param');
      if (a < attempts) await new Promise(r => setTimeout(r, 4000));
    }
  } finally {
    await browser.close().catch(() => {});
  }
  throw new Error('captcha callback never fired after ' + attempts + ' attempts');
}

// ------------------------------------------------------------------ claim ---
function curlClaim(paramHeader, planId, useProxy) {
  const jwt = zcodeJwt();
  const args = ['-sS', '-m', '45', '-o', '-', '-w', '\n__CODE__%{http_code}',
    '-H', 'Content-Type: application/json',
    '-H', 'Authorization: Bearer ' + jwt,
    '-H', 'X-ZCode-App-Version: 3.14.4',
    '-H', `X-Platform: ${process.platform}-${process.arch}`,
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
  return plans.some(p => String(p.status || '').toLowerCase() === 'active') || plans.length > 0;
}

(async () => {
  if (!FORCE && await planActive().catch(() => false)) {
    emit({ ok: true, claimed: false, reason: 'already-active', planId: PLAN_ID });
    return;
  }
  say('plan inactive, minting captcha param...');
  let param;
  try { param = await mintParam(); }
  catch (e) { emit({ ok: false, claimed: false, planId: PLAN_ID, detail: 'captcha mint failed: ' + e.message }); process.exit(1); }

  if (DRY) { emit({ ok: true, dryRun: true, planId: PLAN_ID, param: String(param).slice(0, 60) }); return; }

  // Header encodings to try: raw JSON first (what the SDK produced), then b64.
  // The SDK callback yields {sceneId, certifyId, deviceToken}. The upstream
  // historically accepted the signed shape {captchaId, sceneId, isSign,
  // securityToken} (base64), so try that first, then the raw forms.
  if (process.env.GLM_BRIDGE_DEBUG === '1') {
    const full = String(param);
    say('FULL PARAM (' + full.length + ' chars): ' + full);
    try { say('param keys: ' + JSON.stringify(Object.keys(JSON.parse(full)))); } catch { say('param is not JSON'); }
  }
  let signedShape = null;
  try {
    const o = JSON.parse(String(param));
    if (o && o.deviceToken) {
      signedShape = Buffer.from(JSON.stringify({
        captchaId: process.env.ZCODE_CAPTCHA_ID || 'MBmzpRpV',
        sceneId: o.sceneId || '11xygtvd',
        isSign: true,
        securityToken: o.deviceToken,
      })).toString('base64');
    }
  } catch { /* not json */ }
  const variants = [
    ['signed-b64', signedShape],
    ['raw-json', String(param)],
    ['b64-json', Buffer.from(String(param)).toString('base64')],
  ].filter(v => v[1]);
  let last = { status: 0, body: 'no attempt' };
  for (const [name, value] of variants) {
    say(`claim attempt (${name})...`);
    last = await claim(value, PLAN_ID);
    say(`${name} -> HTTP ${last.status} ${String(last.body).slice(0, 200)}`);
    if (last.status === 200 && /"code"\s*:\s*0/.test(String(last.body))) {
      emit({ ok: true, claimed: true, planId: PLAN_ID, encoding: name,
        detail: String(last.body).slice(0, 500) });
      return;
    }
    if (/3007|captcha/i.test(String(last.body))) {  // param rejected -> mint a fresh one
      try { param = await mintParam(); } catch { /* keep the old one */ }
    } else if (!/captcha/i.test(String(last.body)) && last.status >= 400) {
      break;  // not a captcha problem; no point trying more encodings
    }
  }
  emit({ ok: false, claimed: false, planId: PLAN_ID, status: last.status,
    detail: String(last.body).slice(0, 500) });
  process.exit(1);
})().catch(e => {
  emit({ ok: false, claimed: false, planId: PLAN_ID, detail: (e && e.message) || String(e) });
  process.exit(1);
});
