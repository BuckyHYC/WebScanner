/**
 * 把 OCR 引擎的本地静态资源复制到 public/ocr/：
 * PaddleOCR ONNX 模型与字典（@gutenye/ocr-models/assets，约 15MB）。
 * 由前端 ocrEngine.ts 首次使用时按需加载，避免打进 JS 分包导致首屏阻塞。
 * 说明：onnxruntime 的 wasm 无需复制——dev 下直连 node_modules、构建时由 Vite
 * 自动把 new URL(..., import.meta.url) 改写为带哈希的 assets 资源。
 * 生成物不入 git（public/ocr/ 已在 .gitignore）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const modelsSrc = path.join(root, 'node_modules', '@gutenye', 'ocr-models', 'assets');
const modelsDest = path.join(root, 'public', 'ocr', 'models');
const MODEL_FILES = ['ch_PP-OCRv4_det_infer.onnx', 'ch_PP-OCRv4_rec_infer.onnx', 'ppocr_keys_v1.txt'];

try {
  for (const name of MODEL_FILES) {
    const src = path.join(modelsSrc, name);
    if (!fs.existsSync(src)) {
      console.warn(`[copy-ocr] 未找到模型文件 ${name}，请先 npm install`);
      process.exit(0);
    }
    fs.mkdirSync(modelsDest, { recursive: true });
    fs.copyFileSync(src, path.join(modelsDest, name));
  }
  console.log('[copy-ocr] 已复制 OCR 模型 → public/ocr/models/');
} catch (e) {
  console.warn('[copy-ocr] 复制失败（不影响启动）:', e.message);
}
