import type { Page } from '../types';
import { useStore } from '../store/useStore';
import { saveDraftPages } from './draftsDb';

/**
 * 当前草稿的差量自动保存：
 * - pages 引用变化 → notePages 缓存 + 800ms 防抖
 * - flushSave 对比上次保存基线，只写入变化/新增页、删除移除页
 *   （store 所有更新均为 immutable 替换，引用不同即视为脏）
 * - 保存互斥：进行中再触发会合并补跑一次，避免重叠事务
 */
let baseline: Page[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let busy = false;
let pendingAgain = false;
let lastQuotaToast = 0;

/** 进入新草稿时重置基线（避免上一草稿数据污染差量计算） */
export function resetSyncBaseline(pages: Page[]) {
  clearTimeout(timer);
  baseline = pages;
}

export function notePages(pages: Page[]) {
  clearTimeout(timer);
  timer = setTimeout(() => void flushSave(), 800);
}

/** 快照待保存状态（同步执行），随后 store 清空不影响本次保存 */
function capture(): { draftId: number | null; pages: Page[] } {
  const s = useStore.getState();
  return { draftId: s.draftId, pages: s.pages };
}

export async function flushSave(): Promise<void> {
  clearTimeout(timer);
  if (busy) {
    pendingAgain = true;
    return;
  }
  busy = true;
  try {
    await doSave(capture());
  } finally {
    busy = false;
    if (pendingAgain) {
      pendingAgain = false;
      void flushSave();
    }
  }
}

async function doSave({ draftId, pages }: { draftId: number | null; pages: Page[] }) {
  if (draftId === null || pages === baseline) return;
  const prev = new Map(baseline.map((p) => [p.id, p]));
  const changed = pages.filter((p) => prev.get(p.id) !== p);
  const curIds = new Set(pages.map((p) => p.id));
  const removed = baseline.filter((p) => !curIds.has(p.id)).map((p) => p.id);
  try {
    await saveDraftPages(draftId, pages, changed, removed);
    baseline = pages;
  } catch (e) {
    const name = (e as DOMException)?.name ?? String(e);
    if (name === 'QuotaExceededError' || /quota/i.test(name)) {
      const now = Date.now();
      if (now - lastQuotaToast > 5000) {
        lastQuotaToast = now;
        useStore
          .getState()
          .toast('本地存储空间不足，最新修改可能未保存。请返回首页删除旧草稿释放空间', 'error');
      }
    } else {
      console.warn('草稿保存失败', e);
    }
  }
}
