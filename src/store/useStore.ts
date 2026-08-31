import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { DraftMeta, FilterState, Page, Point, Toast } from '../types';
import { uid } from '../utils/uid';
import { listDrafts } from '../utils/draftsDb';

/** 新建默认滤镜参数 */
export function defaultFilter(mode: FilterState['mode'] = 'original'): FilterState {
  return {
    mode,
    strength: mode === 'magic' ? 80 : 0,
    brightness: 0,
    contrast: 0,
    saturation: 0,
    sharpen: 0,
    shadow: 0,
    cleanBg: 0,
    denoise: 0,
    block: 41,
    cValue: 10,
  };
}

/** 撤销快照：只保存页面数组结构（Page 内 blob 等大对象引用共享，内存可控） */
type Snapshot = { pages: Page[] };

interface Store {
  view: 'home' | 'editor';
  /** 当前编辑的草稿 id（home 视图下为 null） */
  draftId: number | null;
  /** 当前草稿名（编辑页顶栏 / 导出默认名） */
  draftName: string;
  /** 首页草稿列表（updatedAt 倒序，由 draftsDb 读取） */
  drafts: DraftMeta[];
  pages: Page[];
  current: number; // 当前编辑页索引
  past: Snapshot[];
  future: Snapshot[];
  toasts: Toast[];
  exporting: { active: boolean; done: number; total: number; label: string } | null;
  /** 取消当前导出（为 null 表示无进行中的导出） */
  exportCancel: (() => void) | null;
  cameraOpen: boolean;

  setView: (v: 'home' | 'editor') => void;
  setCameraOpen: (open: boolean) => void;
  refreshDrafts: () => Promise<void>;
  addPages: (ps: Page[], selectFirst?: boolean) => void;
  insertPage: (index: number, p: Page) => void;
  removePage: (index: number) => void;
  duplicatePage: (index: number) => void;
  movePage: (from: number, to: number) => void;
  setCurrent: (i: number) => void;
  updatePage: (id: string, patch: Partial<Page>, history?: boolean) => void;
  updateFilter: (id: string, patch: Partial<FilterState>, history?: boolean) => void;
  applyFilterToAll: () => void;
  autoEnhanceAll: () => void;
  resetCorners: (id: string) => void;

  pushHistory: () => void;
  undo: () => void;
  redo: () => void;

  toast: (text: string, tone?: Toast['tone'], action?: Toast['action']) => void;
  dropToast: (id: number) => void;
  setExporting: (e: Store['exporting']) => void;
  setExportCancel: (fn: (() => void) | null) => void;
}

let toastSeq = 1;

