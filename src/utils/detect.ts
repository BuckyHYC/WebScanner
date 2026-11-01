import type { Point } from '../types';
import { orderQuad } from './geometry';
import { createMatPool } from './opencvLoader';

/** 单个候选四边形 */
interface Candidate {
  quad: Point[];
  score: number;
  straight: number; // 边直线度先验（霍夫构造=1，轮廓≈0.7，角点拼合=0.5）
  source: string;
}

/** 检测结果：found=策略识别；fallback=兜底（分块边缘/内缩参考框） */
export interface DetectOutcome {
  quad: Point[];
  status: 'found' | 'fallback';
  confidence: number;
  elapsedMs: number;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** 鞋带公式多边形面积（绝对值） */
function polyArea(pts: Point[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/** 四个内角（度） */
function interiorAngles(pts: Point[]): number[] {
  const angles: number[] = [];
  for (let i = 0; i < 4; i++) {
    const prev = pts[(i + 3) % 4];
    const cur = pts[i];
    const next = pts[(i + 1) % 4];
    const v1 = { x: prev.x - cur.x, y: prev.y - cur.y };
    const v2 = { x: next.x - cur.x, y: next.y - cur.y };
    const dot = v1.x * v2.x + v1.y * v2.y;
    const mag = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y);
    if (mag < 1e-6) { angles.push(90); continue; }
    const c = Math.min(1, Math.max(-1, dot / mag));
    angles.push((Math.acos(c) * 180) / Math.PI);
  }
  return angles;
}

/**
 * 四边形评分：面积占比 + 长宽比（接近 A4/证件比例加分）+ 内角接近 90° + 边直线度。
 * 全部归一化到 0~1 加权求和。
 */
function scoreQuad(quad: Point[], W: number, H: number, straight: number): number {
  const area = polyArea(quad) / (W * H);
  const sArea = clamp01(area / 0.35); // 面积占比到 35% 即满分
  if (area < 0.04) return 0; // 面积过小直接 0 分

  const e = (p: Point, q: Point) => Math.hypot(p.x - q.x, p.y - q.y);
  const wTop = e(quad[0], quad[1]);
  const wBot = e(quad[3], quad[2]);
  const hL = e(quad[0], quad[3]);
  const hR = e(quad[1], quad[2]);
  const width = Math.max(wTop, wBot);
  const height = Math.max(hL, hR);
  const ratio = width / Math.max(1e-6, height);
  // A4 竖 0.71 / A4 横 1.41 / 证件 0.63~1.59 → 0.5~2.2 区间满分
  const sAspect = ratio >= 0.45 && ratio <= 2.3 ? 1 : clamp01(1 - (ratio < 0.45 ? 0.45 - ratio : ratio - 2.3) / 0.8);

  const angles = interiorAngles(quad);
  const dev = angles.reduce((s, a) => s + Math.abs(a - 90), 0) / 4;
  const sAngle = clamp01(1 - dev / 40); // 平均偏差 40° 归零

  return 0.38 * sArea + 0.24 * sAspect + 0.28 * sAngle + 0.1 * straight;
}

/** 归一化角点转像素 */
const toPx = (q: Point[], W: number, H: number) => q.map((p) => ({ x: p.x * W, y: p.y * H }));
/** 像素角点转归一化 */
const toNorm = (q: Point[], W: number, H: number) => q.map((p) => ({ x: p.x / W, y: p.y / H }));

/**
 * 边缘支撑度：候选四边形四条边沿线采样，统计边缘图上邻域内命中比例（0~1）。
 * 真实文档边必然伴随边缘像素；凭空拼合的四边形支撑度低。
 */
function edgeSupport(cv: any, edges: any, quadPx: Point[]): number {
  const W = edges.cols;
  const H = edges.rows;
  let hit = 0;
  let total = 0;
  for (let i = 0; i < 4; i++) {
    const a = quadPx[i];
    const b = quadPx[(i + 1) % 4];
    const steps = 16;
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const x = Math.round(a.x + (b.x - a.x) * t);
      const y = Math.round(a.y + (b.y - a.y) * t);
      if (x < 2 || y < 2 || x >= W - 2 || y >= H - 2) continue;
      total++;
      let found = false;
      for (let dy = -3; dy <= 3 && !found; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          if (edges.ucharPtr(Math.min(H - 1, Math.max(0, y + dy)), Math.min(W - 1, Math.max(0, x + dx)))[0] > 0) {
            found = true;
            break;
          }
        }
      }
      if (found) hit++;
    }
  }
  return total > 0 ? hit / total : 0;
}

/**
 * 候选「像一张纸」的后验评分（0~1），用于压掉「锁定正文块/背景亮矩形」这类错误候选：
 * 1) 边两侧的亮度阶跃方向：真实纸边是「纸（亮）→ 背景（暗）」，沿边法线的带内均值应显著
 *    大于带外均值；而文字块的边两侧都是纸（甚至外侧更亮），带符号差接近 0 或为负。
 * 2) 内部整体亮度：纸面通常偏亮（深色纸张场景此项低，只作次要项）。
 */
