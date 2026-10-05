/**
 * PaddleOCR 浏览器端 OCR 引擎（Umi-OCR 同款识别引擎家族）。
 * - 模型与 onnxruntime wasm 由 scripts/copy-ocr.js 拷入 public/ocr/，首次使用时本地加载（约 42MB）
 * - onnxruntime-web 的 proxy 模式在 worker 内推理，避免主线程冻结；不支持时自动降级主线程
 * - 单例 Promise 缓存：StrictMode 双跑下并发调用共享同一次加载
 */
import type { Page } from '../types';
import { renderFinal } from './render';

type OcrInstance = Awaited<ReturnType<typeof import('@gutenye/ocr-browser').default.create>>;

let loading: Promise<OcrInstance> | null = null;

/** 加载 OCR 引擎（det + rec 模型与字典），失败后下次调用会重新尝试 */
export function loadOcrEngine(): Promise<OcrInstance> {
  loading ??= (async () => {
    // 先配置 ort 再创建会话（env 是全局单例）。
    // dev：wasm 直连 node_modules；构建：Vite 自动把 ort 内部的
    // new URL('ort-wasm-simd-threaded.jsep.wasm', import.meta.url) 改写为带哈希的 assets 资源，无需手动指定。
    const ort = await import('onnxruntime-web');
    if (import.meta.env.DEV) {
      ort.env.wasm.wasmPaths = '/node_modules/onnxruntime-web/dist/';
    }
    ort.env.wasm.proxy = true; // worker 内推理；环境不支持时 ort 自动回退主线程
    const { default: Ocr } = await import('@gutenye/ocr-browser');
    const models = new URL('ocr/models/', document.baseURI).href;
    return Ocr.create({
      models: {
        detectionPath: models + 'ch_PP-OCRv4_det_infer.onnx',
        recognitionPath: models + 'ch_PP-OCRv4_rec_infer.onnx',
        dictionaryPath: models + 'ppocr_keys_v1.txt',
      },
    });
  })();
  loading.catch(() => {
    loading = null; // 允许重试
  });
  return loading;
}

export interface OcrOutcome {
  text: string;
  lines: number;
}

/**
 * 识别一页（裁剪 + 滤镜 + 擦除 + 旋转后的最终画面）。
 * 渲染限制长边 960：检测模型内部按 32 的倍数处理，过大会显著拖慢且精度提升有限。
 */
export async function recognizePage(page: Page): Promise<OcrOutcome> {
  const ocr = await loadOcrEngine();
  const canvas = await renderFinal(page, 960);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('画布上下文创建失败');
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { texts } = await ocr.detect({ data: imageData.data, width: imageData.width, height: imageData.height });
  return { text: texts.map((l) => l.text).join('\n'), lines: texts.length };
}
