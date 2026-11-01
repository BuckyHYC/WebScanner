/**
 * OCR 引擎偏好（localStorage 持久化，跟随设备而非草稿）：
 * - paddle：浏览器内 PaddleOCR（离线可用，逐行文本，默认）
 * - vlm：本机 Xiaomi-OCR-0 服务（整页 Markdown，需本机推理服务在跑）
 */
import type { VlmSettings } from './xiaomiOcr';
import { DEFAULT_VLM_MODEL, DEFAULT_VLM_ENDPOINT } from './xiaomiOcr';

export type OcrEngine = 'paddle' | 'vlm';

export interface OcrPrefs {
  engine: OcrEngine;
  vlm: VlmSettings;
}

const KEY = 'webscanner.ocr.prefs.v1';

export const defaultOcrPrefs = (): OcrPrefs => ({
  engine: 'paddle',
  vlm: { endpoint: DEFAULT_VLM_ENDPOINT, model: DEFAULT_VLM_MODEL },
});

/** 读取偏好：字段做类型校验，损坏或缺失时回落到默认值 */
export function loadOcrPrefs(): OcrPrefs {
  const base = defaultOcrPrefs();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<OcrPrefs>;
    return {
      engine: parsed.engine === 'vlm' ? 'vlm' : 'paddle',
      vlm: {
        endpoint: typeof parsed.vlm?.endpoint === 'string' && parsed.vlm.endpoint.trim() ? parsed.vlm.endpoint : base.vlm.endpoint,
        model: typeof parsed.vlm?.model === 'string' && parsed.vlm.model.trim() ? parsed.vlm.model : base.vlm.model,
      },
    };
  } catch {
    return base;
  }
}

export function saveOcrPrefs(prefs: OcrPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* 隐私模式/配额满：忽略，偏好不持久化不影响功能 */
  }
}