function pageScore(gray: any, quadPx: Point[], W: number, H: number): number {
  const gAt = (x: number, y: number) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= W || yi >= H) return -1;
    return gray.ucharPtr(yi, xi)[0];
  };
  const cxq = (quadPx[0].x + quadPx[1].x + quadPx[2].x + quadPx[3].x) / 4;
  const cyq = (quadPx[0].y + quadPx[1].y + quadPx[2].y + quadPx[3].y) / 4;

  let signed = 0;
  let counted = 0;
  for (let i = 0; i < 4; i++) {
    const a = quadPx[i];
    const b = quadPx[(i + 1) % 4];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 24) continue;
    const nx = -dy / len;
    const ny = dx / len;
    // 法线方向统一指向四边形内部（用质心判定，避免依赖顶点顺序/坐标系）
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const sign = nx * (cxq - mx) + ny * (cyq - my) >= 0 ? 1 : -1;
    for (let s = 2; s <= 18; s++) {
      const t = s / 20;
      const px = a.x + dx * t;
      const py = a.y + dy * t;
      let inn = 0;
      let innN = 0;
      let out = 0;
      let outN = 0;
      for (const d of [2, 3, 4, 5]) {
        const vi = gAt(px + nx * d * sign, py + ny * d * sign);
        if (vi >= 0) {
          inn += vi;
          innN++;
        }
        const vo = gAt(px - nx * d * sign, py - ny * d * sign);
        if (vo >= 0) {
          out += vo;
          outN++;
        }
      }
      if (innN && outN) {
        signed += inn / innN - out / outN;
        counted++;
      }
    }
  }
  const dContrast = counted ? signed / counted : 0;

  // 内部亮度（点内测试网格采样）
  const inPoly = (x: number, y: number) => {
    let inside = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const xi = quadPx[i].x;
      const yi = quadPx[i].y;
      const xj = quadPx[j].x;
      const yj = quadPx[j].y;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  let sum = 0;
  let n = 0;
  const step = Math.max(6, Math.round(Math.min(W, H) / 60));
  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      if (!inPoly(x, y)) continue;
      sum += gray.ucharPtr(y, x)[0];
      n++;
    }
  }
  const innerMean = n ? sum / n : 0;

  const sSigned = clamp01(0.5 + dContrast / 60);
  const sBright = clamp01((innerMean - 110) / 100);
  return 0.7 * sSigned + 0.3 * sBright;
}

/**
 * 阴影校正：形态学闭 + 高斯平滑估计背景光照层，灰度除法归一化。
 * 返回校正后的单通道灰度 Mat（已登记 pool）。
 */
function correctedGray(cv: any, pool: ReturnType<typeof createMatPool>, src: any): any {
  const gray = pool.add(new cv.Mat());
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  // 光照低频：再降采样到 ~192px 估计背景
  const scale = Math.min(1, 192 / gray.cols);
  const sw = Math.max(24, Math.round(gray.cols * scale));
  const sh = Math.max(24, Math.round(gray.rows * scale));
  const small = pool.add(new cv.Mat());
  cv.resize(gray, small, new cv.Size(sw, sh), 0, 0, cv.INTER_AREA);
  const kern = Math.max(15, Math.round(Math.min(sw, sh) / 4) | 1);
  const kernel = pool.add(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(kern, kern)));
  const closed = pool.add(new cv.Mat());
  cv.morphologyEx(small, closed, cv.MORPH_CLOSE, kernel);
  const bgSmall = pool.add(new cv.Mat());
  cv.GaussianBlur(closed, bgSmall, new cv.Size(0, 0), kern / 3, kern / 3, cv.BORDER_DEFAULT);
  const bg = pool.add(new cv.Mat());
  cv.resize(bgSmall, bg, new cv.Size(gray.cols, gray.rows), 0, 0, cv.INTER_LINEAR);
  // norm = gray * 255 / bg（除法饱和；闭操作保证 bg ≥ 灰度低频，比例 ≤ 255）
  const norm = pool.add(new cv.Mat());
  cv.divide(gray, bg, norm, 255, -1);
  return norm;
}

/**
 * 策略 A：传统边缘 + 轮廓（多组 Canny 阈值 + 膨胀 + 4 边凸多边形筛选）。
 * 注意：Canny 用【原始灰度】而非阴影校正后的灰度——校正会拉平纸/桌对比度，
 * 低对比场景的纸张边缘会消失；阴影校正是给显著性/角点策略用的。
 * 每组阈值最多贡献 2 个候选（面积降序）。
 */
