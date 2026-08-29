import type { Point } from '../types';
import { orderQuad } from './geometry';
import { createMatPool } from './opencvLoader';

/**
 * 在 RGBA Mat 中检测文档四边形轮廓（多参数组合尝试，提高真实照片检出率）。
 * 每轮：灰度 → 高斯模糊 → Canny → 膨胀连接 → 按面积取前 12 个轮廓逐一
 * approxPolyDP 逼近，取第一个「凸四边形且面积 > 6%」的候选。
 * 返回归一化（0~1）四角 [左上,右上,右下,左下]，未找到返回 null。
 */
export function detectQuadInMat(cv: any, src: any): Point[] | null {
  const pool = createMatPool();
  const gray = pool.add(new cv.Mat());
  const blur = pool.add(new cv.Mat());
  const edges = pool.add(new cv.Mat());
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    // 多组 Canny 阈值：宽松 → 收敛，覆盖不同光照/对比度的照片
    const attempts = [
      { t1: 50, t2: 150, dil: 2, blur: 5 },
      { t1: 25, t2: 80, dil: 3, blur: 5 },
      { t1: 90, t2: 220, dil: 2, blur: 3 },
      { t1: 15, t2: 45, dil: 3, blur: 7 },
    ];
    for (const a of attempts) {
      cv.GaussianBlur(gray, blur, new cv.Size(a.blur, a.blur), 0, 0, cv.BORDER_DEFAULT);
      cv.Canny(blur, edges, a.t1, a.t2, 3, false);
      // 膨胀把断裂边缘连成闭合轮廓
      const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
      cv.dilate(edges, edges, kernel, new cv.Point(-1, -1), a.dil);
      kernel.delete();
      const quad = quadFromEdges(cv, edges, src.cols, src.rows);
      if (quad) return quad;
    }
    return null;
  } finally {
    pool.dispose();
  }
}

/** 从边缘图中找最大的合格凸四边形 */
function quadFromEdges(cv: any, edges: any, w: number, h: number): Point[] | null {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  try {
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    const total = w * h;
    // 收集大面积轮廓并按面积降序
    const idxs: Array<[number, number]> = [];
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt, false);
      cnt.delete();
      if (area > total * 0.06) idxs.push([i, area]);
    }
    idxs.sort((p, q) => q[1] - p[1]);
    for (const [i] of idxs.slice(0, 12)) {
      const cnt = contours.get(i);
      const peri = cv.arcLength(cnt, true);
      const approx = new cv.Mat();
      // 两种逼近精度：先贴合，失败再放宽
      cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
      if (!(approx.rows === 4 && cv.isContourConvex(approx))) {
        cv.approxPolyDP(cnt, approx, 0.04 * peri, true);
      }
      let quad: Point[] | null = null;
      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        const pts: Point[] = [];
        for (let j = 0; j < 4; j++) pts.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
        // 面积仍需达标（放宽逼近后可能缩小）
        const qa =
          Math.abs(
            (pts[0].x * (pts[1].y - pts[3].y) +
              pts[1].x * (pts[2].y - pts[0].y) +
              pts[2].x * (pts[3].y - pts[1].y) +
              pts[3].x * (pts[0].y - pts[2].y)) /
            2,
          );
        if (qa > total * 0.06) {
          quad = orderQuad(pts).map((p) => ({ x: p.x / w, y: p.y / h }));
        }
      }
      approx.delete();
      cnt.delete();
      if (quad) return quad;
    }
    return null;
  } finally {
    contours.delete();
    hierarchy.delete();
  }
}

/** 从 canvas 检测（内部转 Mat）。canvas 应为低清预览以保证速度 */
export function detectQuadInCanvas(cv: any, canvas: HTMLCanvasElement): Point[] | null {
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
