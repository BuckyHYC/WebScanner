import { createMatPool } from './opencvLoader';

/** 存储用蒙版规范尺寸（最大边），控制 dataURL 体积 */
const MASK_STORE_MAX = 1024;

/** 加载 dataURL 图像 */
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图像加载失败'));
    img.src = src;
  });
}

/**
 * 把涂抹蒙版应用到画布：白色区域用 Telea 图像修复按周围内容智能填充。
 * Telea 输出中非蒙版区域保持原像素，因此可直接作为结果。
 * 蒙版为空/加载失败时返回原画布。
 */
export async function applyEraseMask(
  cv: any,
  srcCanvas: HTMLCanvasElement,
  maskDataUrl: string | null | undefined,
  outCanvas?: HTMLCanvasElement,
): Promise<HTMLCanvasElement> {
  if (!maskDataUrl) return srcCanvas;

  // 蒙版缩放到当前画布尺寸
  const img = await loadImage(maskDataUrl);
  if (!img.width || !img.height) return srcCanvas;
  const mc = document.createElement('canvas');
  mc.width = srcCanvas.width;
  mc.height = srcCanvas.height;
  mc.getContext('2d')!.drawImage(img, 0, 0, mc.width, mc.height);
  const maskData = mc.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, mc.width, mc.height).data;

  const pool = createMatPool();
  const srcRgba = pool.add(
    cv.matFromImageData(
      srcCanvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, srcCanvas.width, srcCanvas.height),
    ),
  );
  // inpaint 仅支持 3 通道：RGBA → BGR
  const srcMat = pool.add(new cv.Mat());
  cv.cvtColor(srcRgba, srcMat, cv.COLOR_RGBA2BGR);
  const maskMat = pool.add(new cv.Mat(mc.height, mc.width, cv.CV_8UC1));
  try {
    // 取 R 通道生成单通道蒙版（画过的位置 R 高）
    let hasMask = false;
    for (let i = 0, j = 0; i < maskData.length; i += 4, j++) {
      maskMat.data[j] = maskData[i];
      if (maskData[i] > 40) hasMask = true;
    }
    if (!hasMask) return srcCanvas;

    const bin = pool.add(new cv.Mat());
    cv.threshold(maskMat, bin, 100, 255, cv.THRESH_BINARY);
    // 轻度膨胀让修复覆盖涂抹边缘的抗锯齿像素
    const kern = pool.add(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5)));
    cv.dilate(bin, bin, kern, new cv.Point(-1, -1), 1);

    const dst = new cv.Mat();
    try {
      const algo = cv.INPAINT_TELEA ?? cv.INPAINT_NS;
      cv.inpaint(srcMat, bin, dst, 4, algo);
      // BGR → RGBA 输出
      const dstRgba = pool.add(new cv.Mat());
      cv.cvtColor(dst, dstRgba, cv.COLOR_BGR2RGBA);
      const out = outCanvas ?? document.createElement('canvas');
      cv.imshow(out, dstRgba);
      return out;
    } finally {
      dst.delete();
    }
  } finally {
    pool.dispose();
  }
}

/** 把逐笔蒙版按规范尺寸合成为累计蒙版 dataURL（用于存储与撤销重放） */
export async function composeMask(strokeUrls: string[], width: number, height: number): Promise<string | null> {
  if (strokeUrls.length === 0) return null;
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d')!;
  for (const url of strokeUrls) {
    const img = await loadImage(url);
    ctx.drawImage(img, 0, 0, width, height);
  }
  // 等比缩小到规范尺寸，减小存储体积
  const scale = Math.min(1, MASK_STORE_MAX / Math.max(width, height));
  if (scale < 1) {
    const small = document.createElement('canvas');
    small.width = Math.max(1, Math.round(width * scale));
    small.height = Math.max(1, Math.round(height * scale));
    small.getContext('2d')!.drawImage(c, 0, 0, small.width, small.height);
    return small.toDataURL('image/png');
  }
  return c.toDataURL('image/png');
}

/** 画一笔（圆形笔刷线段）到蒙版画布上下文。erase=true 用橡皮（挖掉蒙版） */
export function paintStroke(
  ctx: CanvasRenderingContext2D,
  from: { x: number; y: number },
  to: { x: number; y: number },
  size: number,
  color: string,
  erase = false,
) {
  ctx.save();
  if (erase) ctx.globalCompositeOperation = 'destination-out';
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  // 单点点击也留下圆点
  if (from.x === to.x && from.y === to.y) {
    ctx.beginPath();
    ctx.arc(to.x, to.y, size / 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