function strategyEdges(
  cv: any,
  pool: ReturnType<typeof createMatPool>,
  src: any,
  W: number,
  H: number,
  out: Candidate[],
  edgesUnion: any,
  edgesRaw: any,
) {
  const total = W * H;
  const gray = pool.add(new cv.Mat());
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  const attempts = [
    { t1: 25, t2: 80, dil: 3 },
    { t1: 50, t2: 150, dil: 2 },
    { t1: 90, t2: 220, dil: 2 },
  ];
  const blur = pool.add(new cv.Mat());
  const edges = pool.add(new cv.Mat());
  for (const a of attempts) {
    cv.GaussianBlur(gray, blur, new cv.Size(3, 3), 0, 0, cv.BORDER_DEFAULT);
    cv.Canny(blur, edges, a.t1, a.t2, 3, false);
    // 未膨胀边缘并集：用于边缘支撑度评估与亚像素精修（膨胀会让边缘整体外扩 → 系统性偏置）
    cv.bitwise_or(edgesRaw, edges, edgesRaw);
    const kernel = pool.add(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));
    cv.dilate(edges, edges, kernel, new cv.Point(-1, -1), a.dil);
    kernel.delete();
    // 并集：低阈值轮的弱边也保留，供轮廓/霍夫/兜底使用
    cv.bitwise_or(edgesUnion, edges, edgesUnion);

    const contours = pool.add(new cv.MatVector());
    const hierarchy = pool.add(new cv.Mat());
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    const idxs: Array<[number, number]> = [];
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt, false);
      cnt.delete();
      if (area > total * 0.05) idxs.push([i, area]);
    }
    idxs.sort((p, q) => q[1] - p[1]);
    let pushed = 0;
    for (const [i] of idxs.slice(0, 8)) {
      if (pushed >= 2) break;
      const cnt = contours.get(i);
      const peri = cv.arcLength(cnt, true);
      let quad: Point[] | null = null;
      // 多档近似容差：圆角/缺角/轻微卷曲时，恰好 4 顶点的 eps 区间很窄，多试几档命中率显著提高
      for (const eps of [0.01, 0.02, 0.03, 0.035, 0.045, 0.06, 0.08]) {
        const approx = new cv.Mat();
        cv.approxPolyDP(cnt, approx, eps * peri, true);
        if (approx.rows === 4 && cv.isContourConvex(approx)) {
          const pts: Point[] = [];
          for (let j = 0; j < 4; j++) pts.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
          quad = orderQuad(pts);
        }
        approx.delete();
        if (quad) break;
      }
      if (!quad && pushed === 0 && i === idxs[0][0]) {
        // 最大轮廓非四边形（如手指遮挡导致边缘凹陷）：凸包填平凹陷再近似
        const hull = new cv.Mat();
        cv.convexHull(cnt, hull, false, true);
        const hullPeri = cv.arcLength(hull, true);
        for (const eps of [0.02, 0.03, 0.05, 0.08]) {
          const approx = new cv.Mat();
          cv.approxPolyDP(hull, approx, eps * hullPeri, true);
          if (approx.rows === 4 && cv.isContourConvex(approx)) {
            const pts: Point[] = [];
            for (let j = 0; j < 4; j++) pts.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
            quad = orderQuad(pts);
          }
          approx.delete();
          if (quad) break;
        }
        hull.delete();
      }
      if (!quad && pushed === 0) {
        // 圆角纸/曲面页：轮廓顶点数不是 4，但最小外接旋转矩形贴合良好时仍是最佳外框
        const cntArea = cv.contourArea(cnt, false);
        const rect = cv.minAreaRect(cnt);
        const rectArea = Math.abs(rect.size.width * rect.size.height);
        if (cntArea > 0 && rectArea > 0 && rectArea <= cntArea * 1.25) {
          const rp = cv.RotatedRect.points(rect);
          if (rp && rp.length === 4) {
            quad = orderQuad(rp.map((p: any) => ({ x: p.x, y: p.y })));
          }
        }
      }
      cnt.delete();
      if (quad) {
        const rounded = i === idxs[0][0] ? 0.8 : 0.7; // 旋转矩形外框的直线度先验略高
        out.push({ quad: quad.map((p) => ({ x: p.x / W, y: p.y / H })), score: 0, straight: rounded, source: 'edge' });
        pushed++;
      }
    }
    contours.delete();
    hierarchy.delete();
  }
}

/**
 * 策略 B：文档显著性（高亮 + 低饱和的矩形区域先验）。
 * 阴影校正后的灰度做 Otsu 阈值得到"亮区"，与低饱和掩码求与；
 * 开运算去噪、闭运算补洞后取最大轮廓。
 */
function strategySaliency(cv: any, pool: ReturnType<typeof createMatPool>, src: any, normGray: any, W: number, H: number, out: Candidate[]) {
  const total = W * H;
  // 亮区：Otsu 自适应阈值
  const bright = pool.add(new cv.Mat());
  cv.threshold(normGray, bright, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
  // 低饱和：HSV S 通道 < 90
  const rgb = pool.add(new cv.Mat());
  cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
  const hsv = pool.add(new cv.Mat());
  cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
  const chans = pool.add(new cv.MatVector());
  cv.split(hsv, chans);
  const sMask = pool.add(new cv.Mat());
  cv.threshold(chans.get(1), sMask, 90, 255, cv.THRESH_BINARY_INV);

  // 组合：亮 且 低饱和
  const mask = pool.add(new cv.Mat());
  cv.bitwise_and(bright, sMask, mask);
  if (cv.countNonZero(mask) < total * 0.06) {
    // 组合过严（如彩色文档在深色桌面上）：退化为仅亮区
    cv.bitwise_and(bright, bright, mask);
  }
  // 开运算去背景噪点；闭运算用大核桥接书脊/折缝——在 1/2 分辨率上做大核闭运算（等效且快）
  const kOpen = pool.add(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5)));
  cv.morphologyEx(mask, mask, cv.MORPH_OPEN, kOpen);
  kOpen.delete();
  const halfW = Math.max(32, Math.round(W / 2));
  const halfH = Math.max(32, Math.round(H / 2));
  const half = pool.add(new cv.Mat());
  cv.resize(mask, half, new cv.Size(halfW, halfH), 0, 0, cv.INTER_AREA);
  const kCloseSize = Math.max(11, Math.round(Math.min(halfW, halfH) / 8) | 1);
  const kClose = pool.add(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(kCloseSize, kCloseSize)));
  cv.morphologyEx(half, half, cv.MORPH_CLOSE, kClose);
  kClose.delete();
  cv.resize(half, mask, new cv.Size(W, H), 0, 0, cv.INTER_LINEAR);

  const contours = pool.add(new cv.MatVector());
  const hierarchy = pool.add(new cv.Mat());
  cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  const idxs: Array<[number, number]> = [];
  for (let i = 0; i < contours.size(); i++) {
    const cnt = contours.get(i);
    const area = cv.contourArea(cnt, false);
    cnt.delete();
    if (area > total * 0.08) idxs.push([i, area]);
  }
  idxs.sort((p, q) => q[1] - p[1]);
  for (const [i] of idxs.slice(0, 2)) {
    const cnt = contours.get(i);
    const peri = cv.arcLength(cnt, true);
    const approx = new cv.Mat();
    cv.approxPolyDP(cnt, approx, 0.03 * peri, true);
    if (approx.rows === 4 && cv.isContourConvex(approx)) {
      const pts: Point[] = [];
      for (let j = 0; j < 4; j++) pts.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
      out.push({ quad: orderQuad(pts).map((p) => ({ x: p.x / W, y: p.y / H })), score: 0, straight: 0.65, source: 'saliency' });
    }
    // 凸包候选：书本跨页/圆角纸等"亮区形状非凸"时，凸包外框常贴合整册外沿
    const hull = new cv.Mat();
    cv.convexHull(cnt, hull, false, true); // hull = 凸包点集
    const hullPeri = cv.arcLength(hull, true);
    const hullApprox = new cv.Mat();
    cv.approxPolyDP(hull, hullApprox, 0.04 * hullPeri, true);
    if (hullApprox.rows === 4 && cv.isContourConvex(hullApprox)) {
      const pts: Point[] = [];
      for (let j = 0; j < 4; j++) pts.push({ x: hullApprox.data32S[j * 2], y: hullApprox.data32S[j * 2 + 1] });
      out.push({ quad: orderQuad(pts).map((p) => ({ x: p.x / W, y: p.y / H })), score: 0, straight: 0.6, source: 'saliency-hull' });
    }
    hullApprox.delete();
    hull.delete();
    approx.delete();
    cnt.delete();
  }
  contours.delete();
  hierarchy.delete();
}

