/**
 * 本机 Xiaomi-OCR-0 引擎端到端验证：puppeteer-core + 本机 Edge（零下载成本）。
 * 前置：本机推理服务已就绪
 *   powershell -ExecutionPolicy Bypass -File scripts\start-ollama-ocr.ps1
 *   ollama pull longwayxu/xiaomi-ocr-0:bf16
 *
 * 步骤：生成含文字与表格的测试图 → 导入 → 进④ → 切「本机 Xiaomi-OCR」→ 识别 → 校验 Markdown 输出。
 * 用真实图片验证：E2E_IMAGE=D:\path\doc.jpg E2E_EXPECT=关键词 node scripts/e2e-ocr-vlm.mjs
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const URL_BASE = process.env.E2E_URL || 'http://localhost:5173/';
const OUT = 'e2e-tmp';

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--window-size=1400,900', '--use-gl=swiftshader'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  page.on('console', (m) => {
    const t = m.text();
    if (/error|fail|异常|失败/i.test(t)) console.log('[page]', t);
  });
  await page.goto(URL_BASE, { waitUntil: 'networkidle2', timeout: 60000 });

  // 1) 导入测试图：E2E_IMAGE 指定真实图片（如官方样张），否则页面内生成
  const realImage = process.env.E2E_IMAGE;
  if (realImage) {
    const input = await page.waitForSelector('input[type=file]', { timeout: 15000 });
    await input.uploadFile(realImage);
  } else {
    await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1000;
    canvas.height = 700;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 1000, 700);
    ctx.fillStyle = '#111111';
    ctx.font = 'bold 40px "Microsoft YaHei", sans-serif';
    ctx.fillText('智能扫描 OCR 联调报告', 60, 90);
    ctx.font = '26px "Microsoft YaHei", sans-serif';
    ctx.fillText('本页用于验证本机 Xiaomi-OCR-0 引擎的整页解析能力。', 60, 160);
    ctx.fillText('识别结果应为 Markdown 格式，包含下面这张表格。', 60, 205);

    // 2x3 表格
    const x0 = 60;
    const y0 = 260;
    const cw = 280;
    const rh = 60;
    const rows = [
      ['项目', '数值', '备注'],
      ['识别引擎', 'Xiaomi-OCR-0', '本机运行'],
      ['参数量', '0.8B', '思考模式关闭'],
    ];
    ctx.strokeStyle = '#333333';
    ctx.lineWidth = 2;
    rows.forEach((row, r) => {
      row.forEach((cell, c) => {
        const x = x0 + c * cw;
        const y = y0 + r * rh;
        ctx.strokeRect(x, y, cw, rh);
        ctx.fillStyle = r === 0 ? '#0b3d91' : '#111111';
        ctx.font = `${r === 0 ? 'bold ' : ''}24px "Microsoft YaHei", sans-serif`;
        ctx.fillText(cell, x + 14, y + 40);
      });
    });

    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    const file = new File([blob], 'ocr-vlm-e2e.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = [...document.querySelectorAll('input[type=file]')][0];
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  // 2) 进入④文字识别
  await page.waitForSelector('::-p-text(④ 文字识别)', { timeout: 30000 });
  await page.click('::-p-text(④ 文字识别)');

  // 3) 切换到本机引擎
  const engineTab = await page.waitForSelector('::-p-text(本机 Xiaomi-OCR)', { timeout: 20000 });
  await engineTab.click();

  // 4) 点击识别（首次请求需服务端加载模型，放宽到 5 分钟）
  const btn = await page.waitForSelector('::-p-text(开始识别)', { timeout: 20000 });
  await btn.click();

  // 5) 轮询结果
  const started = Date.now();
  let text = '';
  while (Date.now() - started < 300000) {
    text = await page.evaluate(() => {
      const ta = document.querySelector('textarea[readonly]');
      return ta ? ta.value : '';
    });
    if (text.trim()) break;
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log('=== VLM OCR RESULT ===');
  console.log(text.slice(0, 1200));
  // 期望关键词：E2E_EXPECT 优先（真实样张按内容指定），否则用内置合成图的关键词
  const expects = (process.env.E2E_EXPECT || '智能扫描,Xiaomi-OCR-0').split(',').map((s) => s.trim()).filter(Boolean);
  const ok = expects.some((k) => text.includes(k));
  console.log(ok ? `PASS: 关键词命中（${expects.join(' / ')}）` : `FAIL: 未命中关键词（${expects.join(' / ')}）`);

  await page.screenshot({ path: path.join(OUT, 'ocr-vlm-e2e.png') });
  await browser.close();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('E2E ERROR:', e);
  process.exit(1);
});
