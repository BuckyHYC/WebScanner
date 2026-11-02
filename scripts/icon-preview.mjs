/**
 * 图标方案预览：生成 3 套 SVG 图标 + 一张对照图（128/64/32/16 在浅色与深色背景上的效果）。
 * 用法：node scripts/icon-preview.mjs（无需 dev server）
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = path.resolve('e2e-tmp/icons');

/** 方案 A：深色底 + 取景框 + 白纸 + 扫描光带 */
const A = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1a2c44"/><stop offset="1" stop-color="#0b0f14"/>
    </linearGradient>
    <linearGradient id="beam" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#2f81f7" stop-opacity="0"/>
      <stop offset=".5" stop-color="#6cb4ff"/>
      <stop offset="1" stop-color="#2f81f7" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="pageClip"><rect x="146" y="112" width="220" height="288" rx="20"/></clipPath>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#bg)"/>
  <g transform="rotate(-6 256 256)">
    <rect x="146" y="112" width="220" height="288" rx="20" fill="#ffffff"/>
    <g fill="#9fb3c8" clip-path="url(#pageClip)">
      <rect x="176" y="152" width="120" height="16" rx="8" fill="#5b7794"/>
      <rect x="176" y="196" width="160" height="12" rx="6"/>
      <rect x="176" y="226" width="140" height="12" rx="6"/>
      <rect x="176" y="256" width="160" height="12" rx="6"/>
      <rect x="176" y="316" width="150" height="12" rx="6"/>
      <rect x="176" y="346" width="110" height="12" rx="6"/>
    </g>
    <rect x="146" y="278" width="220" height="30" fill="url(#beam)" opacity="0.95" clip-path="url(#pageClip)"/>
  </g>
  <g fill="none" stroke="#2f81f7" stroke-width="22" stroke-linecap="round">
    <path d="M92 168 V104 A12 12 0 0 1 104 92 H168"/>
    <path d="M344 92 H408 A12 12 0 0 1 420 104 V168"/>
    <path d="M420 344 V408 A12 12 0 0 1 408 420 H344"/>
    <path d="M168 420 H104 A12 12 0 0 1 92 408 V344"/>
  </g>
</svg>`;

/** 方案 B：蓝色渐变底 + 折角白纸 + 扫描线 */
const B = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#4a97ff"/><stop offset="1" stop-color="#1f5fce"/>
    </linearGradient>
    <linearGradient id="fold" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#e8f1ff"/><stop offset="1" stop-color="#c6dcff"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#bg)"/>
  <g transform="rotate(-5 256 256)">
    <path d="M158 118 h140 l60 60 v212 a20 20 0 0 1 -20 20 h-180 a20 20 0 0 1 -20 -20 v-252 a20 20 0 0 1 20 -20 z" fill="#ffffff"/>
    <path d="M298 118 l60 60 h-60 z" fill="url(#fold)"/>
    <g fill="#a8c4e6">
      <rect x="182" y="212" width="152" height="14" rx="7"/>
      <rect x="182" y="244" width="124" height="14" rx="7"/>
      <rect x="182" y="276" width="140" height="14" rx="7"/>
      <rect x="182" y="330" width="112" height="14" rx="7"/>
    </g>
    <rect x="158" y="300" width="220" height="22" fill="#2f81f7" opacity="0.85"/>
    <rect x="158" y="322" width="220" height="10" fill="#2f81f7" opacity="0.28"/>
  </g>
</svg>`;

/** 方案 C：深色底 + 快门光圈 + 文档 */
const C = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#141d29"/><stop offset="1" stop-color="#0b0f14"/>
    </linearGradient>
    <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6cb4ff"/><stop offset="1" stop-color="#2f81f7"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#bg)"/>
  <g fill="url(#ring)">
    <path d="M256 84 l74 43 -74 43 -74 -43 z" opacity=".95"/>
    <path d="M330 170 l74 43 -74 43 -74 -43 z" transform="rotate(60 256 256)" opacity=".8"/>
    <path d="M330 170 l74 43 -74 43 -74 -43 z" transform="rotate(120 256 256)" opacity=".7"/>
    <path d="M330 170 l74 43 -74 43 -74 -43 z" transform="rotate(180 256 256)" opacity=".85"/>
    <path d="M330 170 l74 43 -74 43 -74 -43 z" transform="rotate(240 256 256)" opacity=".7"/>
    <path d="M330 170 l74 43 -74 43 -74 -43 z" transform="rotate(300 256 256)" opacity=".8"/>
  </g>
  <rect x="186" y="150" width="140" height="212" rx="16" fill="#ffffff"/>
  <g fill="#9fb3c8">
    <rect x="208" y="184" width="72" height="12" rx="6" fill="#5b7794"/>
    <rect x="208" y="214" width="96" height="10" rx="5"/>
    <rect x="208" y="238" width="80" height="10" rx="5"/>
    <rect x="208" y="262" width="96" height="10" rx="5"/>
    <rect x="208" y="286" width="64" height="10" rx="5"/>
  </g>
  <rect x="186" y="312" width="140" height="20" fill="#2f81f7" opacity="0.9"/>
</svg>`;

const concepts = [
  ['A 取景框·白纸·扫描光带', A],
  ['B 蓝底折角纸（最像 App 图标）', B],
  ['C 快门光圈·文档', C],
];

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, svg] of concepts) {
    fs.writeFileSync(path.join(OUT, `${name.slice(0, 1).toLowerCase()}.svg`), svg);
  }

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--window-size=1200,900', '--use-gl=swiftshader'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 2 });

  const rows = concepts
    .map(
      ([name, svg], i) => `
    <div class="row">
      <div class="name">${name}</div>
      <div class="strip light">${[160, 64, 32, 16].map((s) => `<span class="cell"><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${s}" height="${s}"/></span>`).join('')}</div>
      <div class="strip dark">${[160, 64, 32, 16].map((s) => `<span class="cell"><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${s}" height="${s}"/></span>`).join('')}</div>
    </div>`,
    )
    .join('');

  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;padding:24px;background:#f3f4f6;font-family:"Microsoft YaHei",system-ui,sans-serif}
    .row{margin-bottom:18px}
    .name{font-size:13px;color:#374151;margin-bottom:8px;font-weight:600}
    .strip{display:flex;align-items:flex-end;gap:18px;padding:14px 18px;border-radius:14px}
    .light{background:#ffffff;box-shadow:0 1px 3px rgba(0,0,0,.12)}
    .dark{background:#0b0f14;margin-top:8px}
    .cell{display:flex;align-items:center;justify-content:center}
    img{display:block;border-radius:0}
  </style></head><body>${rows}</body></html>`);

  const buf = await page.screenshot({ fullPage: true });
  fs.writeFileSync(path.join(OUT, 'contact-sheet.png'), buf);
  await browser.close();
  console.log('已生成:', path.join(OUT, 'contact-sheet.png'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