/**
 * 策略 C：霍夫直线辅助。取最长的横/竖各 2 条直线，4 个交点拼合四边形。
 */
function strategyHough(cv: any, pool: ReturnType<typeof createMatPool>, edges: any, W: number, H: number, out: Candidate[]) {
  const lines = pool.add(new cv.Mat());
  cv.HoughLinesP(edges, lines, 1, Math.PI / 180, 45, Math.min(W, H) * 0.3, 18);
  const horiz: Array<{ deg: number; len: number; x1: number; y1: number; x2: number; y2: number }> = [];
  const vert: Array<{ deg: number; len: number; x1: number; y1: number; x2: number; y2: number }> = [];
  for (let i = 0; i < lines.rows; i++) {
    const x1 = lines.data32S[i * 4];
    const y1 = lines.data32S[i * 4 + 1];
    const x2 = lines.data32S[i * 4 + 2];
    const y2 = lines.data32S[i * 4 + 3];
    const len = Math.hypot(x2 - x1, y2 - y1);
    let deg = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
    if (deg > 90) deg -= 180;
    if (deg < -90) deg += 180;
    if (Math.abs(deg) <= 30) horiz.push({ deg, len, x1, y1, x2, y2 });
    else if (Math.abs(deg) >= 60) vert.push({ deg, len, x1, y1, x2, y2 });
  }
  // 全局最长：横竖各取最长 2 条（4 交点拼合）
  horiz.sort((a, b) => b.len - a.len);
  vert.sort((a, b) => b.len - a.len);
  if (horiz.length < 2 || vert.length < 2) return;

  const inter = (l1: any, l2: any): Point | null => {
    const d = (l1.x2 - l1.x1) * (l2.y2 - l2.y1) - (l1.y2 - l1.y1) * (l2.x2 - l2.x1);
    if (Math.abs(d) < 1e-6) return null;
    const t = ((l2.x1 - l1.x1) * (l2.y2 - l2.y1) - (l2.y1 - l1.y1) * (l2.x2 - l2.x1)) / d;
    return { x: l1.x1 + t * (l1.x2 - l1.x1), y: l1.y1 + t * (l1.y2 - l1.y1) };
  };
  const pts: Point[] = [];
  for (const h of horiz.slice(0, 2)) {
    for (const v of vert.slice(0, 2)) {
      const p = inter(h, v);
      if (p) pts.push(p);
    }
  }
  if (pts.length !== 4) return;
  const quadPx = orderQuad(pts);
  // 交点必须在画面附近（避免平行线远端乱交）
  if (quadPx.some((p) => p.x < -W * 0.2 || p.x > W * 1.2 || p.y < -H * 0.2 || p.y > H * 1.2)) return;
  // 边缘支撑度门槛：交点拼合的四边形必须有真实边缘支撑才收录
  const support = edgeSupport(cv, edges, quadPx);
  if (support < 0.5) return;
  out.push({ quad: toNorm(quadPx, W, H), score: 0, straight: 1, source: 'hough' });
}

/**
 * 策略 D：Harris 角点兜底。四个象限内各找最强角点拼合四边形，
 * 同时返回角点列表供融合阶段做角点吸附。
 */
function strategyCorners(cv: any, pool: ReturnType<typeof createMatPool>, gray: any, W: number, H: number): { quad: Point[] | null; corners: Point[] } {
  const dst = pool.add(new cv.Mat());
  cv.cornerHarris(gray, dst, 2, 3, 0.04);
  // 归一化到 0~255 便于阈值
  const minmax = cv.minMaxLoc(dst);
  const maxV = minmax.maxVal || 1;
  const corners: Point[] = [];
  // 取响应前强的角点（阈值 0.35*max）
  const thresh = maxV * 0.35;
  const pts: Point[] = [];
  for (let y = 1; y < H - 1 && pts.length < 400; y++) {
    for (let x = 1; x < W - 1 && pts.length < 400; x++) {
      if (dst.floatPtr(y, x)[0] > thresh) pts.push({ x, y });
    }
  }
  if (pts.length === 0) return { quad: null, corners };

  // 四象限各找"最靠近外侧角"的角点
  const outer: Array<{ p: Point; o: Point }> = [
    { p: pts[0], o: { x: 0, y: 0 } },
    { p: pts[0], o: { x: W, y: 0 } },
    { p: pts[0], o: { x: W, y: H } },
    { p: pts[0], o: { x: 0, y: H } },
  ];
  const found: (Point | null)[] = [null, null, null, null];
  for (const p of pts) {
    const qx = p.x < W / 2 ? 0 : 1;
    const qy = p.y < H / 2 ? 0 : 1;
    const qi = qy * 2 + qx;
    const cur = found[qi];
    const dCur = cur ? Math.hypot(cur.x - outer[qi].o.x, cur.y - outer[qi].o.y) : Infinity;
    const dNew = Math.hypot(p.x - outer[qi].o.x, p.y - outer[qi].o.y);
    if (!cur || dNew < dCur) found[qi] = p;
  }
  if (found.every((p) => p !== null)) {
    const quad = orderQuad(found as Point[]);
    corners.push(...quad);
    return { quad: toNorm(quad, W, H), corners: toNorm(quad, W, H) };
  }
  return { quad: null, corners: [] };
}

