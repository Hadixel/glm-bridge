#!/usr/bin/env node
/*
 * mint-captcha.js — mint Aliyun captcha device tokens for ZCode's scene.
 *
 * Usage: node mint-captcha.js [count] [outFile] [proxyUrl]
 *   count     how many tokens to mint (default 10)
 *   outFile   JSON array output (default ./tokens-minted.json)
 *   proxyUrl  optional proxy, e.g. socks5://127.0.0.1:10808
 *
 * Resolves playwright-core from (in order): local node_modules, GLM_BRIDGE_PW,
 * ~/zai-mint, then global. Finds a Playwright Chromium from the standard cache
 * locations on Linux, Windows and macOS.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const COUNT = parseInt(process.argv[2] || process.env.COUNT || '10', 10);
const OUT = process.argv[3] || path.join(__dirname, 'tokens-minted.json');
const PROXY = process.argv[4] || process.env.MINT_PROXY || '';
const SCENE_ID = process.env.ZCODE_CAPTCHA_SCENE || '11xygtvd';
const PREFIX = process.env.ZCODE_CAPTCHA_PREFIX || 'no8xfe';
const REGION = process.env.ZCODE_CAPTCHA_REGION || 'sgp';

const log = m => console.log('[mint] ' + m);

function loadPlaywright() {
  const candidates = [
    'playwright-core',
    process.env.GLM_BRIDGE_PW,
    path.join(__dirname, 'node_modules', 'playwright-core'),
    path.join(os.homedir(), 'zai-mint', 'node_modules', 'playwright-core'),
  ].filter(Boolean);
  for (const c of candidates) {
    try { return require(c); } catch { /* next */ }
  }
  throw new Error(
    'playwright-core not found. Install it:  npm i playwright-core  (in ' + __dirname + ')\n' +
    'or point GLM_BRIDGE_PW at an existing playwright-core install.'
  );
}

function playwrightCacheRoots() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [path.join(local, 'ms-playwright')];
  }
  if (process.platform === 'darwin') return [path.join(home, 'Library', 'Caches', 'ms-playwright')];
  return [path.join(home, '.cache', 'ms-playwright')];
}

function findChromium() {
  if (process.env.GLM_BRIDGE_CHROMIUM && fs.existsSync(process.env.GLM_BRIDGE_CHROMIUM)) {
    return process.env.GLM_BRIDGE_CHROMIUM;
  }
  // [dirName, binaryName] relative to the chromium-<build> folder
  const rel = [
    ['chrome-win', 'chrome.exe'],
    ['chrome-win32', 'chrome.exe'],
    ['chrome-win64', 'chrome.exe'],
    ['chrome-linux64', 'chrome'],
    ['chrome-linux', 'chrome'],
    ['chrome-headless-shell-win64', 'chrome-headless-shell.exe'],
    ['chrome-headless-shell-linux64', 'chrome-headless-shell'],
    ['chrome-mac/Google Chrome for Testing.app/Contents/MacOS', 'Google Chrome for Testing'],
    ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS', 'Google Chrome for Testing'],
  ];
  for (const root of playwrightCacheRoots()) {
    let dirs = [];
    try {
      let all = [];
      try { all = fs.readdirSync(root).filter(d => /^chromium/.test(d)).sort().reverse(); } catch { continue; }
      // Prefer full Chromium: the Aliyun SDK does not complete inside
      // chrome-headless-shell (the callback never fires).
      const dirs = [
        ...all.filter(d => !d.includes('headless_shell')),
        ...all.filter(d => d.includes('headless_shell')),
      ];
    } catch { continue; }
    for (const d of dirs) {
      for (const [dir, leaf] of rel) {
        const p = path.join(root, d, dir, leaf);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  throw new Error(
    'no Playwright Chromium found.\n' +
    playwrightCacheRoots().map(r => '  looked in: ' + r).join('\n') +
    '\nInstall one:  npx playwright install chromium'
  );
}

(async () => {
  const { chromium } = loadPlaywright();
  const exe = findChromium();
  log('chromium: ' + exe);
  const launch = { headless: true, executablePath: exe };
  if (PROXY) { launch.proxy = { server: PROXY }; log('proxy: ' + PROXY); }
  const browser = await chromium.launch(launch);
  const page = await (await browser.newContext({ viewport: { width: 1380, height: 860 } })).newPage();
  await page.goto('https://zcode.z.ai/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(4000);

  // The Aliyun SDK hands the finished *verify param* to captchaVerifyCallback.
  // That string (base64 JSON with captchaId/sceneId/securityToken) is exactly
  // what the upstream expects in X-Aliyun-Captcha-Verify-Param. Raw
  // window.z_um.getToken() gives a chat.z.ai web device token instead, which
  // this scene rejects with code 3007.
  await page.evaluate(async ({ scene, prefix, region }) => {
    window.__zparams = [];
    window.__zraw = [];
    if (!window.initAliyunCaptcha) {
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js';
        s.onload = res; s.onerror = () => rej(new Error('cdn-script-load-failed'));
        document.head.appendChild(s);
      });
    }
    window.AliyunCaptchaConfig = { region, prefix };
    let el = document.getElementById('__tokenFeeder');
    if (!el) {
      el = document.createElement('div');
      el.id = '__tokenFeeder';
      el.style.cssText = 'position:fixed;left:-9999px;width:320px;height:40px;';
      document.body.appendChild(el);
    }
    const capture = (arg) => {
      const p = typeof arg === 'string' ? arg
        : (arg && (arg.captchaVerifyParam || arg.CaptchaVerifyParam)) || null;
      if (p && String(p).trim()) window.__zparams.push(String(p).trim());
      else if (arg !== undefined) window.__zraw.push(JSON.stringify(arg));
    };
    window.initAliyunCaptcha({
      SceneId: scene, mode: 'embed', element: '#__tokenFeeder',
      region, prefix, language: 'en',
      captchaVerifyCallback: async (arg) => { capture(arg); return { captchaResult: true }; },
      onBizResultCallback: (arg) => { capture(arg); },
    });
  }, { scene: SCENE_ID, prefix: PREFIX, region: REGION }).catch(e => log('init: ' + e.message));

  // Wait for the SDK to finish traceless verification and emit a param.
  let params = [];
  for (let i = 0; i < 45 && params.length === 0; i++) {
    await page.waitForTimeout(1000);
    params = await page.evaluate(() => [...new Set(window.__zparams || [])]);
  }
  log('verify params from SDK: ' + params.length +
      (params.length === 0 ? ' (raw callbacks: ' +
        await page.evaluate(() => (window.__zraw || []).length) + ')' : ''));

  // Fallback: raw device tokens (kept for scenes where they are accepted).
  if (params.length < COUNT) {
    const tokens = await page.evaluate(async (per) => {
      const out = [];
      const um = window.z_um || window.um;
      for (let i = 0; i < per; i++) {
        try { out.push(await um.getToken()); } catch { await new Promise(r => setTimeout(r, 200)); }
      }
      return [...new Set(out)];
    }, COUNT).catch(() => []);
    params = [...params, ...tokens];
  }

  if (!params.length) {
    log('FAILED to obtain any captcha param');
    await browser.close();
    process.exit(1);
  }
  fs.writeFileSync(OUT, JSON.stringify(params));
  log('minted ' + params.length + ' -> ' + OUT);
  await browser.close();
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
