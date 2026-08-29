import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import type { ExportOptions, Page, Quality } from '../types';
import { renderFinal } from './render';

/** 质量档 → 渲染最大边长 */
export function maxEdgeByQuality(q: Quality): number {
  return q === 'high' ? 6000 : q === 'mid' ? 2400 : 1600;
}

/** 质量档 → JPEG 压缩率 */
function qualityToJpeg(q: Quality): number {
  return q === 'high' ? 0.92 : q === 'mid' ? 0.8 : 0.6;
}

/** 触发浏览器下载 */
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

/** 页面 → JPEG Blob（导出用全分辨率） */
export async function renderPageJpeg(page: Page, opts: ExportOptions): Promise<Blob> {
  const canvas = await renderFinal(page, maxEdgeByQuality(opts.quality));
  const q = opts.format === 'jpg' ? opts.jpgQuality / 100 : qualityToJpeg(opts.quality);
  return canvasToBlob(canvas, 'image/jpeg', q);
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, q: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas 编码失败'))), type, q);
  });
}

/** 序号文件名：prefix_001.jpg */
export function pageFileName(prefix: string, index: number): string {
  return `${prefix}_${String(index + 1).padStart(3, '0')}.jpg`;
}

/**
 * 导出 PDF：每页渲染为 JPEG 后嵌入。
 * 尺寸策略：a4=适配 A4 居中；fit=按原始像素尺寸（随质量档 DPI）；fitWidth=统一宽度。
 */
export async function exportPdf(
  pages: Page[],
  opts: ExportOptions,
  onProgress?: (done: number, total: number) => void,
): Promise<Blob> {
  const doc = await PDFDocument.create();
  if (opts.title) doc.setTitle(opts.title);
  if (opts.author) doc.setAuthor(opts.author);
  doc.setProducer('Web Scanner');
  doc.setCreationDate(new Date());

  const A4 = { w: 595.28, h: 841.89 };
  const dpi = opts.quality === 'high' ? 300 : opts.quality === 'mid' ? 200 : 150;

  for (let i = 0; i < pages.length; i++) {
    const jpeg = await renderPageJpeg(pages[i], opts);
    const bytes = await jpeg.arrayBuffer();
    const img = await doc.embedJpg(bytes);
    const px = img.scale(1);

    if (opts.pdfSize === 'a4') {
      // A4 内等比缩放并居中
      const margin = 0;
      const scale = Math.min((A4.w - margin * 2) / px.width, (A4.h - margin * 2) / px.height);
      const w = px.width * scale;
      const h = px.height * scale;
      const page = doc.addPage([A4.w, A4.h]);
      page.drawImage(img, { x: (A4.w - w) / 2, y: (A4.h - h) / 2, width: w, height: h });
    } else if (opts.pdfSize === 'fitWidth') {
      // 统一宽度 595pt，高度按比例
      const scale = A4.w / px.width;
      const page = doc.addPage([A4.w, px.height * scale]);
      page.drawImage(img, { x: 0, y: 0, width: A4.w, height: px.height * scale });
    } else {
      // 原始尺寸：px → pt（按质量档对应的 DPI）
      const w = (px.width * 72) / dpi;
      const h = (px.height * 72) / dpi;
      const page = doc.addPage([w, h]);
      page.drawImage(img, { x: 0, y: 0, width: w, height: h });
    }
    onProgress?.(i + 1, pages.length);
  }

  const bytes = await doc.save();
  return new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
}

/** 批量导出 JPG 并打包 ZIP */
export async function exportJpgZip(
  pages: Page[],
  opts: ExportOptions,
  onProgress?: (done: number, total: number) => void,
): Promise<Blob> {
  const zip = new JSZip();
  const folder = zip.folder(opts.prefix || 'scan') ?? zip;
  for (let i = 0; i < pages.length; i++) {
    const jpeg = await renderPageJpeg(pages[i], opts);
    folder.file(pageFileName(opts.prefix, i), jpeg);
    onProgress?.(i + 1, pages.length);
  }
  return zip.generateAsync({ type: 'blob', compression: 'STORE' });
}

/** 单张 JPG 导出 */
export async function exportSingleJpg(page: Page, opts: ExportOptions, index: number): Promise<void> {
  const jpeg = await renderPageJpeg(page, opts);
  downloadBlob(jpeg, pageFileName(opts.prefix, index));
}