/** 点到直线距离（直线以「过点 + 方向」表示），供拟合残差评估用 */
function pointToLineDist(px: number, py: number, x0: number, y0: number, vx: number, vy: number): number {
  return Math.abs((px - x0) * vy - (py - y0) * vx);
}

/** 梯度幅值（Sobel，双通道分开存；取幅值在 JS 里算，避免依赖 cv.magnitude 实现差异） */
function gradientMaps(cv: any, pool: ReturnType<typeof createMatPool>, src: any): { gray: any; gx: any; gy: any } {
  const gray = pool.add(new cv.Mat());
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  const blur = pool.add(new cv.Mat());
  cv.GaussianBlur(gray, blur, new cv.Size(3, 3), 0, 0, cv.BORDER_DEFAULT);
  const gx = pool.add(new cv.Mat());
  const gy = pool.add(new cv.Mat());
  cv.Sobel(blur, gx, cv.CV_32F, 1, 0, 3, 1, 0, cv.BORDER_DEFAULT);
  cv.Sobel(blur, gy, cv.CV_32F, 0, 1, 3, 1, 0, cv.BORDER_DEFAULT);
  return { gray, gx, gy };
}

/**
 * 单边亚像素拟合：沿边逐点取法向 ±R 的梯度幅值，先找峰值再用「峰值邻域内的梯度加权重心」
 * 定位真实边缘位置（对称权重，不会像「带内最近边缘像素」那样被膨胀/单侧纹理带偏），
 * 再对点集做 TLS 直线拟合。命中率或直线残差不过关返回 null 供调用方回退。
 */
function fitEdgeLineSubpixel(gx: any, gy: any, a: Point, b: Point, W: number, H: number) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 16) return null;
  const nx = -dy / len;
  const ny = dx / len;
  const R = 5; // 法向搜索半径（像素）
  const steps = Math.max(32, Math.min(480, Math.round(len)));
  const magAt = (x: number, y: number) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 1 || yi < 1 || xi >= W - 1 || yi >= H - 1) return -1;
    return Math.hypot(gx.floatPtr(yi, xi)[0], gy.floatPtr(yi, xi)[0]);
  };
  const pts: number[] = [];
  let attempted = 0;
  for (let s = 0; s <= steps; s++) {
    // 略外延（-0.08 ~ 1.08），让被裁角/圆角的边有向内延续
    const t = -0.08 + 1.16 * (s / steps);
    const px = a.x + dx * t;
    const py = a.y + dy * t;
    attempted++;
    let peak = 0;
    for (let d = -R; d <= R; d++) {
      const m = magAt(px + nx * d, py + ny * d);
      if (m > peak) peak = m;
    }
    if (peak < 10) continue; // 法向没有明显阶跃（纯纹理/空白）
    let wsum = 0;
    let dsum = 0;
    for (let d = -R; d <= R; d++) {
      const m = magAt(px + nx * d, py + ny * d);
      if (m <= 0) continue;
      const w = m - 0.35 * peak;
      if (w > 0) {
        wsum += w;
        dsum += w * d;
      }
    }
    if (wsum <= 0) continue;
    const d0 = dsum / wsum;
    pts.push(px + nx * d0, py + ny * d0);
  }
  // 命中率不足（文字纹理/弯曲边）：判为不可靠
  if (pts.length < 24 || pts.length / 2 < attempted * 0.45) return null;
  // 两轮稳健 TLS：第一轮拟合后剔除残差异常点（手指/阴影/圆角造成的离群点），再拟合
  let fit = tlsFit(pts);
  if (!fit) return null;
  for (let pass = 0; pass < 2; pass++) {
    const keep: number[] = [];
    let kept = 0;
    for (let i = 0; i < pts.length; i += 2) {
      const r = pointToLineDist(pts[i], pts[i + 1], fit!.x0, fit!.y0, fit!.vx, fit!.vy);
      if (r <= Math.max(1.5, fit!.err * 1.8)) {
        keep.push(pts[i], pts[i + 1]);
        kept++;
      }
    }
    if (kept < 16 || kept === pts.length / 2) break;
    const next = tlsFit(keep);
    if (!next) break;
    fit = next;
  }
  if (fit.err > 3) return null; // 亚像素精修要求直线性更严（弯曲边回退到粗拟合）
  return { x0: fit.x0, y0: fit.y0, vx: fit.vx, vy: fit.vy };
}

/** 点集（[x0,y0,x1,y1,...]）的 TLS 最小二乘直线拟合 + 平均残差 */
function tlsFit(pts: number[]): { x0: number; y0: number; vx: number; vy: number; err: number } | null {
  const n = pts.length / 2;
  if (n < 4) return null;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += pts[i * 2];
    cy += pts[i * 2 + 1];
  }
  cx /= n;
  cy /= n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const ddx = pts[i * 2] - cx;
    const ddy = pts[i * 2 + 1] - cy;
    sxx += ddx * ddx;
    sxy += ddx * ddy;
    syy += ddy * ddy;
  }
  const lam = (sxx + syy) / 2 + Math.sqrt(Math.pow((sxx - syy) / 2, 2) + sxy * sxy);
  let vx = sxy;
  let vy = lam - sxx;
  const vLen = Math.hypot(vx, vy) || 1;
  vx /= vLen;
  vy /= vLen;
  let err = 0;
  for (let i = 0; i < n; i++) err += pointToLineDist(pts[i * 2], pts[i * 2 + 1], cx, cy, vx, vy);
  return { x0: cx, y0: cy, vx, vy, err: err / n };
}

