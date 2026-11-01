/**
 * PDF 导入：用 pdf.js 把每页渲染成位图 JPEG Blob，交给现有导入管线（预览/缩略图/边缘检测）。
 *
 * 要点：
 * - pdf.js 体积较大，动态 import + 独立 chunk（'pdf'），只有导入 PDF 时才下载；
 * - worker 用 Vite 的 `?url` 引入，dev/构建都能拿到正确 URL；
 * - cmaps / standard_fonts 由 scripts/copy-pdfjs.js 复制到 public/pdfjs/，
 *   否则非嵌入字体的中文 PDF 会渲染成空白；
 * - 页数上限保护（浏览器内存有限），超过时截断并提示。
 */
import { canvasToBlob } from './imageIO';

/** 每页渲染目标长边（≈200 DPI 的 A4），兼顾清晰度与内存 */
const TARGET_LONG_EDGE = 2200;
/** 单个 PDF 最多导入页数 */
export const MAX_PDF_PAGES = 100;

let pdfjsPromise: Promise<any> | null = null;

/** 懒加载 pdf.js 并配置 worker / 字体资源路径 */
async function loadPdfJs(): Promise<any> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const [pdfjs, worker] = await Promise.all([
        import('pdfjs-dist'),
        // worker 走 Vite 资源 URL（构建后带哈希），避免 pdf.js 自行拼接路径失败
        import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
      ]);
      pdfjs.GlobalWorkerOptions.workerSrc = (worker as { default: string }).default;
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}

export interface PdfRenderProgress {
  done: number;
  total: number;
}

/** PDF → 每页 JPEG Blob（按页序）。超过 MAX_PDF_PAGES 的页会被丢弃。 */
export async function pdfToJpegBlobs(
  file: File,
  onProgress?: (p: PdfRenderProgress) => void,
): Promise<{ blobs: Blob[]; total: number; truncated: boolean }> {
  const pdfjs = await loadPdfJs();
  const base = import.meta.env.BASE_URL;
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({
    data,
    // 非嵌入字体（如部分中文 PDF）需要这两项资源才能正确渲染
    cMapUrl: `${base}pdfjs/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}pdfjs/standard_fonts/`,
    isEvalSupported: false,
  }).promise;

  try {
    const total = doc.numPages as number;
    const count = Math.min(total, MAX_PDF_PAGES);
    const blobs: Blob[] = [];
    for (let n = 1; n <= count; n++) {
      const page = await doc.getPage(n);
      try {
        const raw = page.getViewport({ scale: 1 });
        const scale = Math.max(0.5, Math.min(4, TARGET_LONG_EDGE / Math.max(raw.width, raw.height)));
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(viewport.width));
        canvas.height = Math.max(1, Math.round(viewport.height));
        const ctx = canvas.getContext('2d')!;
        // PDF 背景透明：先铺白，避免导出成黑底
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        blobs.push(await canvasToBlob(canvas, 'image/jpeg', 0.92));
        canvas.width = 0;
        canvas.height = 0;
      } finally {
        page.cleanup?.();
      }
      onProgress?.({ done: n, total: count });
      // 让出主线程，保持进度提示可刷新
      await new Promise((r) => setTimeout(r, 0));
    }
    return { blobs, total, truncated: total > count };
  } finally {
    void doc.destroy?.();
  }
}
