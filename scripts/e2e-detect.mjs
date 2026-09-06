/**
 * 运行验证：角点外推精修后的边缘检测在「合成文档」样张上的表现。
 * - 干净文档：应识别为 found，四角贴合设定真值。
 * - 遮挡文档（一角被暗色物体盖住）：外推/凸包应仍还原出完整四边形。
 * 用法：先 `npm run dev`，再 `node scripts/e2e-detect.mjs`
 */
import puppeteer from 'puppeteer-core';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.env.E2E_BASE || 'http://localhost:5173/';

const ok = (cond, msg, detail = '') => {
  if (!cond) throw new Error(`断言失败: ${msg}${detail ? `（${detail}）` : ''}`);
  console.log(`  ✓ ${msg}${detail ? `（${detail}）` : ''}`);
};

// 真值四角（归一化，顺序 [左上,右上,右下,左下]）：带一点透视位移
const GT = [
  [0.24, 0.2],
  [0.8, 0.15],
  [0.86, 0.8],
  [0.18, 0.86],
];

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--no-first-run', '--disable-extensions'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 800 });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));

  // 等 dev server 与 opencv 就绪（首次加载 opencv.js 10MB 需稍候）
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });

  const runDetect = async (occlude) =>
    page.evaluate(async (gt, occlusion) => {
      const [{ detectQuadInMat }, { loadOpenCV }] = await Promise.all([
        import('/src/utils/detect.ts'),
        import('/src/utils/opencvLoader.ts'),
      ]);
      const cv = await loadOpenCV();
      const W = 480;
      const H = 360;
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      // 背景（桌面）：对角渐变
      const g = ctx.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, '#40404a');
      g.addColorStop(1, '#2c2c30');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      const pts = gt.map((p) => ({ x: p[0] * W, y: p[1] * H }));
      // 阴影：右下偏移投出
      ctx.save();
      ctx.translate(7, 9);
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fill();
      ctx.restore();
      // 文档主体（近白）
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
      ctx.fillStyle = '#f2f2ee';
      ctx.fill();
      // 浅灰文本纹理行（增加细节，但不改变外框）
      ctx.strokeStyle = '#c7c7c7';
      ctx.lineWidth = 2;
      for (let row = 0; row < 6; row++) {
        const t = 0.18 + row * 0.11;
        const y = pts[0].y + (pts[3].y - pts[0].y) * t;
        const x0 = pts[0].x + (pts[3].x - pts[0].x) * t + 0.07 * W;
        const x1 = pts[0].x + (pts[3].x - pts[0].x) * t + 0.15 * W + (1 - Math.abs(t - 0.5)) * 0.55 * W;
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y);
        ctx.stroke();
      }
      if (occlusion) {
        // 遮挡：一块暗色物体盖住右下区域
        ctx.fillStyle = '#2a2a2e';
        ctx.fillRect(W * 0.62, H * 0.72, W * 0.42, H * 0.34);
      }
      const img = ctx.getImageData(0, 0, W, H);
      const src = cv.matFromImageData(img);
      let res;
      try {
        res = detectQuadInMat(cv, src);
      } finally {
        src.delete();
      }
      return res ? { status: res.status, quad: res.quad, confidence: res.confidence } : null;
    }, GT, occlude);

  console.log('1. 干净文档检测');
  const clean = await runDetect(false);
  ok(clean, '返回非空');
  ok(clean.quad && clean.quad.length === 4, '返回 4 个角点');

  // 与真值比对：最大归一化角点误差
  const maxErr = (quad) => {
    const g = GT;
    // 需与 orderQuad 同序（[左上,右上,右下,左下]）；GT 已按该序，直接对应
    let m = 0;
    for (let i = 0; i < 4; i++) {
      const dx = quad[i].x - g[i][0];
      const dy = quad[i].y - g[i][1];
      m = Math.max(m, Math.hypot(dx, dy));
    }
    return m;
  };

  const eClean = maxErr(clean.quad);
  ok(eClean < 0.1, '干净文档四角贴合真值', `最大角点误差=${eClean.toFixed(3)}`);
  console.log(`    检测状态=${clean.status} 置信度=${clean.confidence} 用时未知（内部已统计）`);

  console.log('2. 遮挡文档检测（右下角被暗物盖住）');
  const occ = await runDetect(true);
  ok(occ, '遮挡场景返回非空');
  ok(occ.quad && occ.quad.length === 4, '遮挡场景仍返回 4 个角点');
  const eOcc = maxErr(occ.quad);
  ok(eOcc < 0.14, '遮挡场景仍贴合真值（外推/凸包还原被盖角）', `最大角点误差=${eOcc.toFixed(3)}`);

  console.log('\n检测运行验证全部通过 ✓');
} finally {
  await browser.close();
}
