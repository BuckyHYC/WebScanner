import type { Point } from '../types';

/** 两点距离 */
export function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * 四角点排序为 [左上, 右上, 右下, 左下]
 * 规则：x+y 最小为左上、最大为右下；x-y 最大为右上、最小为左下
 */
export function orderQuad(pts: Point[]): Point[] {
  const sorted = [...pts].sort((a, b) => a.x + a.y - (b.x + b.y));
  const tl = sorted[0];
  const br = sorted[sorted.length - 1];
  const rest = sorted.slice(1, -1);
  const [tr, bl] = rest.sort((a, b) => b.x - b.y - (a.x - a.y));
  return [tl, tr, br, bl];
}

/** 归一化四角 → 像素坐标展平数组 [x0,y0,x1,y1,...] */
export function quadToPixels(quad: Point[], w: number, h: number): number[] {
  const out: number[] = [];
  for (const p of quad) out.push(p.x * w, p.y * h);
  return out;
}

/** 由四边长度估计矫正后目标尺寸 */
export function targetSizeFromQuad(px: number[]): { w: number; h: number } {
  const p = (i: number) => ({ x: px[i * 2], y: px[i * 2 + 1] });
  const top = dist(p(0), p(1));
  const bottom = dist(p(3), p(2));
  const left = dist(p(0), p(3));
  const right = dist(p(1), p(2));
  return {
    w: Math.max(8, Math.round(Math.max(top, bottom))),
    h: Math.max(8, Math.round(Math.max(left, right))),
  };
}

/** 角点夹取到 [0,1] */
export function clampQuad(quad: Point[]): Point[] {
  return quad.map((p) => ({
    x: Math.min(1, Math.max(0, p.x)),
    y: Math.min(1, Math.max(0, p.y)),
  }));
}

/** 平均角点位移（用于摄像头稳定判定） */
export function quadShift(a: Point[], b: Point[]): number {
  let s = 0;
  for (let i = 0; i < 4; i++) s += dist(a[i], b[i]);
  return s / 4;
}
