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
function strategyEdges(cv: any, pool: ReturnType<typeof createMatPool>, src: any, W: number, H: number, out: Candidate[], edgesUnion: any) {
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
    const kernel = pool.add(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));
    cv.dilate(edges, edges, kernel, new cv.Point(-1, -1), a.dil);
    kernel.delete();
    // 并集：低阈值轮的弱边也保留，供支撑度评估与霍夫/兜底使用
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
      for (const eps of [0.02, 0.035, 0.05]) {
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
        for (const eps of [0.03, 0.05]) {
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
      cnt.delete();
      if (quad) {
        out.push({ quad: quad.map((p) => ({ x: p.x / W, y: p.y / H })), score: 0, straight: 0.7, source: 'edge' });
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

/** 角点吸附：把候选四边形的角点吸到附近最强的 Harris 角点（限 9% 画面范围内，用于遮挡角外推） */
function snapToCorners(quad: Point[], corners: Point[], W: number, H: number): Point[] {
  if (corners.length === 0) return quad;
  const px = toPx(quad, W, H);
  const radius = Math.min(W, H) * 0.09;
  const snapped = px.map((p) => {
    let best: Point | null = null;
    let bestD = radius;
    for (const c of corners) {
      const d = Math.hypot(c.x * W - p.x, c.y * H - p.y);
      if (d < bestD) { bestD = d; best = { x: c.x * W, y: c.y * H }; }
    }
    return best ?? p;
  });
  return toNorm(orderQuad(snapped), W, H);
}

/**
 * 主入口：多策略融合自动边缘检测。
 * 流程：阴影校正灰度 → 策略 A/B/C/D 并行出候选 → 加权评分 → 近似融合 →
 * Harris 角点吸附 → 全失败时三级兜底（分块边缘点 → 内缩参考框）。
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
    strategyEdges(cv, pool, src, W, H, candidates, edgesUnion);

    // 策略 B/C/D 与兜底都基于边缘并集
    strategySaliency(cv, pool, src, norm, W, H, candidates);
    strategyHough(cv, pool, edgesUnion, W, H, candidates);
    const harris = strategyCorners(cv, pool, norm, W, H);
    if (harris.quad) candidates.push({ quad: harris.quad, score: 0, straight: 0.5, source: 'corners' });

    // ===== 评分（全图框候选剔除：四角都贴着图像边缘的框没有信息量）=====
    const isFullFrame = (q: Point[]) =>
      q.every((p) => p.x < 0.025 || p.x > 0.975 || p.y < 0.025 || p.y > 0.975);
    for (const c of candidates) {
      if (isFullFrame(c.quad)) {
        c.score = 0;
        continue;
      }
      const base = scoreQuad(toPx(c.quad, W, H), W, H, c.straight);
      // 边缘支撑度：真实文档边必有边缘像素，抑制"无中生有"的候选；
      // 权重 0.7+0.3 避免低对比弱边场景被一票否决
      const support = edgeSupport(cv, edgesUnion, toPx(c.quad, W, H));
      c.score = base * (0.7 + 0.3 * support);
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
        const base = scoreQuad(orderQuad(unionQuad), W, H, 0.7);
        const support = edgeSupport(cv, edgesUnion, orderQuad(unionQuad));
        candidates.push({ quad: norm, score: base * (0.7 + 0.3 * support), straight: 0.7, source: 'merge' });
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
      const avgScore = scoreQuad(toPx(orderQuad(avg), W, H), W, H, best.straight);
      if (avgScore >= best.score) best = { ...best, quad: orderQuad(avg), score: avgScore };
    }

    // ===== Harris 角点吸附 =====
    let quad = snapToCorners(best.quad, harris.corners, W, H);
    // 吸附后保证有效
    if (polyArea(toPx(quad, W, H)) / (W * H) < 0.04) quad = best.quad;

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
