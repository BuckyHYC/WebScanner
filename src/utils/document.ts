/**
 * 整页 Markdown 后处理（移植自上游 Xiaomi-OCR-0 postprocess/document.py）。
 * 顺序与上游 finalize_document 一致：
 *   尾部周期重复截断 → LaTeX 定界符归一化 → OTSL 表格转 HTML
 */
import { OTSL_TAG_RE, convertOtslToHtml } from './otsl';

/** 把 \[..\] / \(..\) 归一化成本站能直接渲染的 Markdown 数学定界符 */
export function postprocessMathDelimiters(markdown: string): string {
  if (!markdown) return markdown;
  let out = markdown.replace(/\[\[/g, '[').replace(/\]\]/g, ']');
  out = out.replace(/\$\$?\s*\\\[\s*([\s\S]*?)\s*\\\]\s*\$\$?/g, (_m, g1) => ` $$ ${g1} $$ `);
  out = out.replace(/\$\s*\\\(\s*([\s\S]*?)\s*\\\)\s*\$/g, (_m, g1) => ` $ ${g1} $ `);
  out = out.replace(/\\\[\s*([\s\S]*?)\s*\\\]/g, (_m, g1) => ` $$ ${g1} $$ `);
  out = out.replace(/\\\(\s*([\s\S]*?)\s*\\\)/g, (_m, g1) => ` $ ${g1} $ `);
  return out;
}

/**
 * 截断尾部周期性重复：保留一个周期 + 余数。
 * 只对超长输出生效（默认 ≥8000 字符），作为模型偶发复读的兜底止损。
 */
export function cleanTruncatedRepeats(
  text: string,
  opts: { minTextLen?: number; maxPeriod?: number; minPeriod?: number; minRepeatChars?: number; minRepeatTimes?: number } = {},
): string {
  const { minTextLen = 8000, maxPeriod: maxPeriodOpt = 200, minPeriod = 1, minRepeatChars = 100, minRepeatTimes = 5 } = opts;
  const n = text.length;
  if (n < minTextLen) return text;

  const maxPeriod = Math.min(maxPeriodOpt, n - 1);
  for (let unitLen = minPeriod; unitLen <= maxPeriod; unitLen++) {
    if (text[n - 1] !== text[n - 1 - unitLen]) continue;

    let matchLen = 1;
    let idx = n - 2;
    while (idx >= unitLen && text[idx] === text[idx - unitLen]) {
      matchLen++;
      idx--;
    }

    const totalLen = matchLen + unitLen;
    const repeatTimes = Math.floor(totalLen / unitLen);
    const tailLen = totalLen % unitLen;

    if (repeatTimes >= minRepeatTimes && totalLen >= minRepeatChars) {
      return text.slice(0, n - totalLen + unitLen) + text.slice(n - tailLen);
    }
  }
  return text;
}

/** 把疑似 OTSL 的 markdown 块转成 HTML 表格；转换失败保留原文 */
export function postprocessOtslTables(markdown: string): string {
  if (!markdown || !OTSL_TAG_RE.test(markdown)) return markdown;

  const parts = markdown.split(/(\n\s*\n)/);
  const blocks: string[][] = [];
  for (let i = 0; i < parts.length; i += 2) {
    blocks.push([parts[i], i + 1 < parts.length ? parts[i + 1] : '']);
  }

  let inFence = false;
  const converted: string[] = [];
  for (let [text, sep] of blocks) {
    const stripped = text.trim();
    const fenceCount = (stripped.match(/```/g) ?? []).length;
    let shouldSkip = inFence;
    if (fenceCount % 2 === 1) {
      inFence = !inFence;
      shouldSkip = true;
    }

    if (!shouldSkip && OTSL_TAG_RE.test(stripped)) {
      try {
        const html = convertOtslToHtml(stripped);
        if (html) text = html;
      } catch {
        /* 保留原文 */
      }
    }
    converted.push(text + sep);
  }
  return converted.join('');
}

/** 整页输出最终处理（对应上游 finalize_document） */
export function finalizeDocument(text: string): string {
  return postprocessOtslTables(postprocessMathDelimiters(cleanTruncatedRepeats(text)));
}
