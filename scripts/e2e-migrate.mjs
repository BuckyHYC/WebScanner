/**
 * E2E：旧版单草稿迁移验证
 * 先向旧库 webscanner-draft 写入一条 'current' 草稿（旧格式：页数组 + ArrayBuffer blob），
 * 再刷新页面，验证自动迁移为新 drafts/pages 结构且旧库被删除。
 */
import puppeteer from 'puppeteer-core';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.env.E2E_BASE || 'http://localhost:5173/';

const ok = (cond, msg) => {
  if (!cond) throw new Error(`断言失败: ${msg}`);
  console.log(`  ✓ ${msg}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 在页面里构造旧格式单草稿写入旧库 */
async function seedLegacy(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const canvas = document.createElement('canvas');
        canvas.width = 8;
        canvas.height = 10;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#dddddd';
        ctx.fillRect(0, 0, 8, 10);
        canvas.toBlob(async (blob) => {
          if (!blob) return reject(new Error('toBlob 失败'));
          const buf = await blob.arrayBuffer();
          const page1 = {
            id: 'legacy-p1',
            name: '扫描_001',
            blob: buf,
            blobType: 'image/jpeg',
            preview: canvas.toDataURL('image/jpeg', 0.7),
            thumb: canvas.toDataURL('image/jpeg', 0.6),
            width: 8,
            height: 10,
            corners: [
              { x: 0, y: 0 },
              { x: 1, y: 0 },
              { x: 1, y: 1 },
              { x: 0, y: 1 },
            ],
            polygon: null,
            rotation: 0,
            flipH: false,
            flipV: false,
            fineRotate: 0,
            filter: { mode: 'magic', strength: 80, brightness: 0, contrast: 0, saturation: 0, sharpen: 0, shadow: 0, cleanBg: 0, denoise: 0, block: 41, cValue: 10 },
            filterName: '增强',
          };
          const req = indexedDB.open('webscanner-draft', 1);
          req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains('draft')) req.result.createObjectStore('draft');
          };
          req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction('draft', 'readwrite');
            tx.objectStore('draft').put([page1], 'current');
            tx.oncomplete = () => {
              db.close();
              resolve(true);
            };
            tx.onerror = () => reject(tx.error);
          };
          req.onerror = () => reject(req.error);
        }, 'image/jpeg', 0.9);
      }),
  );
}

async function readDbs(page) {
  return page.evaluate(async () => {
    const dbs = (await indexedDB.databases?.())?.map((d) => d.name) ?? [];
    const out = { names: dbs, drafts: null, pageCount: null };
    if (dbs.includes('webscanner-drafts')) {
      const req = indexedDB.open('webscanner-drafts');
      req.onsuccess = () => {
        const db = req.result;
        const all = db.transaction('drafts', 'readonly').objectStore('drafts').getAll();
        return new Promise((res) => {
          all.onsuccess = () => {
            out.drafts = all.result;
            db.close();
            res();
          };
        });
      };
    }
    await new Promise((r) => setTimeout(r, 300));
    return out;
  });
}

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--no-first-run', '--disable-extensions'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(BASE, { waitUntil: 'networkidle2' });

  console.log('1. 写入旧版单草稿');
  await seedLegacy(page);
  ok(true, '旧库 webscanner-draft 已写入 1 页草稿');

  console.log('2. 刷新触发迁移');
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForFunction(() => document.body.innerText.includes('我的草稿'), { timeout: 8000 });
  await sleep(500);
  const dbs = await readDbs(page);
  ok(Array.isArray(dbs.drafts) && dbs.drafts.length === 1, `迁移为 1 个草稿（实际 ${dbs.drafts?.length}）`);
  ok(dbs.drafts[0].pageOrder.length === 1 && dbs.drafts[0].pageOrder[0] === 'legacy-p1', 'pageOrder 保留原页 id');
  ok(!!dbs.drafts[0].coverThumb, '迁移后生成封面缩略图');
  ok(!dbs.names.includes('webscanner-draft'), `旧库已删除（现有库：${JSON.stringify(dbs.names)}）`);

  console.log('3. 打开迁移草稿验证页面数据');
  await page.evaluate(() => {
    document.querySelector('span[title*="重命名"]').closest('[role="button"]').click();
  });
  await page.waitForFunction(() => /^#\/editor\/\d+$/.test(location.hash), { timeout: 8000 });
  await page.waitForFunction(() => document.body.innerText.includes('1 页 · 当前 1'), { timeout: 8000 });
  await page.waitForFunction(() => document.body.innerText.includes('增强'), { timeout: 8000 });
  ok(true, '编辑页正常加载，滤镜名「增强」保留');

  console.log('\n迁移验证全部通过 ✓');
} finally {
  await browser.close();
}