/** 回退用粗拟合：在（未膨胀）边缘图上找带内最近的边缘像素后 TLS 拟合 */
function fitEdgeLine(edges: any, a: Point, b: Point, W: number, H: number) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 10) return null;
  const nx = -dy / len;
  const ny = dx / len;
  const pts: number[] = [];
  const steps = Math.max(24, Math.round(len * 0.5));
  for (let s = 0; s <= steps; s++) {
    // 略外延（-0.18 ~ 1.18），捕捉被裁角向外的真实边缘延续
    const t = -0.18 + 1.36 * (s / steps);
    const px = Math.round(a.x + dx * t);
    const py = Math.round(a.y + dy * t);
    if (px < 0 || py < 0 || px >= W || py >= H) continue;
    let bx = px, by = py, bestD = Infinity, found = false;
    for (let d = -5; d <= 5; d++) {
      const sx = Math.round(px + nx * d);
      const sy = Math.round(py + ny * d);
      if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
      if (edges.ucharPtr(sy, sx)[0] > 0) {
        const dd = Math.abs(d);
        if (dd < bestD) { bestD = dd; bx = sx; by = sy; found = true; }
      }
    }
    if (found) pts.push(bx, by);
  }
  if (pts.length < Math.max(12, len * 0.12)) return null;
  const fit = tlsFit(pts);
  if (!fit || fit.err > 7) return null;
  return { x0: fit.x0, y0: fit.y0, vx: fit.vx, vy: fit.vy };
}

/** 两直线（过点 + 方向）交点；近平行返回 null */
function lineIntersect(
  l1: { x0: number; y0: number; vx: number; vy: number },
  l2: { x0: number; y0: number; vx: number; vy: number },
): Point | null {
  const d = l1.vx * l2.vy - l1.vy * l2.vx;
  if (Math.abs(d) < 1e-9) return null;
  const t = ((l2.x0 - l1.x0) * l2.vy - (l2.y0 - l1.y0) * l2.vx) / d;
  return { x: l1.x0 + l1.vx * t, y: l1.y0 + l1.vy * t };
}

/** 最近 Harris 角点（限 radius 半径内；找不到返回 null） */
function nearestHarris(q: Point, corners: Point[], W: number, H: number, radius: number): Point | null {
  if (corners.length === 0) return null;
  const px = q.x * W;
  const py = q.y * H;
  let best: Point | null = null;
  let bestD = radius;
  for (const c of corners) {
    const d = Math.hypot(c.x * W - px, c.y * H - py);
    if (d < bestD) {
      bestD = d;
      best = { x: c.x * W, y: c.y * H };
    }
  }
  return best;
}

/**
 * 角点外推精修：对候选四边形四条边做「亚像素梯度重心」定位 + TLS 直线拟合（不可靠时回退到
 * 边缘图带内拟合），用相邻两长边求交重建角点。相比「找最近 Harris 角点」，它能外推出被遮挡/
 * 圆角/强透视下真实存在、但局部没有强角点响应的角点；且对称的梯度权重不会像「最近边缘像素」
 * 那样把框整体外扩（膨胀核造成的系统性偏置）。每条边必须直线性可靠才采用；否则逐角回退到
 * 最近 Harris 角点 / 原角点。
 */
function extrapolateCorners(
  edges: any,
  gx: any,
  gy: any,
  quad: Point[],
  corners: Point[],
  W: number,
  H: number,
): Point[] {
  const lines: Array<{ x0: number; y0: number; vx: number; vy: number } | null> = [];
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const sub = gx && gy ? fitEdgeLineSubpixel(gx, gy, a, b, W, H) : null;
    lines.push(sub ?? (edges ? fitEdgeLine(edges, a, b, W, H) : null));
  }
  const maxMove = Math.min(W, H) * 0.22;
  const margin = Math.min(W, H) * 0.2;
  const inBounds = (p: Point) => p.x > -margin && p.x < W + margin && p.y > -margin && p.y < H + margin;
  const out: Point[] = [];
  for (let j = 0; j < 4; j++) {
    const lPrev = lines[(j + 3) % 4];
    const lNext = lines[j];
    let used = false;
    if (lPrev && lNext) {
      const p = lineIntersect(lPrev, lNext);
      if (p && inBounds(p)) {
        const dMove = Math.hypot(p.x - quad[j].x, p.y - quad[j].y);
        if (dMove <= maxMove) {
          out.push(p);
          used = true;
        }
      }
    }
    if (!used) {
      const n = nearestHarris(quad[j], corners, W, H, Math.min(W, H) * 0.09);
      out.push(n ?? quad[j]);
    }
  }
  return out;
}

/**
 * 主入口：多策略融合自动边缘检测。
 * 流程：阴影校正灰度 → 策略 A/B/C/D 并行出候选 → 加权评分 → 近似融合 →
 * 角点外推精修（邻边求交重建，带回退）→ 全失败时三级兜底（分块边缘点 → 内缩参考框）。
 */
