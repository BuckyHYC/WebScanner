import Dexie, { type Table } from 'dexie';
import type { DraftMeta, Page } from '../types';

/**
 * 多草稿持久化（IndexedDB / Dexie）：
 * - drafts 表：草稿元数据（名称/时间/页面顺序/封面缩略图）
 * - pages 表：每页完整编辑数据（原图、裁剪点、滤镜、擦除蒙版等）
 *
 * 兼容性说明：iOS Safari 对 IndexedDB 中直接存储的 Blob 存在已知的
 * 跨会话损坏缺陷，因此保存时统一把 Blob 转成 ArrayBuffer + type 记录，
 * 加载时重建 Blob。
 */
export const DEFAULT_DRAFT_NAME = '未命名文档';

/** drafts 表记录 */
export interface DraftRecord {
  id?: number; // ++id 自增主键
  name: string;
  createdAt: number;
  updatedAt: number;
  /** 页面顺序（pageId 列表） */
  pageOrder: string[];
  /** 首页缩略图 dataURL（无页面时为 null） */
  coverThumb: string | null;
}

/** pages 表记录：Page 数据，blob 换成 ArrayBuffer 以兼容 iOS Safari */
export interface PageRecord {
  id: string;
  draftId: number; // 索引
  order: number; // 页序号
  data: Omit<Page, 'blob'> & { blob: ArrayBuffer | Blob; blobType?: string };
}

class ScannerDB extends Dexie {
  drafts!: Table<DraftRecord, number>;
  pages!: Table<PageRecord, string>;

  constructor() {
    super('webscanner-drafts');
    this.version(1).stores({
      drafts: '++id, updatedAt',
      pages: 'id, draftId',
    });
  }
}

export const db = new ScannerDB();

