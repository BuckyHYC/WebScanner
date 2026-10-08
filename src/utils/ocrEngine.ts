/**
 * PaddleOCR 浏览器端 OCR 引擎（Umi-OCR 同款识别引擎家族）。
 * - 模型与 onnxruntime wasm 由 scripts/copy-ocr.js 拷入 public/ocr/，首次使用时本地加载（约 42MB）
 * - 优先在 worker 内推理（ort proxy 模式，避免主线程冻结）；Safari/iOS WebKit 不支持
 *   worker 内实例化 ort（Module Worker 限制），对 WebKit 直接主线程推理，
 *   且 proxy 模式推理失败时自动降级重建引擎重试一次
 * - 单例 Promise 缓存：StrictMode 双跑下并发调用共享同一次加载
 */
import type { Page } from '../types';
import { renderFinal } from './render';

type OcrInstance = Awaited<ReturnType<typeof import('@gutenye/ocr-browser').default.create>>;

let loading: Promise<OcrInstance> | null = null;
/** 当前缓存的引擎是否运行在 proxy worker 模式（降级后为 false） */
let proxyActive = true;

/**
 * 是否应禁用 ort proxy worker：iOS 全系（含 iOS 上的第三方浏览器，均为 WebKit 内核）
 * 与桌面 Safari 不支持在 Worker 中实例化 onnxruntime（Module Worker / blob 限制）。
 * 注意 iOS 第三方浏览器 UA 也含 "Safari" 字样，需一并排除 CriOS/FxiOS 等。
 */
function shouldDisableProxy(): boolean {
  const ua = navigator.userAgent;
  const isIOS = /iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in document); // iPad 桌面 UA
  const isDesktopSafari = /AppleWebKit/.test(ua) && /Safari/.test(ua) && !/Chrom(e|ium)|Edg(e|iOS)?|FxiOS|CriOS|Firefox|Android/.test(ua);
  return isIOS || isDesktopSafari;
}

/** 创建 OCR 引擎会话（根据环境决定是否启用 worker 推理） */
async function createEngine(): Promise<OcrInstance> {
  // 先配置 ort 再创建会话（env 是全局单例）。
  // dev：wasm 直连 node_modules；构建：Vite 自动把 ort 内部的
  // new URL('ort-wasm-simd-threaded.jsep.wasm', import.meta.url) 改写为带哈希的 assets 资源，无需手动指定。
  const ort = await import('onnxruntime-web');
  if (import.meta.env.DEV) {
    ort.env.wasm.wasmPaths = '/node_modules/onnxruntime-web/dist/';
  }
  const { default: Ocr } = await import('@gutenye/ocr-browser');
  const models = new URL('ocr/models/', document.baseURI).href;
  const options = {
    models: {
      detectionPath: models + 'ch_PP-OCRv4_det_infer.onnx',
      recognitionPath: models + 'ch_PP-OCRv4_rec_infer.onnx',
      dictionaryPath: models + 'ppocr_keys_v1.txt',
    },
  } as const;

  if (shouldDisableProxy()) {
    ort.env.wasm.proxy = false;
    proxyActive = false;
    console.info('[ocr] WebKit 环境：使用主线程推理');
    return Ocr.create(options);
  }
  try {
    ort.env.wasm.proxy = true;
    proxyActive = true;
    return await Ocr.create(options);
  } catch (e) {
    console.warn('[ocr] worker 内创建会话失败，降级主线程推理', e);
    ort.env.wasm.proxy = false;
    proxyActive = false;
    return Ocr.create(options);
  }
}

/** 加载 OCR 引擎（det + rec 模型与字典），失败后下次调用会重新尝试 */
export function loadOcrEngine(): Promise<OcrInstance> {
  loading ??= createEngine();
  loading.catch(() => {
    loading = null; // 允许重试
  });
  return loading;
}

export interface OcrOutcome {
  text: string;
  lines: number;
}

async function detectOnce(page: Page): Promise<OcrOutcome> {
  const ocr = await loadOcrEngine();
  const canvas = await renderFinal(page, 960);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('画布上下文创建失败');
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { texts } = await ocr.detect({ data: imageData.data, width: imageData.width, height: imageData.height });
  return { text: texts.map((l) => l.text).join('\n'), lines: texts.length };
}

/**
 * 识别一页（裁剪 + 滤镜 + 擦除 + 旋转后的最终画面）。
 * 渲染限制长边 960：检测模型内部按 32 的倍数处理，过大会显著拖慢且精度提升有限。
 */
export async function recognizePage(page: Page): Promise<OcrOutcome> {
  try {
    return await detectOnce(page);
  } catch (e) {
    // 部分环境（旧版 Safari 等）会话创建成功但 worker 内推理失败 → 禁用 proxy 重建引擎重试一次
    if (!proxyActive) throw e;
    console.warn('[ocr] worker 内推理失败，降级主线程重建引擎重试', e);
    proxyActive = false;
    loading = null;
    return detectOnce(page);
  }
}
