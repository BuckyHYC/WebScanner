import type { Page } from '../types';

/**
 * IndexedDB 本地草稿：自动暂存当前文档，刷新/意外关闭后自动恢复。
 *
 * 兼容性说明：iOS Safari 对 IndexedDB 中直接存储的 Blob 存在已知的
 * 跨会话损坏缺陷（读回后 Blob 数据失效，createImageBitmap 失败导致
 * 预览/导出崩溃）。因此保存时统一把 Blob 转成 ArrayBuffer + type 记录，
 * 加载时重建 Blob；同时兼容旧版直接存 Blob 的草稿。
 */
const DB_NAME = 'webscanner-draft';
const STORE = 'draft';
const KEY = 'current';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 页面持久化格式：blob 转 ArrayBuffer + type */
type DraftPage = Omit<Page, 'blob'> & { blob: ArrayBuffer; blobType?: string };

export async function saveDraft(pages: Page[]): Promise<void> {
  if (pages.length === 0) {
    await clearDraft();
    return;
  }
  // 逐页把 Blob 读成 ArrayBuffer（Safari 持久化更可靠），保持 preview/thumb dataURL 字符串
  const serialized: DraftPage[] = await Promise.all(
    pages.map(async (p) => ({
      ...p,
      blob: await p.blob.arrayBuffer(),
      blobType: p.blob.type || 'image/jpeg',
    })),
  );
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(serialized, KEY);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function loadDraft(): Promise<Page[] | null> {
  try {
    const db = await openDB();
    const raw = await new Promise<unknown>((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (!raw || !Array.isArray(raw)) return null;

    return (raw as Array<Record<string, unknown>>).map((p) => {
      const b = p.blob;
      let blob: Blob;
      if (b instanceof Blob) {
        // 旧版草稿：直接存了 Blob，尽量保留（若损坏则回退到预览图重建）
        blob = b;
      } else if (b instanceof ArrayBuffer) {
        blob = new Blob([b], { type: (p.blobType as string) || 'image/jpeg' });
      } else if (b && typeof (b as any).buffer !== 'undefined') {
        // 兼容 TypedArray 形态
        blob = new Blob([new Uint8Array((b as any).buffer)], { type: (p.blobType as string) || 'image/jpeg' });
      } else {
        // 无法识别：用预览 dataURL 重建一个可用的 Blob，保证导出不崩
        blob = dataURLToBlob((p.preview as string) || '');
      }
      const { blobType: _bt, ...rest } = p;
      void _bt;
      return { ...(rest as unknown as Page), blob } as Page;
    });
  } catch {
    return null;
  }
}

/** dataURL → Blob（兜底重建用） */
function dataURLToBlob(dataURL: string): Blob {
  try {
    const m = /^data:([^;]+);base64,(.*)$/.exec(dataURL);
    if (!m) return new Blob();
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: m[1] });
  } catch {
    return new Blob();
  }
}

export async function clearDraft(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(KEY);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}
