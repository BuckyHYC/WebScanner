/**
 * OCR 功能端到端验证：puppeteer-core + 本机 Edge（零下载成本）。
 * 步骤：生成含文字的测试图 → 打开首页导入 → 进入④文字识别 → 点击识别 → 校验结果文本。
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

  // 2) 在页面内用 canvas 生成含文字的 PNG File，写入首页文件输入框
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 900;
    canvas.height = 400;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 900, 400);
    ctx.fillStyle = '#111111';
    ctx.font = 'bold 44px "Microsoft YaHei", sans-serif';
    ctx.fillText('智能扫描 OCR 测试行一', 60, 120);
    ctx.font = '32px "Microsoft YaHei", sans-serif';
    ctx.fillText('Hello WebScanner 12345', 60, 220);
    ctx.fillText('识别引擎联调验证 2026', 60, 310);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    const file = new File([blob], 'ocr-e2e-test.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    // 首页文件输入（Home.tsx inputRef）
    const inputs = [...document.querySelectorAll('input[type=file]')];
    const input = inputs[0];
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });

  // 3) 等待进入编辑器并出现④ Tab
  await page.waitForSelector('::-p-text(④ 文字识别)', { timeout: 30000 });
  await page.click('::-p-text(④ 文字识别)');

  // 4) 点击「开始识别」（首次会加载模型与 wasm，放宽超时）
  const btnLabel = await page.waitForSelector('::-p-text(开始识别)', { timeout: 20000 });
  await btnLabel.click();

  // 5) 等待识别结果写入 textarea（最长 5 分钟）
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

  console.log('=== OCR RESULT ===');
  console.log(JSON.stringify(text));
  const ok = text.includes('智能扫描') && text.includes('Hello') && text.includes('2026');
  console.log(ok ? 'PASS: 关键词全部命中' : 'FAIL: 关键词未全部命中');

  // 6) 持久化验证：刷新 → 首页草稿卡片 → 重新进入 → ④Tab → 文本仍在
  if (ok) {
    // 等待草稿自动保存防抖（800ms）触发后再刷新
    await new Promise((r) => setTimeout(r, 2500));
    await page.reload({ waitUntil: 'networkidle2' });
    // 刷新后 URL 仍是编辑器路由：草稿应从 IndexedDB 恢复（含 OCR 文本）
    await page.waitForSelector('::-p-text(④ 文字识别)', { timeout: 30000 });
    await page.click('::-p-text(④ 文字识别)');
    const restored = await page.evaluate(() => {
      const ta = document.querySelector('textarea[readonly]');
      return ta ? ta.value : '';
    });
    const persistOk = restored.includes('Hello');
    console.log(persistOk ? 'PASS: 刷新后 OCR 文本已随草稿恢复' : `FAIL: 刷新后文本丢失 (${JSON.stringify(restored)})`);
    await page.screenshot({ path: path.join(OUT, 'ocr-e2e-persist.png') });

    // 7) 过期标记验证：改滤镜 → 回④应出现「建议重新识别」
    if (persistOk) {
      await page.click('::-p-text(② 增强滤镜)');
      await page.waitForSelector('input[type=range]', { timeout: 20000 });
      await page.evaluate(() => {
        const slider = document.querySelector('input[type=range]');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(slider, '30');
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        slider.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.click('::-p-text(④ 文字识别)');
      await page.waitForSelector('::-p-text(建议重新识别)', { timeout: 15000 });
      console.log('PASS: 编辑滤镜后出现过期提示');
      await page.screenshot({ path: path.join(OUT, 'ocr-e2e-stale.png') });
    }
  }

  // 截图留档
  await page.screenshot({ path: path.join(OUT, 'ocr-e2e.png') });
  await browser.close();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('E2E ERROR:', e);
  process.exit(1);
});
