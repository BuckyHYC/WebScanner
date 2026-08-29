import type { Point } from '../types';
import { orderQuad } from './geometry';
import { createMatPool } from './opencvLoader';

/**
 * 在 RGBA Mat 中检测文档四边形轮廓。
 * 流程：灰度 → 高斯模糊 → Canny 边缘 → 膨胀连接 → 找最大凸四边形轮廓。
 * 返回归一化（0~1）四角 [左上,右上,右下,左下]，未找到返回 null。
 */
export function detectQuadInMat(cv: any, src: any): Point[] | null {
  const pool = createMatPool();
  const gray = pool.add(new cv.Mat());
  const blur = pool.add(new cv.Mat());
  const edges = pool.add(new cv.Mat());
  const contours = pool.add(new cv.MatVector());
  const hierarchy = pool.add(new cv.Mat());
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
    cv.Canny(blur, edges, 50, 150, 3, false);
    // 膨胀把断裂边缘连成闭合轮廓
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.dilate(edges, edges, kernel, new cv.Point(-1, -1), 2);
    kernel.delete();

    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const totalArea = src.cols * src.rows;
    let bestQuad: Point[] | null = null;
    let bestArea = totalArea * 0.12; // 面积至少占 12% 才认为是文档

    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      try {
        const ca = cv.contourArea(cnt, false);
        if (ca < bestArea) continue;
        const peri = cv.arcLength(cnt, true);
        const approx = new cv.Mat();
        // 多边形逼近，误差 = 周长 2%
        cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
        if (approx.rows === 4 && cv.isContourConvex(approx)) {
          const pts: Point[] = [];
          for (let j = 0; j < 4; j++) {
            pts.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
          }
          bestQuad = orderQuad(pts).map((p) => ({ x: p.x / src.cols, y: p.y / src.rows }));
          bestArea = ca;
        }
        approx.delete();
      } finally {
        cnt.delete();
      }
    }
    return bestQuad;
  } finally {
    pool.dispose();
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
  const src = pool.add(cv.matFromImageData(
    canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, canvas.width, canvas.height),
  ));
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
      const [x1, y1, x2, y2] = [
        lines.data32S[i * 4],
        lines.data32S[i * 4 + 1],
        lines.data32S[i * 4 + 2],
        lines.data32S[i * 4 + 3],
      ];
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
