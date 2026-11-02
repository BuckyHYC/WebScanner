/**
 * 应用图标生成：两套候选（A 深色取景框 / B 蓝色折角纸），可导出为最终图标产物。
 *
 * 用法：
 *   node scripts/gen-icons.mjs              生成候选项对照图（e2e-tmp/icons/contact-sheet.png）
 *   node scripts/gen-icons.mjs A|B          导出该方案到 public/
 *
 * 产物：
 *   public/favicon.svg                        标签页图标（矢量，圆角底）
 *   public/icons/icon-192.png / icon-512.png  PWA 普通图标（圆角透明角）
 *   public/icons/maskable-512.png             PWA 自适应图标（全幅底 + 内容缩到 72% 安全区）
 *   public/apple-touch-icon.png               iOS 主屏图标（180，全幅不透明）
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = path.resolve('e2e-tmp/icons');
const PUBLIC = path.resolve('public');

const DEFS = `<defs>
    <linearGradient id="bgA" x1="0.1" y1="0" x2="0.9" y2="1">
      <stop offset="0" stop-color="#18293f"/><stop offset="0.55" stop-color="#0f1823"/><stop offset="1" stop-color="#0a0e13"/>
    </linearGradient>
    <linearGradient id="bgB" x1="0.1" y1="0" x2="0.9" y2="1">
      <stop offset="0" stop-color="#54a0ff"/><stop offset="0.5" stop-color="#2f81f7"/><stop offset="1" stop-color="#1b53b4"/>
    </linearGradient>
    <linearGradient id="beam" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#2f81f7" stop-opacity="0"/>
      <stop offset="0.18" stop-color="#2f81f7" stop-opacity="0.65"/>
      <stop offset="0.5" stop-color="#8ec6ff" stop-opacity="0.95"/>
      <stop offset="0.82" stop-color="#2f81f7" stop-opacity="0.65"/>
      <stop offset="1" stop-color="#2f81f7" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="fold" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#eaf3ff"/><stop offset="1" stop-color="#bcd6fb"/>
    </linearGradient>
    <clipPath id="pageClip"><rect x="140" y="104" width="232" height="304" rx="22"/></clipPath>
  </defs>`;

/** 方案 A 的图形部分：白纸 + 扫描光带 + 取景框 */
const CONTENT_A = `
  <g transform="rotate(-4 256 256)">
    <rect x="140" y="104" width="232" height="304" rx="22" fill="#ffffff"/>
    <g clip-path="url(#pageClip)">
      <rect x="172" y="140" width="96" height="16" rx="8" fill="#48627d"/>
      <g fill="#b8c8d8">
        <rect x="172" y="186" width="168" height="13" rx="6.5"/>
        <rect x="172" y="214" width="140" height="13" rx="6.5"/>
        <rect x="172" y="242" width="168" height="13" rx="6.5"/>
        <rect x="172" y="324" width="150" height="13" rx="6.5"/>
        <rect x="172" y="352" width="108" height="13" rx="6.5"/>
      </g>
      <rect x="140" y="266" width="232" height="46" fill="url(#beam)" opacity="0.35"/>
      <rect x="140" y="284" width="232" height="12" fill="url(#beam)"/>
    </g>
  </g>
  <g fill="none" stroke="#2f81f7" stroke-width="24" stroke-linecap="round">
    <path d="M96 176 V108 A12 12 0 0 1 108 96 H176"/>
    <path d="M336 96 H404 A12 12 0 0 1 416 108 V176"/>
    <path d="M416 336 V404 A12 12 0 0 1 404 416 H336"/>
    <path d="M176 416 H108 A12 12 0 0 1 96 404 V336"/>
  </g>`;

/** 方案 B 的图形部分：折角白纸 + 扫描带 */
const CONTENT_B = `
  <g transform="rotate(-4 256 256)">
    <path d="M150 104 h150 l72 72 v220 a22 22 0 0 1 -22 22 h-200 a22 22 0 0 1 -22 -22 v-270 a22 22 0 0 1 22 -22 z" fill="#ffffff"/>
    <path d="M300 104 l72 72 h-72 z" fill="url(#fold)"/>
    <g fill="#a9c3e2">
      <rect x="178" y="212" width="158" height="14" rx="7"/>
      <rect x="178" y="242" width="126" height="14" rx="7"/>
      <rect x="178" y="272" width="144" height="14" rx="7"/>
      <rect x="178" y="338" width="112" height="14" rx="7"/>
    </g>
    <rect x="150" y="300" width="222" height="24" fill="#1f5fce" opacity="0.86"/>
    <rect x="150" y="324" width="222" height="10" fill="#1f5fce" opacity="0.25"/>
  </g>`;