export function detectQuadInMat(cv: any, src: any): DetectOutcome | null {
  const t0 = performance.now();
  const W = src.cols;
  const H = src.rows;
  const pool = createMatPool();
  try {
    // 阴影校正灰度（禁止未校正直接检测）
    const norm = correctedGray(cv, pool, src);

    const candidates: Candidate[] = [];
    // 三轮 Canny 的边缘并集（低阈值轮的弱边也保留）——Canny 用原始灰度保持对比度
    const edgesUnion = pool.add(new cv.Mat.zeros(H, W, cv.CV_8UC1));
    const edgesRaw = pool.add(new cv.Mat.zeros(H, W, cv.CV_8UC1));
    strategyEdges(cv, pool, src, W, H, candidates, edgesUnion, edgesRaw);

    // 亚像素边缘定位用的梯度图（未平滑到失真；3x3 高斯后 Sobel）
    const { gray, gx, gy } = gradientMaps(cv, pool, src);

    // 策略 B/C/D 与兜底都基于边缘并集
    strategySaliency(cv, pool, src, norm, W, H, candidates);
    strategyHough(cv, pool, edgesUnion, W, H, candidates);
    const harris = strategyCorners(cv, pool, norm, W, H);
    if (harris.quad) candidates.push({ quad: harris.quad, score: 0, straight: 0.5, source: 'corners' });

    // ===== 评分 =====
    // base：几何先验（面积/长宽比/直角/直线度）
    // support：未膨胀边缘上的覆盖率（抑制"无中生有"）
    // page：像不像一张纸（边内外亮度阶跃方向 + 内部亮度），压掉"锁定正文块/背景亮矩形"
    const isFullFrame = (q: Point[]) =>
      q.every((p) => p.x < 0.025 || p.x > 0.975 || p.y < 0.025 || p.y > 0.975);
    const scoreOf = (q: Point[], straight: number) => {
      const px = toPx(q, W, H);
      const base = scoreQuad(px, W, H, straight);
      if (base <= 0) return 0;
      const support = edgeSupport(cv, edgesRaw, px);
      const page = pageScore(gray, px, W, H);
      return base * (0.7 + 0.3 * support) * (0.55 + 0.45 * page);
    };
    for (const c of candidates) {
      // 全图框仍是弱先验（画面里没有可辨的纸边），但不直接判 0：留一点分参与排序
      c.score = scoreOf(c.quad, c.straight) * (isFullFrame(c.quad) ? 0.6 : 1);
    }
    candidates.sort((a, b) => b.score - a.score);

    // ===== 相邻候选合并：多个矩形页（书本跨页/拼页）距离近时取并集外框 =====
    if (candidates.length >= 2 && candidates[0].score > 0.5 && candidates[1].score > 0.5) {
      const bboxOf = (q: Point[]) => {
        const xs = q.map((p) => p.x * W);
        const ys = q.map((p) => p.y * H);
        return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
      };
      const b0 = bboxOf(candidates[0].quad);
      const b1 = bboxOf(candidates[1].quad);
      const gapX = Math.max(b0.x0, b1.x0) - Math.min(b0.x1, b1.x1);
      const gapY = Math.max(b0.y0, b1.y0) - Math.min(b0.y1, b1.y1);
      const overlapX = Math.min(b0.x1, b1.x1) - Math.max(b0.x0, b1.x0);
      const overlapY = Math.min(b0.y1, b1.y1) - Math.max(b0.y0, b1.y0);
      // 仅处理"水平相邻不重叠"或"垂直相邻不重叠"的两块（同一张页面的重复候选会重叠，跳过）
      const nearGap = Math.min(W, H) * 0.1;
      const sideBySide = overlapX <= 0 && Math.abs(gapX) < nearGap && Math.min(overlapY, 0) > -Math.min(W, H) * 0.5;
      const stacked = overlapY <= 0 && Math.abs(gapY) < nearGap && Math.min(overlapX, 0) > -Math.min(W, H) * 0.5;
      if (sideBySide || stacked) {
        const x0 = Math.min(b0.x0, b1.x0);
        const y0 = Math.min(b0.y0, b1.y0);
        const x1 = Math.max(b0.x1, b1.x1);
        const y1 = Math.max(b0.y1, b1.y1);
        const inset = Math.min(W, H) * 0.02;
        const unionQuad: Point[] = [
          { x: x0 + inset, y: y0 + inset },
          { x: x1 - inset, y: y0 + inset },
          { x: x1 - inset, y: y1 - inset },
          { x: x0 + inset, y: y1 - inset },
        ];
        const norm = toNorm(orderQuad(unionQuad), W, H);
        candidates.push({ quad: norm, score: scoreOf(norm, 0.7), straight: 0.7, source: 'merge' });
        candidates.sort((a, b) => b.score - a.score);
      }
    }

    if (candidates.length === 0 || candidates[0].score < 0.3) {
      // ===== 兜底：分块边缘点拼合 =====
      const fb = blockEdgeQuad(cv, edgesUnion, W, H);
      if (fb) {
        return { quad: fb, status: 'fallback', confidence: 0, elapsedMs: Math.round(performance.now() - t0) };
      }
      // ===== 兜底：内缩 4% 参考框 =====
      return {
        quad: [
          { x: 0.04, y: 0.04 },
          { x: 0.96, y: 0.04 },
          { x: 0.96, y: 0.96 },
          { x: 0.04, y: 0.96 },
        ],
        status: 'fallback',
        confidence: 0,
        elapsedMs: Math.round(performance.now() - t0),
      };
    }

    // ===== 融合：分数接近的两个候选取平均 =====
    let best = candidates[0];
    if (candidates.length > 1 && best.score - candidates[1].score < 0.05) {
      const second = candidates[1];
      const avg = best.quad.map((p, i) => ({ x: (p.x + second.quad[i].x) / 2, y: (p.y + second.quad[i].y) / 2 }));
      const avgQuad = orderQuad(avg);
      const avgScore = scoreOf(avgQuad, best.straight);
      if (avgScore >= best.score) best = { ...best, quad: avgQuad, score: avgScore };
    }

    // ===== 角点外推精修：亚像素梯度重心拟合四条边 → 相邻两边求交重建角点，
    //       不可靠的边逐角回退到最近 Harris 角点 / 原角点 =====
    const refinedPx = extrapolateCorners(edgesRaw, gx, gy, toPx(best.quad, W, H), harris.corners, W, H);
    let quad = toNorm(orderQuad(refinedPx), W, H);
    // 精修后保证有效（面积过小或相对候选剧变则回退，防止噪声把框算飞）
    const areaAfter = polyArea(toPx(quad, W, H));
    const areaBefore = polyArea(toPx(best.quad, W, H));
    if (areaAfter / (W * H) < 0.04 || areaAfter < areaBefore * 0.75 || areaAfter > areaBefore * 1.35) {
      quad = best.quad;
    }

    return { quad, status: 'found', confidence: +best.score.toFixed(3), elapsedMs: Math.round(performance.now() - t0) };
  } finally {
    pool.dispose();
  }
}

