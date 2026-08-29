/**
 * 把 @techstark/opencv-js 的单文件构建（约 10MB，wasm 已内联）复制到 public/opencv/，
 * 由前端加载器通过 XHR 下载（可获取真实下载进度）后以内联 script 执行。
 * 避免 Vite 把 10MB 依赖打进 dev 预打包/构建产物导致的首屏主线程长阻塞。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const src = path.join(__dirname, '..', 'node_modules', '@techstark', 'opencv-js', 'dist', 'opencv.js');
const destDir = path.join(__dirname, '..', 'public', 'opencv');
const dest = path.join(destDir, 'opencv.js');

try {
  if (!fs.existsSync(src)) {
    console.warn('[copy-opencv] 未找到 node_modules/@techstark/opencv-js，请先 npm install');
    process.exit(0);
  }
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, dest);
  console.log('[copy-opencv] 已复制 opencv.js 到 public/opencv/');
} catch (e) {
  console.warn('[copy-opencv] 复制失败（不影响启动）:', e.message);
}
