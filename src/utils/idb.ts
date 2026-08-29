import type { Page } from '../types';

/**
 * IndexedDB 本地草稿：自动暂存当前文档（Blob 可直接存入），
 * 刷新/意外关闭后自动恢复，防止编辑丢失。
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

export async function saveDraft(pages: Page[]): Promise<void> {
  if (pages.length === 0) {
    await clearDraft();
    return;
  }
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(structuredClone(pages), KEY);
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
    const result = await new Promise<Page[] | null>((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return result;
  } catch {
    return null;
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
