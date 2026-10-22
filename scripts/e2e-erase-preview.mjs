/**
 * 擦除预览 e2e：验证「涂抹擦除后 ② 增强滤镜 的预览包含擦除效果」（与导出一致），
 * 并验证导出对话框的「自选页」范围选择与自选页 PDF 导出。
 * 复用 puppeteer-core + 本机 Edge（零下载成本）。
 *
 * 判定思路：白底 + 正中黑圆。抹掉黑圆后统计全画布黑色像素量：
 * ③ 应显著下降；② 增强滤镜重新渲染后应保持同一水平（未修复时会回到原始黑量）。
 * 为保证命中，用最大笔径在质心附近画三条横向笔画。
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const URL_BASE = process.env.E2E_URL || 'http://localhost:5173/';
const OUT = path.resolve('e2e-tmp');
const DL = path.join(OUT, 'downloads');

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? ' — ' + extra : ''}`);
};

/** 主画布（最大且已渲染）几何 */
function canvasInfo(page) {
  return page.evaluate(() => {
    const list = [...document.querySelectorAll('canvas')]
      .map((c) => ({ c, r: c.getBoundingClientRect() }))
      .filter((o) => o.r.width > 200 && o.r.height > 200 && o.c.width > 500);
    if (!list.length) return null;
    list.sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
    const { c, r } = list[0];
    return { left: r.left, top: r.top, w: r.width, h: r.height, cw: c.width, ch: c.height };
  });
}

/** 归一化（位图）坐标 → 屏幕坐标（含 object-contain 的 letterbox） */
function toClient(info, nx, ny) {
  const scale = Math.min(info.w / info.cw, info.h / info.ch);
  const dispW = info.cw * scale;
  const dispH = info.ch * scale;
  return {
    x: info.left + (info.w - dispW) / 2 + nx * dispW,
    y: info.top + (info.h - dispH) / 2 + ny * dispH,
  };
}

/** 主画布黑色像素量（阈值 <80）与质心 */
function darkStats(page) {
  return page.evaluate(() => {
    const list = [...document.querySelectorAll('canvas')]
      .map((c) => ({ c, r: c.getBoundingClientRect() }))
      .filter((o) => o.r.width > 200 && o.r.height > 200 && o.c.width > 500);
    if (!list.length) return null;
    list.sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
    const c = list[0].c;
    const w = c.width;
    const h = c.height;
    const d = c.getContext('2d').getImageData(0, 0, w, h).data;
    let dark = 0, sx = 0, sy = 0;
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        const i = (y * w + x) * 4;
        if (d[i] < 80 && d[i + 1] < 80 && d[i + 2] < 80) {
          dark++;
          sx += x;
          sy += y;
        }
      }
    }
    return dark ? { dark, cx: sx / dark / w, cy: sy / dark / h, cw: w, ch: h } : { dark: 0, cx: 0.5, cy: 0.5, cw: w, ch: h };
  });
}

async function waitNoBusy(page, label, timeout = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const busy = await page.evaluate(() => /修复中…|渲染中…/.test(document.body.innerText));
    if (!busy) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`[warn] 等待"${label}"超时`);
  return false;
}

