/**
 * 图像导入：多格式解码（JPG/PNG/WebP/BMP/GIF 原生，HEIC 用 heic2any，TIFF 用 UTIF），
 * 并生成低清编辑预览与缩略图（导入时一次完成，交互全程使用低清保证流畅）。
 */

function isHeic(file: File): boolean {
  return /hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
}

function isTiff(file: File): boolean {
  return /tiff?/i.test(file.type) || /\.tiff?$/i.test(file.name);
}

/** bitmap 绘制到限制最大边长的 canvas（先铺白底，避免透明区域变黑） */
function bitmapToCanvas(bitmap: ImageBitmap | HTMLImageElement, maxEdge: number): HTMLCanvasElement {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap as any, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function canvasToDataURL(canvas: HTMLCanvasElement, q: number): string {
  return canvas.toDataURL('image/jpeg', q);
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/jpeg', q = 0.92): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob 失败'))), type, q);
  });
}

export interface DecodedImage {
  blob: Blob;
  width: number;
  height: number;
  preview: string;
  thumb: string;
}

/** 解码任意支持的图片文件为统一结构（HEIC/TIFF 已转为 JPEG Blob） */
export async function decodeImageFile(file: File): Promise<DecodedImage> {
  let blob: Blob = file;

  if (isHeic(file)) {
    // HEIC/HEIF：动态加载解码器（约 1MB，仅首次使用时下载）
    const heic2any = (await import('heic2any')).default;
    const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.95 });
    blob = Array.isArray(out) ? out[0] : out;
  } else if (isTiff(file)) {
    blob = await tiffToJpeg(file);
  }

  let width = 0;
  let height = 0;
  let source: ImageBitmap | HTMLImageElement;
  try {
    const bitmap = await createImageBitmap(blob);
    width = bitmap.width;
    height = bitmap.height;
    source = bitmap;
  } catch {
    // 兜底：用 <img> 解码
    const img = new Image();
    const url = URL.createObjectURL(blob);
    try {
      img.src = url;
      await img.decode();
      width = img.naturalWidth;
      height = img.naturalHeight;
      source = img;
    } finally {
      // img 绘制完成后才能 revoke，延迟释放
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }

  const previewCanvas = bitmapToCanvas(source, 1600);
  const thumbCanvas = bitmapToCanvas(source, 320);
  const preview = canvasToDataURL(previewCanvas, 0.85);
  const thumb = canvasToDataURL(thumbCanvas, 0.8);
  (source as ImageBitmap).close?.();

  // 统一存为 JPEG Blob（HEIC/TIFF 已转换；原生格式重新编码以统一管线）
  if (blob === file && !isHeic(file) && !isTiff(file)) {
    const bitmap = await createImageBitmap(file);
    const full = bitmapToCanvas(bitmap, 99999);
    blob = await canvasToBlob(full, 'image/jpeg', 0.98);
    bitmap.close?.();
  }

  return { blob, width, height, preview, thumb };
}

/** UTIF 解码 TIFF → JPEG Blob */
async function tiffToJpeg(file: File): Promise<Blob> {
  const UTIF: any = await import('utif');
  const buf = await file.arrayBuffer();
  const ifds = UTIF.decode(buf);
  UTIF.decodeImage(buf, ifds[0], ifds);
  const rgba = UTIF.toRGBA8(ifds[0]);
  const canvas = document.createElement('canvas');
  canvas.width = ifds[0].width;
  canvas.height = ifds[0].height;
  const ctx = canvas.getContext('2d')!;
  const imgData = ctx.createImageData(canvas.width, canvas.height);
  imgData.data.set(rgba);
  ctx.putImageData(imgData, 0, 0);
  return canvasToBlob(canvas, 'image/jpeg', 0.95);
}

/** 根据导入文件生成 Page 对象的公共参数 */
export async function makePageBase(file: File, index: number) {
  const d = await decodeImageFile(file);
  return {
    name: `扫描_${String(index + 1).padStart(3, '0')}`,
    blob: d.blob,
    preview: d.preview,
    thumb: d.thumb,
    width: d.width,
    height: d.height,
  };
}