/** 兜底：四象限内找最近的边缘点拼合四边形 */
function blockEdgeQuad(cv: any, edges: any, W: number, H: number): Point[] | null {
  const corners: Array<{ x: number; y: number }> = [
    { x: 0, y: 0 },
    { x: W - 1, y: 0 },
    { x: W - 1, y: H - 1 },
    { x: 0, y: H - 1 },
  ];
  const pts: Point[] = [];
  for (const oc of corners) {
    const qx = oc.x === 0 ? [0, W / 2] : [W / 2, W];
    const qy = oc.y === 0 ? [0, H / 2] : [H / 2, H];
    let best: Point | null = null;
    let bestD = Infinity;
    for (let y = qy[0]; y < qy[1]; y += 2) {
      const row = edges.ucharPtr(y, 0);
      for (let x = qx[0]; x < qx[1]; x += 2) {
        if (row[x] > 0) {
          const d = Math.hypot(x - oc.x, y - oc.y);
          if (d < bestD) { bestD = d; best = { x, y }; }
        }
      }
    }
    if (!best) return null;
    pts.push(best);
  }
  const quad = orderQuad(pts);
  if (polyArea(quad) / (W * H) < 0.15) return null;
  return toNorm(quad, W, H);
}

/** 从 canvas 检测（内部转 Mat）。canvas 应为低清预览以保证速度 */
export function detectQuadInCanvas(cv: any, canvas: HTMLCanvasElement): DetectOutcome | null {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const src = cv.matFromImageData(ctx.getImageData(0, 0, canvas.width, canvas.height));
  try {
    return detectQuadInMat(cv, src);
  } finally {
    src.delete();
  }
}

/**
 * 多尺度精修：在更高分辨率的画布上，对给定四边形重做「亚像素梯度重心拟合 + 邻边求交」。
 * 低分辨率（480）定位 + 高分辨率精修，可消除角点量化误差（文档占画面比例越小时越明显）。
 * 面积突变或角点位移过大（拟合不可靠）时返回 null，调用方沿用原四边形。
 */
export function refineQuadInCanvas(cv: any, canvas: HTMLCanvasElement, quad: Point[]): Point[] | null {
  const W = canvas.width;
  const H = canvas.height;
  if (W < 96 || H < 96) return null;
  const pool = createMatPool();
  try {
    const src = pool.add(
      cv.matFromImageData(canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, W, H)),
    );
    const { gx, gy } = gradientMaps(cv, pool, src);
    const quadPx = toPx(quad, W, H);
    const refined = extrapolateCorners(null, gx, gy, quadPx, [], W, H);
    const before = polyArea(quadPx);
    const after = polyArea(refined);
    if (!(before > 0) || !(after > 0)) return null;
    // 面积变化 >15% 视为拟合跑偏
    if (after < before * 0.85 || after > before * 1.15) return null;
    const diag = Math.hypot(W, H);
    for (let i = 0; i < 4; i++) {
      if (Math.hypot(refined[i].x - quadPx[i].x, refined[i].y - quadPx[i].y) > diag * 0.03) return null;
    }
    return toNorm(orderQuad(refined), W, H);
  } catch {
    return null;
  } finally {
    pool.dispose();
  }
}

/**
 * 检测文本行/边缘的倾斜角（用于自动摆正 Deskew）。
 * HoughLinesP 取长直线角度的中位数，限制 ±12°。
 */
export function detectSkewInCanvas(cv: any, canvas: HTMLCanvasElement): number {
  const pool = createMatPool();
  const src = pool.add(
    cv.matFromImageData(canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, canvas.width, canvas.height)),
  );
  const gray = pool.add(new cv.Mat());
  const edges = pool.add(new cv.Mat());
  const lines = pool.add(new cv.Mat());
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.Canny(gray, edges, 50, 150, 3, false);
    const minLen = Math.min(src.cols, src.rows) * 0.35;
    cv.HoughLinesP(edges, lines, 1, Math.PI / 180, 60, minLen, 25);
    const angles: number[] = [];
    for (let i = 0; i < lines.rows; i++) {
      const x1 = lines.data32S[i * 4];
      const y1 = lines.data32S[i * 4 + 1];
      const x2 = lines.data32S[i * 4 + 2];
      const y2 = lines.data32S[i * 4 + 3];
      let deg = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
      if (deg > 90) deg -= 180;
      if (deg < -90) deg += 180;
      if (Math.abs(deg) <= 12) angles.push(deg);
    }
    if (angles.length === 0) return 0;
    angles.sort((a, b) => a - b);
    return angles[Math.floor(angles.length / 2)]; // 中位数
  } finally {
    pool.dispose();
  }
}
