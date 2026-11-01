/**
 * 文档对话端到端验证：识别后与模型连续两轮问答。
 * 前置：本机推理服务已就绪（scripts/start-ollama-ocr.ps1 或开机自启已拉起）。
 *
 * 用法：node scripts/e2e-ocr-chat.mjs
 *   E2E_IMAGE  指定样张（默认官方收据样张）
 *   E2E_URL    站点地址（默认 http://localhost:5173/）
 *
 * 校验点：
 *   1. 识别完成后出现「文档对话」入口
 *   2. 第一轮提问拿到回答（出现可复制的助手气泡）
 *   3. 第二轮纯文本提问能引用上一轮结果（金额 ×2），证明多轮上下文生效
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const URL_BASE = process.env.E2E_URL || 'http://localhost:5173/';
const IMAGE = process.env.E2E_IMAGE || 'D:\\DevTools\\xiaomi-ocr\\samples\\receipt.jpg';
const OUT = 'e2e-tmp';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(IMAGE)) throw new Error(`样张不存在：${IMAGE}`);
  console.log(`样张：${IMAGE}`);

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--window-size=1400,900', '--use-gl=swiftshader'],
    protocolTimeout: 600000,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  page.on('console', (m) => {
    const t = m.text();
    if (/error|fail|异常|失败/i.test(t)) console.log('[page]', t);
  });

  const bodyText = () => page.evaluate(() => document.body.innerText);
  async function waitForText(keyword, timeout = 180000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if ((await bodyText()).includes(keyword)) return true;
      await sleep(2000);
    }
    return false;
  }

  await page.goto(URL_BASE, { waitUntil: 'networkidle2', timeout: 60000 });

  // 1) 导入样张
  const fileInput = await page.waitForSelector('input[type=file]', { timeout: 15000 });
  await fileInput.uploadFile(IMAGE);

  // 2) 进④，切本机引擎并识别
  await page.waitForSelector('::-p-text(④ 文字识别)', { timeout: 30000 });
  await page.click('::-p-text(④ 文字识别)');
  const engineTab = await page.waitForSelector('::-p-text(本机 Xiaomi-OCR)', { timeout: 20000 });
  await engineTab.click();

  const recognizeBtn = await page.waitForSelector('::-p-text(开始识别)', { timeout: 20000 });
  await recognizeBtn.click();
  console.log('已触发识别，等待结果…');
  // 注意不能等「识别结果」文本：它同时是子 Tab 的标签，会在识别完成前就命中。
  // 改为等只读结果框里真的出现文字，同时确保识别流程已释放 busy（否则对话输入框仍是禁用态）。
  await page.waitForFunction(
    () => {
      const ta = document.querySelector('textarea[readonly]');
      return !!ta && ta.value.trim().length > 0;
    },
    { timeout: 240000, polling: 1000 },
  );
  console.log('PASS: 识别完成');

  // 3) 切到文档对话
  const chatTab = await page.waitForSelector('::-p-text(文档对话)', { timeout: 15000 });
  await chatTab.click();
  await page.waitForSelector('textarea:not([readonly])', { timeout: 15000 });
  console.log('PASS: 对话入口可用');

  // 4) 第一轮提问
  const ask = async (question, answerKeyword, timeout = 240000) => {
    const box = await page.waitForSelector('textarea:not([readonly])', { timeout: 15000 });
    await box.click();
    await box.type(question, { delay: 10 });
    // 诊断：确认受控 textarea 真的收到了值、发送按钮已启用
    const state = await page.evaluate(() => {
      const ta = document.querySelector('textarea:not([readonly])');
      const btns = [...document.querySelectorAll('button')].filter((b) => (b.textContent || '').includes('发送'));
      return { value: ta ? ta.value : null, sendDisabled: btns.map((b) => b.disabled) };
    });
    console.log('  输入状态:', JSON.stringify(state));
    const sendBtn = await page.waitForSelector('::-p-text(发送)', { timeout: 10000 });
    await sendBtn.click();
    console.log(`  问：${question}`);
    // 统一用轮询页面文本判断，避免 waitForSelector 的协议层超时
    const marker = answerKeyword || '复制'; // 无关键词时等助手气泡下的「复制」按钮
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const txt = await bodyText();
      if (txt.includes(marker)) return true;
      const failed = /提问失败/.test(txt);
      if (failed) {
        await page.screenshot({ path: path.join(OUT, 'ocr-chat-error.png') });
        throw new Error(`提问失败：${txt.slice(0, 600)}`);
      }
      await sleep(2000);
    }
    await page.screenshot({ path: path.join(OUT, 'ocr-chat-timeout.png') });
    throw new Error(`等待回答超时（${timeout}ms），页面文本：${(await bodyText()).slice(0, 400)}`);
  };

  await ask('总金额是多少？');
  const firstAnswer = await page.evaluate(() => {
    const bubbles = [...document.querySelectorAll('div')].filter((d) => d.className.includes('rounded-bl-sm'));
    return bubbles.length ? bubbles[bubbles.length - 1].textContent : '';
  });
  console.log('第一轮回答:', JSON.stringify(firstAnswer.slice(0, 120)));
  const firstOk = /5\.90/.test(firstAnswer);
  console.log(firstOk ? 'PASS: 第一轮答出总金额 5.90' : 'FAIL: 第一轮未答出 5.90');

  // 5) 第二轮：纯文本追问，必须依赖上一轮上下文
  await ask('把这个金额乘以 2 是多少？', '11.80');
  const allText = await bodyText();
  const secondOk = allText.includes('11.80');
  console.log(secondOk ? 'PASS: 第二轮正确换算为 11.80（多轮上下文生效）' : 'FAIL: 第二轮未引用上一轮的金额');

  await page.screenshot({ path: path.join(OUT, 'ocr-chat-e2e.png') });

  // 6) 持久化：刷新后对话仍在
  await sleep(2500);
  await page.reload({ waitUntil: 'networkidle2' });
  // page.click 只接受选择器字符串，ElementHandle 要直接 .click()
  await (await page.waitForSelector('::-p-text(④ 文字识别)', { timeout: 30000 })).click();
  await (await page.waitForSelector('::-p-text(本机 Xiaomi-OCR)', { timeout: 20000 })).click();
  await (await page.waitForSelector('::-p-text(文档对话)', { timeout: 15000 })).click();
  const persistOk = await waitForText('11.80', 20000);
  console.log(persistOk ? 'PASS: 刷新后对话已随草稿恢复' : 'FAIL: 刷新后对话丢失');
  await page.screenshot({ path: path.join(OUT, 'ocr-chat-persist.png') });

  await browser.close();
  const ok = firstOk && secondOk && persistOk;
  console.log(ok ? '\n=== 全部通过 ===' : '\n=== 存在失败项 ===');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('E2E ERROR:', e);
  process.exit(1);
});
