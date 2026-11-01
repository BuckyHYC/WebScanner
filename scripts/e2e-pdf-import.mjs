/**
 * PDF 导入 e2e：生成一个 3 页 PDF（pdf-lib）→ 首页文件输入导入 →
 * 校验进入编辑器、页数、页码命名、渲染非空白。
 * 用法：先 npm run dev，再 node scripts/e2e-pdf-import.mjs
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const URL_BASE = process.env.E2E_URL || 'http://localhost:5173/';
const OUT = path.resolve('e2e-tmp');

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? ' — ' + extra : ''}`);
};

/** 生成 3 页测试 PDF：纯文本 + 矩形块（走标准字体路径，验证 pdf.js 渲染） */
async function makePdf(file) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 1; i <= 3; i++) {
    const page = doc.addPage([595, 842]);
    page.drawRectangle({ x: 40, y: 40, width: 515, height: 762, borderColor: rgb(0.1, 0.1, 0.1), borderWidth: 2 });
    page.drawText(`PDF IMPORT TEST PAGE ${i}`, { x: 70, y: 740, size: 26, font, color: rgb(0, 0, 0) });
    for (let line = 0; line < 14; line++) {
      page.drawRectangle({ x: 70, y: 660 - line * 40, width: 380 - (line % 3) * 60, height: 12, color: rgb(0.15, 0.15, 0.15) });
    }
    page.drawText(`page-${i}`, { x: 70, y: 60, size: 14, font, color: rgb(0.3, 0.3, 0.3) });
  }
  const bytes = await doc.save();
  fs.writeFileSync(file, bytes);
  return bytes.length;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const pdfPath = path.join(OUT, 'e2e-import.pdf');
  const size = await makePdf(pdfPath);
  console.log(`测试 PDF：${pdfPath}（${size} 字节，3 页）`);

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

  // 1) 通过首页文件输入导入 PDF
  const input = await page.waitForSelector('input[type=file]', { timeout: 20000 });
  await input.uploadFile(pdfPath);

  // 2) 等待进入编辑器（裁剪 Tab 出现）
  await page.waitForSelector('::-p-text(① 裁剪矫正)', { timeout: 120000 });
  check('导入 PDF 后进入编辑器', true);

  // 3) 等 3 页全部建好（顶栏「3 页」）
  const t0 = Date.now();
  let pageInfo = '';
  while (Date.now() - t0 < 180000) {
    pageInfo = await page.evaluate(() => {
      const m = document.body.innerText.match(/(\d+) 页 · 当前 (\d+)/);
      return m ? `${m[1]}/${m[2]}` : '';
    });
    if (pageInfo.startsWith('3/')) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  check('PDF 3 页全部转成页面', pageInfo.startsWith('3/'), pageInfo);

  // 4) 页面命名带 PDF 文件名与页码（顶栏页名 / 缩略图 title）
  const named = await page.evaluate(() => {
    const text = document.body.innerText;
    const titles = [...document.querySelectorAll('[title]')].map((e) => e.getAttribute('title') || '').join(' | ');
    return { text, titles };
  });
  const hitName = /e2e-import\s*第\d页/.test(named.text) || /e2e-import\s*第\d页/.test(named.titles);
  const nameSample = (named.text.match(/e2e-import[^\n]{0,20}/) || [''])[0];
  check('页面名称沿用 PDF 文件名 + 页码', hitName, nameSample);

  // 5) 渲染非空白：统计画布暗像素
  await new Promise((r) => setTimeout(r, 1500));
  const dark = await page.evaluate(() => {
    const cs = [...document.querySelectorAll('canvas')]
      .map((c) => ({ c, r: c.getBoundingClientRect() }))
      .filter((o) => o.r.width > 200 && o.r.height > 200 && o.c.width > 100);
    if (!cs.length) return -1;
    cs.sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
    const c = cs[0].c;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4 * 7) if (d[i] < 100 && d[i + 1] < 100 && d[i + 2] < 100) n++;
    return n;
  });
  check('PDF 页面渲染出内容（非空白）', dark > 50, `暗像素采样=${dark}`);
  await page.screenshot({ path: path.join(OUT, 'pdf-import-1.png') });

  // 6) 切到第 2、3 页确认都能渲染
  for (const idx of [2, 3]) {
    const clicked = await page.evaluate((i) => {
      const items = [...document.querySelectorAll('img')].filter((im) => im.closest('button,div[role=button],div'));
      const target = items[i - 1];
      if (!target) return false;
      target.closest('button')?.click() ?? target.click();
      return true;
    }, idx);
    await new Promise((r) => setTimeout(r, 1200));
    const cur = await page.evaluate(() => (document.body.innerText.match(/当前 (\d+)/) || [])[1] || '');
    console.log(`  切页 ${idx} → 当前 ${cur}（click=${clicked}）`);
  }
  await page.screenshot({ path: path.join(OUT, 'pdf-import-2.png') });

  // 7) 导出 PDF 能正常完成（回归：导入→导出闭环）
  const client = await page.createCDPSession();
  const dl = path.join(OUT, 'downloads');
  fs.mkdirSync(dl, { recursive: true });
  await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl, eventsEnabled: true });
  await page.evaluate(() => {
    document.querySelector('header button.btn-primary')?.click();
  });
  await page.waitForSelector('::-p-text(导出文档)', { timeout: 15000 });
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === '低');
    b?.click();
  });
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /^导出（\d+ 页）/.test((x.textContent || '').trim()));
    b?.click();
  });
  const t1 = Date.now();
  let out = null;
  while (Date.now() - t1 < 180000) {
    const files = fs.readdirSync(dl).filter((f) => f.endsWith('.pdf'));
    if (files.length) {
      out = files[0];
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  check('导入的 PDF 可再次导出为 PDF', !!out, out ? `${out} · ${fs.statSync(path.join(dl, out)).size} bytes` : '无文件');

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} 项通过 ===`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('E2E ERROR:', e);
  process.exit(1);
});
