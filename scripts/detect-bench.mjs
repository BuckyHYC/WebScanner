/**
 * 边缘检测基准（benchmark）：在浏览器内合成 8 类真实拍摄场景，用真值四边形评估
 * src/utils/detect.ts 的 detectQuadInCanvas 精度。
 *
 * 用法：先 npm run dev，再 node scripts/detect-bench.mjs
 * 输出：每个场景的四角平均误差（占画面对角线百分比）、IoU、是否通过；
 *       场景图落盘到 e2e-tmp/detect-bench/ 便于人工核对。
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const URL_BASE = process.env.E2E_URL || 'http://localhost:5173/';
const OUT = path.resolve('e2e-tmp/detect-bench');

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--window-size=1200,800', '--use-gl=swiftshader'],
  });
  const page = await browser.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (/error|失败|异常/i.test(t)) console.log('[page]', t);
  });
  await page.goto(URL_BASE, { waitUntil: 'networkidle2', timeout: 60000 });

  const result = await page.evaluate(async () => {
    const { loadOpenCV } = await import('/src/utils/opencvLoader.ts');
    const { detectQuadInCanvas, refineQuadInCanvas } = await import('/src/utils/detect.ts');
    const cv = await loadOpenCV();

    // ---------- 场景构造工具 ----------
    const mkCanvas = (w, h) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    };

    /** A4 比例的“文档”：白底 + 文本行 + 标题 */
    const docCanvas = (w = 1200, h = 1600, dark = false) => {
      const c = mkCanvas(w, h);
      const g = c.getContext('2d');
      g.fillStyle = dark ? '#2b2b2b' : '#ffffff';
      g.fillRect(0, 0, w, h);
      g.fillStyle = dark ? '#e8e8e8' : '#1b1b1b';
      g.font = `bold ${Math.round(h * 0.028)}px serif`;
      g.fillText('边缘检测基准文档', w * 0.12, h * 0.08);
      g.fillStyle = dark ? '#d0d0d0' : '#333333';
      for (let i = 0; i < 22; i++) {
        const y = h * 0.13 + i * h * 0.035;
        const lw = w * (0.55 + ((i * 37) % 30) / 100);
        g.fillRect(w * 0.1, y, lw, h * 0.012);
      }
      return c;
    };

    /** 透视图：把文档按 dst 四边形贴到场景里（alpha 合成） */
    const warpDoc = (doc, dst, sceneW, sceneH) => {
      const src = cv.imread(doc);
      const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, doc.width, 0, doc.width, doc.height, 0, doc.height]);
      const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, dst.flatMap((p) => [p.x, p.y]));
      const M = cv.getPerspectiveTransform(srcPts, dstPts);
      const out = new cv.Mat();
      cv.warpPerspective(src, out, M, new cv.Size(sceneW, sceneH), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));
      const c = mkCanvas(sceneW, sceneH);
      cv.imshow(c, out);
      src.delete();
      out.delete();
      srcPts.delete();
      dstPts.delete();
      M.delete();
      return c;
    };

    /** 背景（木桌/白桌/深色桌）+ 文档 + 可选阴影/遮挡/杂物/卷曲/模糊 */
    const buildScene = (opts) => {
      const { W, H, dst, bg, doc, shadow, occlude, spine, clutter, curl, blur, noise } = opts;
      const scene = mkCanvas(W, H);
      const g = scene.getContext('2d');
      // 背景渐变 + 噪点
      const grad = g.createLinearGradient(0, 0, W, H);
      grad.addColorStop(0, bg[0]);
      grad.addColorStop(1, bg[1]);
      g.fillStyle = grad;
      g.fillRect(0, 0, W, H);
      for (let i = 0; i < 900; i++) {
        g.fillStyle = `rgba(0,0,0,${0.02 + Math.random() * 0.04})`;
        g.fillRect(Math.random() * W, Math.random() * H, 2 + Math.random() * 22, 1 + Math.random() * 5);
      }
      // 背景杂物（其他纸片、笔、杯口等干扰矩形/圆）
      if (clutter) {
        const cols = ['#e6e2da', '#c8ccd2', '#7a6a55', '#3a3f46', '#b8bfc7'];
        for (let i = 0; i < 14; i++) {
          g.fillStyle = cols[i % cols.length];
          g.globalAlpha = 0.55 + Math.random() * 0.4;
          if (i % 3 === 0) {
            g.beginPath();
            g.arc(Math.random() * W, Math.random() * H, 40 + Math.random() * 120, 0, Math.PI * 2);
            g.fill();
          } else {
            const w = 120 + Math.random() * 420;
            const h = 20 + Math.random() * 220;
            g.save();
            g.translate(Math.random() * W, Math.random() * H);
            g.rotate((Math.random() - 0.5) * 1.2);
            g.fillRect(-w / 2, -h / 2, w, h);
            g.restore();
          }
        }
        g.globalAlpha = 1;
      }
      // 文档（透视贴图）
      const warped = warpDoc(doc, dst, W, H);
      g.drawImage(warped, 0, 0);
      // 书脊阴影
      if (spine) {
        const sg = g.createLinearGradient(W * 0.42, 0, W * 0.58, 0);
        sg.addColorStop(0, 'rgba(0,0,0,0)');
        sg.addColorStop(0.5, 'rgba(0,0,0,0.45)');
        sg.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = sg;
        g.fillRect(W * 0.42, 0, W * 0.16, H);
      }
      // 方向性阴影（侧光）
      if (shadow) {
        const tg = g.createLinearGradient(0, 0, W, H);
        tg.addColorStop(0, 'rgba(0,0,0,0.02)');
        tg.addColorStop(1, shadow);
        g.globalCompositeOperation = 'multiply';
        g.fillStyle = tg;
        g.fillRect(0, 0, W, H);
        g.globalCompositeOperation = 'source-over';
      }
      // 手指遮挡
      if (occlude) {
        const [cx, cy, r] = occlude;
        g.fillStyle = '#c99b78';
        g.beginPath();
        g.ellipse(cx, cy, r, r * 1.35, 0.3, 0, Math.PI * 2);
        g.fill();
      }
      // 纸张卷曲：整幅图做正弦位移（书页/软纸常见）
      let out = scene;
      if (curl) {
        const srcMat = cv.imread(scene);
        const mapX = new cv.Mat(scene.height, scene.width, cv.CV_32FC1);
        const mapY = new cv.Mat(scene.height, scene.width, cv.CV_32FC1);
        for (let y = 0; y < scene.height; y++) {
          for (let x = 0; x < scene.width; x++) {
            const dx = curl * Math.sin((2 * Math.PI * y) / scene.height);
            const dy = curl * 0.5 * Math.sin((2 * Math.PI * x) / scene.width);
            mapX.floatPtr(y, x)[0] = x + dx;
            mapY.floatPtr(y, x)[0] = y + dy;
          }
        }
        const dstMat = new cv.Mat();
        cv.remap(srcMat, dstMat, mapX, mapY, cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
        out = mkCanvas(scene.width, scene.height);
        cv.imshow(out, dstMat);
        srcMat.delete();
        mapX.delete();
        mapY.delete();
        dstMat.delete();
      }
      // 失焦
      if (blur) {
        const m = cv.imread(out);
        const k = Math.max(3, Math.round(blur) | 1);
        cv.GaussianBlur(m, m, new cv.Size(k, k), 0, 0, cv.BORDER_DEFAULT);
        const c = mkCanvas(out.width, out.height);
        cv.imshow(c, m);
        m.delete();
        out = c;
      }
      // 传感器噪声（在最终的 out 上叠加，含模糊后的结果）
      if (noise) {
        const og = out.getContext('2d');
        const img = og.getImageData(0, 0, out.width, out.height);
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
          const n = (Math.random() - 0.5) * noise;
          d[i] = Math.max(0, Math.min(255, d[i] + n));
          d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
          d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
        }
        og.putImageData(img, 0, 0);
      }
      return out;
    };

    /** 按 app 的做法缩到长边 480 再检测（再可选 1200 精修，模拟 autoDetectPage） */
    const toSmall = (scene, edge = 480) => {
      const s = Math.min(1, edge / Math.max(scene.width, scene.height));
      const c = mkCanvas(Math.round(scene.width * s), Math.round(scene.height * s));
      c.getContext('2d').drawImage(scene, 0, 0, c.width, c.height);
      return c;
    };

    const polyArea = (q) => {
      let a = 0;
      for (let i = 0; i < q.length; i++) {
        const p = q[i];
        const r = q[(i + 1) % q.length];
        a += p.x * r.y - r.x * p.y;
      }
      return Math.abs(a) / 2;
    };
    /** 凸四边形近似 IoU（用栅格采样） */
    const quadIoU = (a, b) => {
      const inPoly = (q, x, y) => {
        let inside = false;
        for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
          const xi = q[i].x, yi = q[i].y, xj = q[j].x, yj = q[j].y;
          if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
      };
      let inter = 0, uni = 0;
      const N = 120;
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const px = (x + 0.5) / N, py = (y + 0.5) / N;
          const ia = inPoly(a, px, py), ib = inPoly(b, px, py);
          if (ia && ib) inter++;
          if (ia || ib) uni++;
        }
      }
      return uni ? inter / uni : 0;
    };

    const norm = (q, W, H) => q.map((p) => ({ x: p.x / W, y: p.y / H }));
    const fmt = (n) => Math.round(n * 1000) / 1000;
    const cornerErr = (a, b) => {
      // 逐点最近匹配（避免角点顺序差异）
      let sum = 0;
      for (const p of a) {
        let best = Infinity;
        for (const q of b) best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y));
        sum += best;
      }
      return sum / a.length;
    };

    const W = 1600, H = 1200;
    const scenes = [
      {
        name: '深色木桌 · 常规透视',
        doc: docCanvas(),
        dst: [{ x: 320, y: 120 }, { x: 1240, y: 170 }, { x: 1200, y: 1090 }, { x: 380, y: 1030 }],
        bg: ['#6b4a2f', '#3d2a1a'],
      },
      {
        name: '白桌 · 低对比度',
        doc: docCanvas(),
        dst: [{ x: 350, y: 140 }, { x: 1230, y: 160 }, { x: 1210, y: 1070 }, { x: 370, y: 1050 }],
        bg: ['#f4f2ef', '#e8e5e0'],
      },
      {
        name: '侧光强阴影',
        doc: docCanvas(),
        dst: [{ x: 300, y: 130 }, { x: 1260, y: 180 }, { x: 1220, y: 1080 }, { x: 340, y: 1020 }],
        bg: ['#8a8f96', '#4a4f56'],
        shadow: 'rgba(0,0,0,0.55)',
      },
      {
        name: '文档几乎充满画面',
        doc: docCanvas(),
        dst: [{ x: 30, y: 18 }, { x: 1570, y: 42 }, { x: 1548, y: 1182 }, { x: 46, y: 1158 }],
        bg: ['#5c4630', '#33241a'],
      },
      {
        name: '一角被手指遮挡',
        doc: docCanvas(),
        dst: [{ x: 320, y: 140 }, { x: 1250, y: 170 }, { x: 1210, y: 1080 }, { x: 380, y: 1040 }],
        bg: ['#6b4a2f', '#3d2a1a'],
        occlude: [1250, 170, 110],
      },
      {
        name: '文本密集页 · 轻微旋转',
        doc: docCanvas(),
        dst: [{ x: 420, y: 90 }, { x: 1290, y: 240 }, { x: 1150, y: 1140 }, { x: 300, y: 980 }],
        bg: ['#dfe3e8', '#b9c0c8'],
      },
      {
        name: '书本跨页 · 中心书脊阴影',
        doc: docCanvas(1700, 1200),
        dst: [{ x: 150, y: 150 }, { x: 1460, y: 150 }, { x: 1460, y: 1050 }, { x: 150, y: 1050 }],
        bg: ['#6b4a2f', '#3d2a1a'],
        spine: true,
      },
      {
        name: '深色纸张 · 低对比背景',
        doc: docCanvas(1200, 1600, true),
        dst: [{ x: 330, y: 130 }, { x: 1250, y: 160 }, { x: 1220, y: 1070 }, { x: 350, y: 1040 }],
        bg: ['#4a5560', '#2a323a'],
      },
      {
        name: '纸张卷曲（边非直线）',
        doc: docCanvas(),
        dst: [{ x: 330, y: 130 }, { x: 1250, y: 160 }, { x: 1220, y: 1070 }, { x: 350, y: 1040 }],
        bg: ['#6b4a2f', '#3d2a1a'],
        curl: 16,
      },
      {
        name: '杂乱桌面 · 多干扰矩形',
        doc: docCanvas(),
        dst: [{ x: 340, y: 140 }, { x: 1240, y: 180 }, { x: 1210, y: 1070 }, { x: 360, y: 1030 }],
        bg: ['#7a5f45', '#402c1c'],
        clutter: true,
      },
      {
        name: '文档占比小 · 远景',
        doc: docCanvas(),
        dst: [{ x: 620, y: 380 }, { x: 1010, y: 400 }, { x: 1000, y: 830 }, { x: 630, y: 810 }],
        bg: ['#6b4a2f', '#3d2a1a'],
      },
      {
        name: '失焦模糊 · 强噪声',
        doc: docCanvas(),
        dst: [{ x: 320, y: 130 }, { x: 1250, y: 165 }, { x: 1215, y: 1080 }, { x: 350, y: 1045 }],
        bg: ['#5c5040', '#2c2418'],
        blur: 7,
        noise: 26,
      },
      {
        name: '极低对比（白纸灰桌+均匀阴影）',
        doc: docCanvas(),
        dst: [{ x: 330, y: 140 }, { x: 1245, y: 165 }, { x: 1210, y: 1075 }, { x: 350, y: 1045 }],
        bg: ['#eeeeee', '#e2e2e2'],
        shadow: 'rgba(0,0,0,0.18)',
      },
    ];

    const rows = [];
    for (const sc of scenes) {
      const scene = buildScene({ W, H, ...sc });
      const small = toSmall(scene);
      let out = null;
      const t0 = performance.now();
      try {
        out = detectQuadInCanvas(cv, small);
        // 与 autoDetectPage 一致：识别成功后在 1200 长边上精修
        if (out && out.status === 'found') {
          const fine = toSmall(scene, 1200);
          const refined = refineQuadInCanvas(cv, fine, out.quad);
          if (refined) out.quad = refined;
        }
      } catch (e) {
        out = null;
      }
      const ms = Math.round(performance.now() - t0);
      const gt = norm(sc.dst, W, H);
      if (!out) {
        rows.push({ name: sc.name, err: 1, iou: 0, status: 'exception', ms });
        continue;
      }
      const err = cornerErr(out.quad, gt);
      const iou = quadIoU(out.quad, gt);
      rows.push({
        name: sc.name,
        err: fmt(err),
        iou: fmt(iou),
        status: out.status,
        ms,
        quad: out.quad.map((p) => [fmt(p.x), fmt(p.y)]),
      });
      // 场景图 + 真值框留档
      const dbg = mkCanvas(scene.width, scene.height);
      const dg = dbg.getContext('2d');
      dg.drawImage(scene, 0, 0);
      const draw = (q, color) => {
        dg.strokeStyle = color;
        dg.lineWidth = 6;
        dg.beginPath();
        q.forEach((p, i) => (i ? dg.lineTo(p.x * W, p.y * H) : dg.moveTo(p.x * W, p.y * H)));
        dg.closePath();
        dg.stroke();
      };
      draw(gt, '#00e676');
      draw(out.quad, '#ff5252');
      rows[rows.length - 1].png = dbg.toDataURL('image/png');
    }
    return rows;
  });

  // 汇总输出
  console.log('\n场景'.padEnd(28) + '四角误差'.padStart(10) + 'IoU'.padStart(8) + '状态'.padStart(10) + '耗时'.padStart(8));
  let pass = 0;
  result.forEach((r, i) => {
    const ok = r.err <= 0.03 && r.iou >= 0.9;
    if (ok) pass++;
    console.log(
      `${r.name.padEnd(28)}${String((r.err * 100).toFixed(1) + '%').padStart(10)}${String(r.iou).padStart(8)}${String(r.status).padStart(10)}${String(r.ms + 'ms').padStart(8)}  ${ok ? '✓' : '✗'}`,
    );
    if (r.png) {
      const b64 = r.png.split(',')[1];
      fs.writeFileSync(path.join(OUT, `${i + 1}-${r.name.replace(/[^\w\u4e00-\u9fa5]+/g, '_')}.png`), Buffer.from(b64, 'base64'));
    }
  });
  console.log(`\n通过 ${pass}/${result.length}（判定：四角平均误差 ≤3% 对角线 且 IoU ≥0.9）`);
  await browser.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('BENCH ERROR:', e);
  process.exit(1);
});