export const useStore = create<Store>()(subscribeWithSelector((set, get) => ({
  view: 'home',
  draftId: null,
  draftName: '',
  drafts: [],
  pages: [],
  current: 0,
  past: [],
  future: [],
  toasts: [],
  exporting: null,
  exportCancel: null,
  cameraOpen: false,

  setView: (v) => set({ view: v }),
  setCameraOpen: (open) => set({ cameraOpen: open }),

  refreshDrafts: async () => {
    try {
      const drafts = await listDrafts();
      set({ drafts });
    } catch (e) {
      console.warn('读取草稿列表失败', e);
    }
  },

  addPages: (ps, selectFirst = false) =>
    set((s) => ({
      pages: [...s.pages, ...ps],
      current: selectFirst && s.pages.length === 0 ? 0 : s.current,
      view: 'editor',
    })),

  insertPage: (index, p) => {
    get().pushHistory();
    set((s) => {
      const pages = [...s.pages];
      pages.splice(index, 0, p);
      return { pages, current: index };
    });
  },

  removePage: (index) => {
    const removed = get().pages[index];
    if (!removed) return;
    get().pushHistory();
    set((s) => {
      const pages = s.pages.filter((_, i) => i !== index);
      const current = Math.min(s.current, Math.max(0, pages.length - 1));
      return { pages, current };
    });
    // 删页 toast 带撤销：一键恢复到原位置
    get().toast(`已删除「${removed.name}」`, 'info', {
      label: '撤销',
      run: () => {
        const st = useStore.getState();
        // 已恢复过（如 undo）则跳过
        if (st.pages.some((p) => p.id === removed.id)) return;
        st.insertPage(Math.min(index, st.pages.length), removed);
        st.setView('editor');
      },
    });
  },

  duplicatePage: (index) => {
    get().pushHistory();
    set((s) => {
      const src = s.pages[index];
      if (!src) return {};
      const copy: Page = {
        ...src,
        id: uid(),
        name: src.name.replace(/(\.\w+)?$/, '') + ' - 副本',
        filter: { ...src.filter },
        corners: src.corners.map((c) => ({ ...c })),
        polygon: src.polygon ? src.polygon.map((c) => ({ ...c })) : null,
        eraseMask: src.eraseMask ?? null,
      };
      const pages = [...s.pages];
      pages.splice(index + 1, 0, copy);
      return { pages, current: index + 1 };
    });
  },

  movePage: (from, to) => {
    if (from === to) return;
    get().pushHistory();
    set((s) => {
      const pages = [...s.pages];
      const [p] = pages.splice(from, 1);
      pages.splice(to, 0, p);
      return { pages, current: to };
    });
  },

  setCurrent: (i) => set({ current: i }),

  updatePage: (id, patch, history = true) => {
    if (history) get().pushHistory();
    set((s) => ({
      pages: s.pages.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    }));
  },

  updateFilter: (id, patch, history = true) => {
    if (history) get().pushHistory();
    set((s) => ({
      pages: s.pages.map((p) =>
        p.id === id ? { ...p, filter: { ...p.filter, ...patch } } : p,
      ),
    }));
  },

  /** 把当前页的完整滤镜状态（含自定义滑块值）同步到所有页面 */
  applyFilterToAll: () => {
    get().pushHistory();
    set((s) => {
      const cur = s.pages[s.current];
      if (!cur) return {};
      return {
        pages: s.pages.map((p) => ({
          ...p,
          filter: { ...cur.filter },
          filterName: cur.filterName,
        })),
      };
    });
  },

  autoEnhanceAll: () => {
    get().pushHistory();
    set((s) => ({
      pages: s.pages.map((p) => ({
        ...p,
        filter: defaultFilter('magic'),
        filterName: filterLabel('magic'),
      })),
    }));
  },

  resetCorners: (id) => {
    get().pushHistory();
    set((s) => ({
      pages: s.pages.map((p) =>
        p.id === id
          ? {
              ...p,
              corners: [
                { x: 0, y: 0 },
                { x: 1, y: 0 },
                { x: 1, y: 1 },
                { x: 0, y: 1 },
              ],
            }
          : p,
      ),
    }));
  },

  pushHistory: () =>
    set((s) => ({
      past: [...s.past.slice(-49), { pages: s.pages.map((p) => ({ ...p })) }],
      future: [],
    })),

  undo: () =>
    set((s) => {
      const prev = s.past[s.past.length - 1];
      if (!prev) return {};
      return {
        past: s.past.slice(0, -1),
        future: [{ pages: s.pages.map((p) => ({ ...p })) }, ...s.future.slice(0, 49)],
        pages: prev.pages.map((p) => ({ ...p })),
        current: Math.min(s.current, prev.pages.length - 1),
      };
    }),

  redo: () =>
    set((s) => {
      const next = s.future[0];
      if (!next) return {};
      return {
        future: s.future.slice(1),
        past: [...s.past.slice(-49), { pages: s.pages.map((p) => ({ ...p })) }],
        pages: next.pages.map((p) => ({ ...p })),
        current: Math.min(s.current, next.pages.length - 1),
      };
    }),

  toast: (text, tone = 'info', action) => {
    const id = toastSeq++;
    set((s) => ({ toasts: [...s.toasts, { id, text, tone, action }] }));
    // 带操作按钮的 toast 显示久一点，给用户反应时间
    setTimeout(() => get().dropToast(id), action ? 3600 : 2600);
  },

  dropToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  setExporting: (e) => set({ exporting: e }),

  setExportCancel: (fn) => set({ exportCancel: fn }),
})));

export function filterLabel(mode: FilterState['mode']): string {
  const map: Record<FilterState['mode'], string> = {
    original: '原图',
    magic: '增强',
    color: '彩色',
    gray: '灰度',
    bw: '黑白',
    photo: '照片',
  };
  return map[mode];
}

/** 全图默认角点 */
export const fullQuad = (): Point[] => [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];
