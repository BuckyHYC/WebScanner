import type { FilterState, Page, Point } from '../types';
import { fullQuad } from '../store/useStore';
import { loadOpenCV } from './opencvLoader';
import { detectQuadInCanvas } from './detect';
import { targetSizeFromQuad, quadToPixels } from './geometry';
import { enhanceMat, isFilterActive } from './enhance';

/** 旋转后画布尺寸 */
export function rotatedDims(w: number, h: number, rotation: number): { w: number; h: number } {
  return rotation % 180 === 90 ? { w: h, h: w } : { w, h };
}

/** 阶段 1：把页面 Blob 解码并应用 90° 旋转 / 镜像，输出 canvas（可限制最大边长） */
export async function bitmapToRotatedCanvas(page: Page, maxEdge?: number): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(page.blob);
  const rot = rotatedDims(bitmap.width, bitmap.height, page.rotation);
  const scale = maxEdge ? Math.min(1, maxEdge / Math.max(rot.w, rot.h)) : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(rot.w * scale));
  canvas.height = Math.max(1, Math.round(rot.h * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.scale(page.flipH ? -scale : scale, page.flipV ? -scale : scale);
  ctx.rotate((page.rotation * Math.PI) / 180);
  ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
  ctx.restore();
  bitmap.close?.();
  return canvas;
}

/** canvas → Mat（RGBA） */
export function canvasToMat(cv: any, canvas: HTMLCanvasElement): any {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  return cv.matFromImageData(ctx.getImageData(0, 0, canvas.width, canvas.height));
}

/** Mat → canvas（cv.imshow 直接绘制并重设画布尺寸） */
export function matToCanvas(cv: any, mat: any, canvas?: HTMLCanvasElement): HTMLCanvasElement {
  const out = canvas ?? document.createElement('canvas');
  cv.imshow(out, mat);
  return out;
}

/**
 * 几何阶段：旋转镜像 → 透视矫正 → 微调旋转 → 多边形裁剪（不含滤镜）
 * @param maxEdge 结果最大边长（预览传小值提速，导出传大值保清晰）
 */
export async function renderGeometry(page: Page, maxEdge: number): Promise<HTMLCanvasElement> {
  const cv = await loadOpenCV();
  // 旋转镜像（按 maxEdge 预缩放；角点为归一化坐标，缩放后仍然有效）
  const rotated = await bitmapToRotatedCanvas(page, Math.round(maxEdge * 1.05));
  const quadPx = quadToPixels(page.corners, rotated.width, rotated.height);
  const size = targetSizeFromQuad(quadPx);
  // 目标尺寸同时受 maxEdge 约束
  const overScale = Math.max(size.w, size.h) / maxEdge;
  let W = size.w;
  let H = size.h;
  if (overScale > 1) {
    W = Math.round(W / overScale);
    H = Math.round(H / overScale);
  }

  try {
    const src = canvasToMat(cv, rotated);
    try {
      // ===== 透视变换：任意四边形拉正为 W×H 矩形 =====
      const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, quadPx);
      const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, W, 0, W, H, 0, H]);
      const M = cv.getPerspectiveTransform(srcTri, dstTri);
      let mat = new cv.Mat();
      cv.warpPerspective(src, mat, M, new cv.Size(W, H), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));
      srcTri.delete();
      dstTri.delete();
      M.delete();

      // ===== 自由微调旋转（扩展画布避免裁掉角）=====
      if (page.fineRotate !== 0) {
        const rad = (page.fineRotate * Math.PI) / 180;
        const cos = Math.abs(Math.cos(rad));
        const sin = Math.abs(Math.sin(rad));
        const W2 = Math.round(W * cos + H * sin);
        const H2 = Math.round(W * sin + H * cos);
        const center = new cv.Point(W / 2, H / 2);
        const R = cv.getRotationMatrix2D(center, page.fineRotate, 1);
        // 平移补偿，使旋转后内容居中
        R.data64F[2] += (W2 - W) / 2;
        R.data64F[5] += (H2 - H) / 2;
        const rotatedMat = new cv.Mat();
        cv.warpAffine(mat, rotatedMat, R, new cv.Size(W2, H2), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));
        R.delete();
        mat.delete();
        mat = rotatedMat;
      }

      // ===== 不规则多边形裁剪：多边形外涂白 =====
      if (page.polygon && page.polygon.length >= 3) {
        const mask = cv.Mat.zeros(mat.rows, mat.cols, cv.CV_8UC1);
        const flat: number[] = [];
        for (const p of page.polygon) flat.push(Math.round(p.x * mat.cols), Math.round(p.y * mat.rows));
        const contour = cv.matFromArray(page.polygon.length, 1, cv.CV_32SC2, flat);
        const matVec = new cv.MatVector();
        matVec.push_back(contour);
        cv.fillPoly(mask, matVec, new cv.Scalar(255, 0, 0, 0));
        // 多边形外涂白（与白底一致，避免导出黑边）
        const white = new cv.Mat();
        cv.cvtColor(mask, white, cv.COLOR_GRAY2RGBA);
        const outside = new cv.Mat();
        cv.bitwise_not(white, outside);
        cv.bitwise_or(mat, outside, mat);
        mask.delete();
        matVec.delete();
        contour.delete();
        white.delete();
        outside.delete();
      }

      return matToCanvas(cv, mat);
    } finally {
      src.delete();
    }
  } finally {
    rotated.width = 0;
    rotated.height = 0;
  }
}

/** 滤镜阶段：对几何结果应用增强管线 */
export async function applyFilterToCanvas(srcCanvas: HTMLCanvasElement, f: FilterState): Promise<HTMLCanvasElement> {
  const cv = await loadOpenCV();
  const src = canvasToMat(cv, srcCanvas);
  try {
    const out = isFilterActive(f) ? enhanceMat(cv, src, f) : src.clone();
    const canvas = matToCanvas(cv, out);
    out.delete();
    return canvas;
  } finally {
    src.delete();
  }
}

/** 完整渲染一页：几何 + 滤镜 */
export async function renderFinal(page: Page, maxEdge: number, reuseCanvas?: HTMLCanvasElement): Promise<HTMLCanvasElement> {
  const geo = await renderGeometry(page, maxEdge);
  try {
    if (!isFilterActive(page.filter)) return geo;
    const out = await applyFilterToCanvas(geo, page.filter);
    // 把结果画进复用画布
    if (reuseCanvas) {
      reuseCanvas.width = out.width;
      reuseCanvas.height = out.height;
      reuseCanvas.getContext('2d')!.drawImage(out, 0, 0);
      return reuseCanvas;
    }
    return out;
  } finally {
    geo.width = 0;
    geo.height = 0;
  }
}

/** 对一页执行自动边缘检测并更新角点（在低清预览上检测，保证速度） */
export async function autoDetectPage(page: Page): Promise<Point[] | null> {
  const cv = await loadOpenCV();
  const img = new Image();
  img.src = page.preview;
  await img.decode();
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 480 / Math.max(img.width, img.height));
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  canvas.getContext('2d', { willReadFrequently: true })!.drawImage(img, 0, 0, canvas.width, canvas.height);
  const quad = detectQuadInCanvas(cv, canvas);
  return quad ?? fullQuad();
}