/**
 * 组合出完整 SVG。
 * rounded：是否圆角底（favicon/普通图标圆角，maskable 与 apple-touch 用全幅底）
 * scale：图形相对画布的比例（maskable 需要缩到安全区）
 */
function compose(concept, { rounded = true, scale = 1 } = {}) {
  const content = concept === 'A' ? CONTENT_A : CONTENT_B;
  const bgFill = concept === 'A' ? 'url(#bgA)' : 'url(#bgB)';
  const bgRect = rounded
    ? `<rect width="512" height="512" rx="112" fill="${bgFill}"/>`
    : `<rect width="512" height="512" fill="${bgFill}"/>`;
  const k = 256 * (1 - scale);
  const wrap = scale === 1 ? content : `<g transform="translate(${k} ${k}) scale(${scale})">${content}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">${DEFS}${bgRect}${wrap}</svg>`;
}

async function renderPng(browser, svg, size, transparent) {
  const page = await browser.newPage();
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:${size}px;height:${size}px;background:transparent}
    img{display:block;width:${size}px;height:${size}px}
  </style></head><body><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"/></body></html>`);
  const buf = await page.screenshot({ omitBackground: transparent });
  await page.close();
  return buf;
}

async function main() {
  const which = (process.argv[2] || '').toUpperCase();
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--window-size=1200,900', '--use-gl=swiftshader'],
  });

  if (which !== 'A' && which !== 'B') {
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 800, deviceScaleFactor: 2 });
    const rows = [
      ['A 深色取景框 + 白纸 + 扫描光带', compose('A')],
      ['B 蓝色底 + 折角纸 + 扫描带', compose('B')],
    ]
      .map(([name, svg]) => {
        const b64 = Buffer.from(svg).toString('base64');
        const sizes = [160, 64, 32, 16];
        return `<div class="row"><div class="name">${name}</div>
        <div class="strip light">${sizes.map((s) => `<img src="data:image/svg+xml;base64,${b64}" width="${s}" height="${s}"/>`).join('')}</div>
        <div class="strip dark">${sizes.map((s) => `<img src="data:image/svg+xml;base64,${b64}" width="${s}" height="${s}"/>`).join('')}</div></div>`;
      })
      .join('');
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
      body{margin:0;padding:22px;background:#f3f4f6;font-family:"Microsoft YaHei",system-ui,sans-serif}
      .row{margin-bottom:16px}.name{font-size:13px;color:#374151;margin-bottom:8px;font-weight:600}
      .strip{display:flex;align-items:flex-end;gap:20px;padding:14px 18px;border-radius:14px}
      .light{background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.12)}.dark{background:#0b0f14;margin-top:8px}
      img{display:block}
    </style></head><body>${rows}</body></html>`);
    fs.writeFileSync(path.join(OUT, 'contact-sheet.png'), await page.screenshot({ fullPage: true }));
    await page.close();
    console.log('候选对照图:', path.join(OUT, 'contact-sheet.png'));
    await browser.close();
    return;
  }

  const rounded = compose(which, { rounded: true });
  const fullBleed = compose(which, { rounded: false });
  const maskable = compose(which, { rounded: false, scale: 0.72 });
  fs.mkdirSync(path.join(PUBLIC, 'icons'), { recursive: true });
  fs.writeFileSync(path.join(PUBLIC, 'favicon.svg'), rounded + '\n');
  fs.writeFileSync(path.join(PUBLIC, 'icons', 'icon-192.png'), await renderPng(browser, rounded, 192, true));
  fs.writeFileSync(path.join(PUBLIC, 'icons', 'icon-512.png'), await renderPng(browser, rounded, 512, true));
  fs.writeFileSync(path.join(PUBLIC, 'icons', 'maskable-512.png'), await renderPng(browser, maskable, 512, false));
  fs.writeFileSync(path.join(PUBLIC, 'apple-touch-icon.png'), await renderPng(browser, fullBleed, 180, false));
  await browser.close();
  console.log(`已导出方案 ${which}：public/favicon.svg + public/icons/*.png + public/apple-touch-icon.png`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
