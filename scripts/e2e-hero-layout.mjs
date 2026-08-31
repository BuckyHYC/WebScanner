/**
 * E2E：手机端首页 hero 布局验证
 * - hero（动画+标题+按钮）保持原大小
 * - 「选择图片」按钮中心位于手机屏幕正中（±60px 容差）
 * - hero 占满首屏（min-h-100dvh），「下滑查看草稿」提示可见
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.env.E2E_BASE || 'http://localhost:5173/';
const VW = 390;
const VH = 844;

const ok = (cond, msg, detail = '') => {
  if (!cond) throw new Error(`断言失败: ${msg}${detail ? `（${detail}）` : ''}`);
  console.log(`  ✓ ${msg}${detail ? `（${detail}）` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitText = (page, text, timeout = 6000) =>
  page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text);

mkdirSync('e2e-tmp', { recursive: true });
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const img = 'e2e-tmp/m.png';
writeFileSync(img, PNG);

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--no-first-run', '--disable-extensions'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: VW, height: VH, isMobile: true, hasTouch: true });
  await page.goto(BASE, { waitUntil: 'networkidle2' });

  console.log('1. 手机端导入 1 张图片建立草稿');
  const input = await page.$('input[type="file"]');
  await input.uploadFile(img);
  await page.waitForFunction(() => /^#\/editor\/\d+$/.test(location.hash), { timeout: 10000 });
  await sleep(1400); // 防抖 800ms + 落盘

  console.log('2. 返回首页，验证 hero 布局');
  await page.evaluate(() => {
    [...document.querySelectorAll('button')].find((b) => b.title === '返回首页')?.click();
  });
  await waitText(page, '我的草稿');
  await waitText(page, '下滑查看 1 个草稿');
  ok(true, '滚动提示可见');

  const metrics = await page.evaluate(() => {
    const pickBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('选择图片'));
    const vf = document.querySelector('.scan-line')?.parentElement;
    const hero = vf?.parentElement?.parentElement;
    const r = pickBtn?.getBoundingClientRect();
    return {
      btnCenter: r ? r.top + r.height / 2 : null,
      btnH: r?.height ?? null,
      vfW: vf ? Math.round(vf.getBoundingClientRect().width) : null,
      heroH: hero ? Math.round(hero.getBoundingClientRect().height) : null,
      viewportH: window.innerHeight,
    };
  });
  ok(metrics.viewportH > 0, '视口就绪');
  ok(Math.abs(metrics.heroH - metrics.viewportH) <= 40, 'hero 占满手机首屏', `hero=${metrics.heroH} vs 视口=${metrics.viewportH}`);
  ok(metrics.vfW >= 220, '取景框动画保持原大小', `宽=${metrics.vfW}px`);
  ok(
    metrics.btnCenter !== null && Math.abs(metrics.btnCenter - metrics.viewportH / 2) <= 60,
    '「选择图片」按钮位于屏幕正中',
    `按钮中心=${Math.round(metrics.btnCenter)} / 屏幕中线=${metrics.viewportH / 2}`,
  );

  console.log('3. PC 视口下 hero 不占满整屏、草稿区紧随其后');
  await page.setViewport({ width: 1280, height: 900 });
  await sleep(400);
  const pc = await page.evaluate(() => {
    const vf = document.querySelector('.scan-line')?.parentElement;
    const hero = vf?.parentElement?.parentElement;
    const cards = document.querySelector('section');
    const heroBottom = hero ? Math.round(hero.getBoundingClientRect().bottom) : null;
    const listTop = cards ? Math.round(cards.getBoundingClientRect().top) : null;
    return { heroBottom, listTop, heroH: hero ? Math.round(hero.getBoundingClientRect().height) : null };
  });
  ok(pc.heroH !== null && pc.heroH < 900, 'PC 端 hero 高度适中', `hero=${pc.heroH}px`);
  ok(pc.listTop !== null && pc.listTop < 900, 'PC 端草稿列表在首屏内可见', `列表顶部=${pc.listTop}px`);

  console.log('\n布局验证全部通过 ✓');
} finally {
  await browser.close();
}