/** 全部草稿元数据，按最近编辑时间倒序 */
export async function listDrafts(): Promise<DraftMeta[]> {
  const rows = await db.drafts.toArray();
  return rows
    .filter((d): d is DraftRecord & { id: number } => typeof d.id === 'number')
    .map((d) => ({ ...d }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getDraft(id: number): Promise<DraftMeta | undefined> {
  const d = await db.drafts.get(id);
  if (!d || typeof d.id !== 'number') return undefined;
  return { ...d, id: d.id };
}

/** 新建空草稿，返回自增 id */
export async function createDraft(name = DEFAULT_DRAFT_NAME): Promise<number> {
  const now = Date.now();
  return db.drafts.add({ name, createdAt: now, updatedAt: now, pageOrder: [], coverThumb: null });
}

/** 重命名（同时刷新编辑时间） */
export async function renameDraft(id: number, name: string): Promise<void> {
  const d = await db.drafts.get(id);
  if (!d) return;
  await db.drafts.put({ ...d, name, updatedAt: Date.now() });
}

/** 批量删除草稿及其全部页面 */
export async function deleteDrafts(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await db.transaction('rw', db.drafts, db.pages, async () => {
    for (const id of ids) {
      await db.pages.where('draftId').equals(id).delete();
    }
    await db.drafts.bulkDelete(ids);
  });
}

/** 清空所有草稿 */
export async function clearAllDrafts(): Promise<void> {
  await db.transaction('rw', db.drafts, db.pages, async () => {
    await db.pages.clear();
    await db.drafts.clear();
  });
}

/** 打开草稿：按 pageOrder 组装全部页面；草稿不存在返回 null */
export async function openDraft(id: number): Promise<Page[] | null> {
  const d = await db.drafts.get(id);
  if (!d) return null;
  const rows = await db.pages.where('draftId').equals(id).toArray();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered: Page[] = [];
  for (const pid of d.pageOrder) {
    const r = byId.get(pid);
    if (r) ordered.push(deserializePage(r));
  }
  return ordered;
}

/**
 * 差量保存：写入变化/新增页、删除移除页，并更新草稿元数据
 * （updatedAt / pageOrder / coverThumb）。草稿已被删除时跳过，防止复活。
 */
export async function saveDraftPages(
  draftId: number,
  full: Page[],
  changed: Page[],
  removedIds: string[],
): Promise<void> {
  // Blob → ArrayBuffer 序列化放在事务外（Safari 兼容 + 不占用事务时间）
  const orderOf = new Map(full.map((p, i) => [p.id, i]));
  const records = await Promise.all(
    changed.map(async (p) => ({
      id: p.id,
      draftId,
      order: orderOf.get(p.id) ?? 0,
      data: { ...stripBlob(p), blob: await p.blob.arrayBuffer(), blobType: p.blob.type || 'image/jpeg' },
    })),
  );
  await db.transaction('rw', db.drafts, db.pages, async () => {
    const d = await db.drafts.get(draftId);
    if (!d) return;
    if (records.length > 0) await db.pages.bulkPut(records);
    if (removedIds.length > 0) await db.pages.bulkDelete(removedIds);
    await db.drafts.put({
      ...d,
      updatedAt: Date.now(),
      pageOrder: full.map((p) => p.id),
      coverThumb: full[0]?.thumb ?? null,
    });
  });
}

function stripBlob(p: Page): Omit<Page, 'blob'> {
  const { blob: _blob, ...rest } = p;
  void _blob;
  return rest;
}

/** PageRecord → Page（重建 Blob，兼容旧格式直接存 Blob / TypedArray 的记录） */
function deserializePage(r: PageRecord): Page {
  const { blob, blobType, ...rest } = r.data;
  let b: Blob;
  if (blob instanceof Blob) {
    b = blob;
  } else if (blob instanceof ArrayBuffer) {
    b = new Blob([blob], { type: blobType || 'image/jpeg' });
  } else if (blob && typeof (blob as unknown as { buffer?: ArrayBuffer }).buffer !== 'undefined') {
    b = new Blob([new Uint8Array((blob as unknown as { buffer: ArrayBuffer }).buffer)], {
      type: blobType || 'image/jpeg',
    });
  } else {
    b = dataURLToBlob((rest as Page).preview || '');
  }
  return { ...(rest as Omit<Page, 'blob'>), blob: b };
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

/* ===== 旧版单草稿迁移 ===== */
const LEGACY_DB = 'webscanner-draft';
const LEGACY_STORE = 'draft';
const LEGACY_KEY = 'current';

/**
 * 迁移旧版单草稿（v1 库 'webscanner-draft' 的 'current' 记录）为多草稿结构，
 * 完成后删除旧库。旧库不存在时清理 open 误建的空库。
 * 单例 Promise：React StrictMode 下启动 effect 双跑时共享同一次执行，防止重复迁移。
 */
let migratePromise: Promise<void> | null = null;

export function migrateLegacyDraft(): Promise<void> {
  if (!migratePromise) migratePromise = doMigrateLegacy();
  return migratePromise;
}

async function doMigrateLegacy(): Promise<void> {
  try {
    const hasLegacy = await new Promise<boolean>((resolve, reject) => {
      const req = indexedDB.open(LEGACY_DB);
      req.onsuccess = () => {
        const idb = req.result;
        resolve(idb.objectStoreNames.contains(LEGACY_STORE));
        idb.close();
      };
      req.onerror = () => reject(req.error);
    });
    if (!hasLegacy) {
      await deleteDb(LEGACY_DB);
      return;
    }
    const raw = await new Promise<unknown>((resolve, reject) => {
      const req = indexedDB.open(LEGACY_DB);
      req.onsuccess = () => {
        const idb = req.result;
        const get = idb.transaction(LEGACY_STORE, 'readonly').objectStore(LEGACY_STORE).get(LEGACY_KEY);
        get.onsuccess = () => {
          idb.close();
          resolve(get.result ?? null);
        };
        get.onerror = () => {
          idb.close();
          reject(get.error);
        };
      };
      req.onerror = () => reject(req.error);
    });
    if (Array.isArray(raw) && raw.length > 0) {
      const pages = (raw as Array<Record<string, unknown>>).map((p) =>
        deserializePage({
          id: p.id as string,
          draftId: -1,
          order: 0,
          data: {
            ...(p as unknown as Omit<Page, 'blob'>),
            blob: p.blob as ArrayBuffer | Blob,
            blobType: p.blobType as string | undefined,
          },
        }),
      );
      const id = await createDraft();
      await saveDraftPages(id, pages, pages, []);
    }
    await deleteDb(LEGACY_DB);
  } catch (e) {
    console.warn('旧草稿迁移失败（不影响新功能使用）', e);
  }
}

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}