async function waitCanvas(page, timeout = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const info = await canvasInfo(page);
    if (info) return info;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

/** 在质心附近画三条横向笔画（笔径已调到最大） */
async function paintRows(page, cx, cy) {
  for (const dy of [-0.045, 0, 0.045]) {
    const info = await canvasInfo(page);
    const a = toClient(info, cx - 0.07, cy + dy);
    const b = toClient(info, cx + 0.07, cy + dy);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) {
      await page.mouse.move(a.x + ((b.x - a.x) * i) / 12, a.y + ((b.y - a.y) * i) / 12);
      await new Promise((r) => setTimeout(r, 12));
    }
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 400));
    await waitNoBusy(page, '擦除修复');
  }
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(DL, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--window-size=1400,900', '--use-gl=swiftshader'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  page.on('console', (m) => {
    const t = m.text();
    if (/error|失败|异常/i.test(t)) console.log('[page]', t);
  });
  await page.goto(URL_BASE, { waitUntil: 'networkidle2', timeout: 60000 });

  // 1) 导入两张测试图：纯白底 + 正中黑圆
  await page.evaluate(async () => {
    const make = async (label) => {
      const c = document.createElement('canvas');
      c.width = 1200;
      c.height = 1600;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, 1200, 1600);
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(600, 800, 150, 0, Math.PI * 2);
      ctx.fill();
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      return new File([blob], `e2e-${label}.png`, { type: 'image/png' });
    };
    const dt = new DataTransfer();
    dt.items.add(await make('A'));
    dt.items.add(await make('B'));
    const input = document.querySelector('input[type=file]');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });

  await page.waitForSelector('::-p-text(③ 去污)', { timeout: 60000 });
  await page.click('::-p-text(③ 去污)');
  await waitCanvas(page);
  await waitNoBusy(page, '去污底图');
  const before = await darkStats(page);
  if (!before.dark) throw new Error('去污画布未渲染出黑圆');
  console.log('涂抹前：', JSON.stringify(before));

  // 2) 笔径调到最大后涂抹
  await page.evaluate(() => {
    const label = [...document.querySelectorAll('label')].find((l) => /笔径/.test(l.textContent || ''));
    const input = label?.querySelector('input[type=range]');
    if (!input) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '100');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 200));
  await paintRows(page, before.cx, before.cy);
  await waitNoBusy(page, '擦除修复');

  const erased = await darkStats(page);
  console.log('涂抹后：', JSON.stringify(erased));
  check(
    '③ 去污：涂抹后黑块被清除（黑色像素显著减少）',
    erased.dark < before.dark * 0.8,
    `${before.dark} → ${erased.dark}`,
  );
  await page.screenshot({ path: path.join(OUT, '1-erase-stage.png') });

  // 3) 回到 ② 增强滤镜：预览必须包含擦除结果
  await page.click('::-p-text(② 增强滤镜)');
  await waitCanvas(page);
  await waitNoBusy(page, '增强预览');
  await new Promise((r) => setTimeout(r, 1200));
  const enhanced = await darkStats(page);
  console.log('增强预览：', JSON.stringify(enhanced));
  check(
    '② 增强滤镜：预览包含擦除效果（黑量明显低于原始）',
    enhanced.dark < before.dark * 0.8 && enhanced.dark <= erased.dark * 1.1,
    `增强=${enhanced.dark} / ③=${erased.dark} / 原始=${before.dark}`,
  );
  await page.screenshot({ path: path.join(OUT, '2-enhance-stage.png') });

  // 4) 切换滤镜（灰度）后，滤镜重跑仍需重新应用擦除蒙版
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === '灰度');
    btn?.click();
  });
  await new Promise((r) => setTimeout(r, 3000));
  await waitNoBusy(page, '滤镜切换');
  const gray = await darkStats(page);
  console.log('灰度滤镜：', JSON.stringify(gray));
  check(
    '② 增强滤镜：切换滤镜后擦除依然生效',
    gray.dark < before.dark * 0.8 && gray.dark <= erased.dark * 1.1,
    `灰度=${gray.dark} / ③=${erased.dark} / 原始=${before.dark}`,
  );
  await page.screenshot({ path: path.join(OUT, '3-enhance-gray.png') });

  // 5) 导出对话框：自选页范围
  await page.evaluate(() => {
    document.querySelector('header button.btn-primary')?.click();
  });
  await page.waitForSelector('::-p-text(导出文档)', { timeout: 15000 });
  check('导出对话框出现「导出范围」', await page.evaluate(() => /导出范围/.test(document.body.innerText)));
  await page.click('::-p-text(自选页)');
  await new Promise((r) => setTimeout(r, 300));
  check('自选页默认全选（已选 2 / 2 页）', await page.evaluate(() => /已选 2 \/ 2 页/.test(document.body.innerText)));

  const chips = await page.evaluate(() => document.querySelectorAll('.fixed.inset-0.z-50 .grid-cols-4 button').length);
  check('自选页展示全部页面缩略图（2 个）', chips === 2, String(chips));
  await page.evaluate(() => {
    const grid = document.querySelector('.fixed.inset-0.z-50 .grid-cols-4');
    grid?.querySelectorAll('button')[1]?.click();
  });
  await new Promise((r) => setTimeout(r, 300));
  check('取消一页后显示「已选 1 / 2 页」', await page.evaluate(() => /已选 1 \/ 2 页/.test(document.body.innerText)));
  const btnLabel = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /^导出（\d+ 页）/.test((x.textContent || '').trim()));
    return (b?.textContent || '').trim();
  });
  check('导出按钮页数同步为 1 页', /^导出（1 页）$/.test(btnLabel), btnLabel);
  await page.screenshot({ path: path.join(OUT, '4-export-dialog.png') });

  // 6) 真实导出这 1 页 PDF（低画质加速），校验文件落盘
  const client = await page.createCDPSession();
  await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === '低');
    b?.click();
  });
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /^导出（1 页）/.test((x.textContent || '').trim()));
    b?.click();
  });
  const t0 = Date.now();
  let pdf = null;
  while (Date.now() - t0 < 180000) {
    const files = fs.readdirSync(DL).filter((f) => f.endsWith('.pdf'));
    if (files.length) {
      pdf = files[0];
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const size = pdf ? fs.statSync(path.join(DL, pdf)).size : 0;
  check('自选 1 页可正常导出 PDF', !!pdf && size > 1000, pdf ? `${pdf} · ${size} bytes` : '无文件');

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} 项通过 ===`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('E2E ERROR:', e);
  process.exit(1);
});
