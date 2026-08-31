/**
 * E2E：多草稿管理功能验证（puppeteer-core + 本机 Edge）
 * 覆盖：空态 → 导入建草稿 → 自动保存 → 刷新恢复 → 返回列表 → 重命名 →
 *       新建第二个草稿与排序 → 单删（确认弹窗）→ 批量删除 → IndexedDB 数据校验
 */
import puppeteer from 'puppeteer-core';
import { writeFileSync, mkdirSync } from 'node:fs';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.env.E2E_BASE || 'http://localhost:5173/';
const SHOT_DIR = 'e2e-shots';

// 1x1 PNG（不同颜色不需要，同字节即可）
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
mkdirSync(SHOT_DIR, { recursive: true });
const files = ['a.png', 'b.png', 'c.png'].map((n) => {
  writeFileSync(`${SHOT_DIR}/${n}`, PNG);
  return `${process.cwd()}/${SHOT_DIR}/${n}`.replaceAll('\\', '/');
});

const ok = (cond, msg) => {
  if (!cond) throw new Error(`断言失败: ${msg}`);
  console.log(`  ✓ ${msg}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitText(page, text, timeout = 8000) {
  await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text);
}

/** 读取 IndexedDB（drafts 全部 + pages 计数） */
function readDb(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('webscanner-drafts');
        req.onsuccess = () => {
          const db = req.result;
          const getAll = db.transaction('drafts', 'readonly').objectStore('drafts').getAll();
          getAll.onsuccess = () => {
            const count = db.transaction('pages', 'readonly').objectStore('pages').count();
            count.onsuccess = () => {
              db.close();
              resolve({ drafts: getAll.result, pageCount: count.result });
            };
            count.onerror = () => reject(count.error);
          };
          getAll.onerror = () => reject(getAll.error);
        };
        req.onerror = () => reject(req.error);
      }),
  );
}

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--no-first-run', '--disable-extensions'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 200)));

  console.log('1. 首页空态');
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await waitText(page, '智能');
  ok(true, '首页加载（标题渲染）');

  console.log('2. 导入 2 张图片 → 新建草稿进入编辑页');
  const fileInput = await page.$('input[type="file"]');
  ok(!!fileInput, '存在文件导入入口');
  await fileInput.uploadFile(files[0], files[1]);
  await page.waitForFunction(() => location.hash.startsWith('#/editor/'), { timeout: 8000 });
  const hash1 = await page.evaluate(() => location.hash);
  ok(/^#\/editor\/\d+$/.test(hash1), `路由跳转编辑页 ${hash1}`);
  await waitText(page, '未命名文档');
  await waitText(page, '2 页 · 当前 1');
  ok(true, '编辑页显示草稿名「未命名文档」与页数');

  console.log('3. 自动保存（防抖 800ms）落盘校验');
  await sleep(1800);
  let db1 = await readDb(page);
  ok(db1.drafts.length === 1, `drafts 表 1 条（实际 ${db1.drafts.length}）`);
  ok(db1.drafts[0].pageOrder.length === 2, `pageOrder 2 页（实际 ${db1.drafts[0].pageOrder.length}）`);
  ok(typeof db1.drafts[0].coverThumb === 'string' && db1.drafts[0].coverThumb.startsWith('data:image'), 'coverThumb 已生成');
  ok(db1.pageCount === 2, `pages 表 2 条（实际 ${db1.pageCount}）`);

  console.log('4. 刷新恢复（编辑态 + 数据完整）');
  await page.reload({ waitUntil: 'networkidle2' });
  await waitText(page, '2 页 · 当前 1');
  const hashReload = await page.evaluate(() => location.hash);
  ok(hashReload === hash1, `刷新后路由保持 ${hashReload}`);

  console.log('5. 删 1 页 → 返回首页（flush + 列表更新）');
  // 缩略图 hover 出现删除按钮（第一页），点击删除
  const thumbDel = await page.$('[data-idx="0"] button[title="删除页"]');
  ok(!!thumbDel, '缩略图删除按钮存在');
  await page.$eval('[data-idx="0"]', (el) => el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })));
  await thumbDel.click();
  await waitText(page, '1 页 · 当前 1');
  const back = await page.$('button[title="返回首页"]');
  await back.click();
  await page.waitForFunction(() => location.hash === '#/' || location.hash === '' || location.hash === '#', { timeout: 8000 });
  await waitText(page, '我的草稿');
  await sleep(600); // flush 后 refreshDrafts
  const card = await page.$('article, [role="button"]');
  ok(!!card, '草稿卡片渲染');
  const cardText = await page.evaluate(() => document.body.innerText);
  ok(cardText.includes('1 页'), '列表显示页数 1（编辑已保存）');
  ok(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(cardText), '列表显示创建日期格式 YYYY-MM-DD HH:mm');

  console.log('6. 行内重命名（点击名称 → 输入 → 回车）');
  const nameSpan = await page.$('span[title*="重命名"]');
  ok(!!nameSpan, '名称元素存在');
  await nameSpan.click();
  await page.waitForSelector('input[maxlength="60"]', { timeout: 4000 });
  await page.type('input[maxlength="60"]', '测试文档A');
  await page.keyboard.press('Enter');
  await waitText(page, '测试文档A');
  ok(true, '重命名生效并显示于列表');

  console.log('7. 新建第二个草稿 → 倒序排序');
  const input2 = await page.$('input[type="file"]');
  await input2.uploadFile(files[2]);
  await page.waitForFunction(() => /^#\/editor\/\d+$/.test(location.hash), { timeout: 8000 });
  const hash2 = await page.evaluate(() => location.hash);
  ok(hash2 !== hash1, `新草稿路由 ${hash2}`);
  await waitText(page, '1 页 · 当前 1');
  await sleep(1800); // 等自动保存
  await page.$eval('button[title="返回首页"]', (el) => el.click());
  await waitText(page, '我的草稿');
  await sleep(600);
  const names = await page.$$eval('span[title*="重命名"]', (els) => els.map((e) => e.textContent));
  ok(names.length === 2, `列表 2 张卡片（实际 ${names.length}）`);
  ok(names[0] === '未命名文档' && names[1] === '测试文档A', `按最近编辑倒序：${JSON.stringify(names)}`);

  console.log('8. 单删（确认弹窗）');
  // 第一张卡片 hover → 删除按钮
  await page.evaluate(() => {
    const el = document.querySelector('span[title*="重命名"]').closest('[role="button"]');
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
  });
  const delBtn = await page.$('button[title="删除草稿"]');
  ok(!!delBtn, 'PC hover 删除按钮存在');
  await delBtn.click();
  await waitText(page, '删除后无法恢复');
  ok(true, '二次确认弹窗出现');
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    btns.find((b) => b.className.includes('btn-danger') && b.textContent.includes('删除')).click();
  });
  await waitText(page, '草稿已删除');
  await sleep(600);
  const namesAfter = await page.$$eval('span[title*="重命名"]', (els) => els.map((e) => e.textContent));
  ok(namesAfter.length === 1 && namesAfter[0] === '测试文档A', `删除后剩 1 张（${JSON.stringify(namesAfter)}）`);

  console.log('9. 批量删除（选择模式 + 确认）');
  const clickDialogConfirm = () =>
    page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]');
      [...dlg.querySelectorAll('button')]
        .find((b) => b.className.includes('btn-danger') && b.textContent.includes('删除'))
        .click();
    });
  await page.evaluate(() => {
    [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '选择').click();
  });
  await waitText(page, '全选');
  await page.evaluate(() => {
    document.querySelector('span[title*="重命名"]').closest('[role="button"]').click();
  });
  await waitText(page, '删除(1)');
  await page.evaluate(() => {
    [...document.querySelectorAll('button')]
      .find((b) => b.className.includes('btn-danger'))
      .click();
  });
  await waitText(page, '删除后无法恢复');
  await clickDialogConfirm();
  await page.waitForFunction(() => !document.body.innerText.includes('我的草稿'), { timeout: 6000 });
  ok(true, '批量删除后草稿区消失（空态恢复）');

  console.log('10. IndexedDB 终态校验');
  const dbEnd = await readDb(page);
  ok(dbEnd.drafts.length === 0, `drafts 表清空（实际 ${dbEnd.drafts.length}）`);
  ok(dbEnd.pageCount === 0, `pages 表清空（实际 ${dbEnd.pageCount}）`);

  await page.screenshot({ path: `${SHOT_DIR}/final.png` });
  console.log('\n全部通过 ✓');
} finally {
  await browser.close();
}
