/**
 * 把 pdf.js 的 cMap（中文/日文等 CID 字体映射）与 standard_fonts（14 种标准字体）
 * 复制到 public/pdfjs/，供 pdfImport.ts 在运行期按 URL 加载。
 * 缺少这两份资源时，非嵌入字体的 PDF（常见于国产 OA/办公软件导出的中文 PDF）会渲染成空白。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const srcPkg = path.join(root, 'node_modules', 'pdfjs-dist');
const destRoot = path.join(root, 'public', 'pdfjs');

const targets = [
  ['cmaps', 'cmaps'],
  ['standard_fonts', 'standard_fonts'],
];

try {
  if (!fs.existsSync(srcPkg)) {
    console.warn('[copy-pdfjs] 未找到 node_modules/pdfjs-dist，请先 npm install');
    process.exit(0);
  }
  let copied = 0;
  for (const [from, to] of targets) {
    const src = path.join(srcPkg, from);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(destRoot, to);
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      const s = path.join(src, name);
      if (!fs.statSync(s).isFile()) continue;
      fs.copyFileSync(s, path.join(dest, name));
      copied++;
    }
  }
  console.log(`[copy-pdfjs] 已复制 ${copied} 个 pdf.js 资源到 public/pdfjs/`);
} catch (e) {
  console.warn('[copy-pdfjs] 复制失败（不影响启动）:', e.message);
}
