/**
 * 图像导入：多格式解码（JPG/PNG/WebP/BMP/GIF 原生，HEIC 用 heic2any，TIFF 用 UTIF），
 * 并生成低清编辑预览与缩略图（导入时一次完成，交互全程使用低清保证流畅）。
 * 多页 TIFF 拆分为多帧（多页扫描件常见，逐帧建页）。
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

/** HEIC/HEIF → 单张 JPEG Blob（heic2any 动态加载，仅首次使用时下载） */
async function heicToJpegBlob(file: File): Promise<Blob> {
  const heic2any = (await import('heic2any')).default;
  const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.95 });
  return (Array.isArray(out) ? out[0] : out) as Blob;
}

/** UTIF 解码 TIFF → 逐帧 JPEG Blob（遍历全部 IFD，支持多页 TIFF） */
async function tiffToJpegBlobs(file: File): Promise<Blob[]> {
  const UTIF: any = await import('utif');
  const buf = await file.arrayBuffer();
  const ifds = UTIF.decode(buf);
  if (!ifds || ifds.length === 0) return [];
  const blobs: Blob[] = [];
  for (const ifd of ifds) {
    UTIF.decodeImage(buf, ifd, ifds);
    const rgba = UTIF.toRGBA8(ifd);
    const canvas = document.createElement('canvas');
    canvas.width = ifd.width;
    canvas.height = ifd.height;
    const ctx = canvas.getContext('2d')!;
    const imgData = ctx.createImageData(canvas.width, canvas.height);
    imgData.data.set(rgba);
    ctx.putImageData(imgData, 0, 0);
    blobs.push(await canvasToBlob(canvas, 'image/jpeg', 0.95));
  }
  return blobs;
}

/**
 * blob → 统一 DecodedImage：解码 → 生成预览/缩略图；
 * needsReencode=true 时把底图统一重编码为 JPEG（原生格式 strip EXIF/透明填白，
 * 与 HEIC/TIFF 分支保持一致管线）。
 */
async function blobToDecoded(blob: Blob, needsReencode: boolean): Promise<DecodedImage> {
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
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }

  const previewCanvas = bitmapToCanvas(source, 1600);
  const thumbCanvas = bitmapToCanvas(source, 320);
  const preview = canvasToDataURL(previewCanvas, 0.85);
  const thumb = canvasToDataURL(thumbCanvas, 0.8);
  (source as ImageBitmap).close?.();

  let finalBlob = blob;
  if (needsReencode) {
    const bitmap = await createImageBitmap(blob);
    const full = bitmapToCanvas(bitmap, 99999);
    finalBlob = await canvasToBlob(full, 'image/jpeg', 0.98);
    bitmap.close?.();
  }

  return { blob: finalBlob, width, height, preview, thumb };
}

/** 解码单个文件为单页结构（TIFF 仅取第一帧，供向后兼容与特殊场景） */
export async function decodeImageFile(file: File): Promise<DecodedImage> {
  let blob: Blob = file;
  let needsReencode = true;
  if (isHeic(file)) {
    blob = await heicToJpegBlob(file);
    needsReencode = false;
  } else if (isTiff(file)) {
    const blobs = await tiffToJpegBlobs(file);
    blob = blobs[0] ?? file;
    needsReencode = false;
  }
  return blobToDecoded(blob, needsReencode);
}

/** 解码文件为（可能多帧的）页面结构：多页 TIFF 逐帧拆页，其余单帧 */
export async function decodeImageFiles(file: File): Promise<DecodedImage[]> {
  if (isTiff(file)) {
    try {
      const blobs = await tiffToJpegBlobs(file);
      if (blobs.length > 0) {
        return Promise.all(blobs.map((b) => blobToDecoded(b, false)));
      }
    } catch (e) {
      console.warn('多页 TIFF 解码失败，回退单帧', e);
    }
  }
  return [await decodeImageFile(file)];
}