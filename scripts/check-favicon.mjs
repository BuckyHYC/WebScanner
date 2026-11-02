/**
 * 图标可用性检查（新访客视角，全新浏览器 profile，排除缓存干扰）：
 * 打开站点 → 读取 <link rel=icon> 列表 → 逐个请求校验 → 解码 ICO/SVG 校验可渲染 → 截图。
 * 用法：node scripts/check-favicon.mjs [url]，默认检查 http://localhost:5199/
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const URL_BASE = process.argv[2] || 'http://localhost:5199/';

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? ' — ' + extra : ''}`);
};

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'favicon-check-'));
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    userDataDir: profile,
    args: ['--window-size=1200,800', '--use-gl=swiftshader'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });
  await page.goto(URL_BASE, { waitUntil: 'networkidle2', timeout: 60000 });

  const icons = await page.evaluate(() =>
    [...document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]')].map((l) => ({
      rel: l.getAttribute('rel'),
      href: l.href,
      sizes: l.getAttribute('sizes') || '',
      type: l.getAttribute('type') || '',
    })),
  );
  console.log('页面声明的图标：', icons.map((i) => `${i.rel}(${i.type || i.sizes})`).join(', ') || '无');
  check('页面声明了 favicon 链接', icons.length > 0, `${icons.length} 条`);

  // 逐个请求校验状态码
  for (const icon of icons) {
    const res = await page.evaluate(async (url) => {
      try {
        const r = await fetch(url, { cache: 'no-store' });
        return { status: r.status, size: (await r.blob()).size };
      } catch (e) {
        return { status: 0, size: 0 };
      }
    }, icon.href);
    check(`${icon.rel} 可访问`, res.status === 200 && res.size > 0, `${icon.href} → HTTP ${res.status}, ${res.size} B`);
  }

  // 解码校验：ico 与 svg 都能被浏览器渲染
  const decoded = await page.evaluate(async (list) => {
    const out = [];
    for (const item of list) {
      const ok = await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img.naturalWidth > 0);
        img.onerror = () => resolve(false);
        img.src = item.href;
      });
      out.push({ href: item.href, ok });
    }
    return out;
  }, icons);
  for (const d of decoded) {
    check(`可正常解码渲染：${d.href.split('/').pop()}`, d.ok);
  }

  // 与站点无关的兜底：/favicon.ico 也必须存在（部分浏览器/WebView 只认它）
  const icoStatus = await page.evaluate(async (base) => {
    try {
      const r = await fetch(new URL('favicon.ico', base), { cache: 'no-store' });
      return r.status;
    } catch {
      return 0;
    }
  }, URL_BASE);
  check('/favicon.ico 存在（只认 ico 的浏览器兜底）', icoStatus === 200, `HTTP ${icoStatus}`);

  fs.mkdirSync('e2e-tmp', { recursive: true });
  await page.screenshot({ path: path.join('e2e-tmp', 'favicon-check.png') });
  await browser.close();
  fs.rmSync(profile, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} 项通过（${URL_BASE}）===`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('CHECK ERROR:', e);
  process.exit(1);
});
