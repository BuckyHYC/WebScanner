import { create } from 'zustand';
import type { FilterState, Page, Point, Toast } from '../types';

/** 新建默认滤镜参数 */
export function defaultFilter(mode: FilterState['mode'] = 'original'): FilterState {
  return {
    mode,
    brightness: 0,
    contrast: 0,
    saturation: 0,
    sharpen: mode === 'magic' || mode === 'color' || mode === 'photo' ? 25 : 0,
    shadow: mode === 'magic' ? 60 : mode === 'color' ? 55 : 0,
    cleanBg: mode === 'magic' ? 40 : mode === 'color' ? 45 : 0,
    denoise: 0,
    block: 41,
    cValue: 10,
  };
}

/** 撤销快照：只保存页面数组结构（Page 内 blob 等大对象引用共享，内存可控） */
type Snapshot = { pages: Page[] };

interface Store {
  view: 'home' | 'editor';
  pages: Page[];
  current: number; // 当前编辑页索引
  past: Snapshot[];
  future: Snapshot[];
  toasts: Toast[];
  exporting: { active: boolean; done: number; total: number; label: string } | null;
  cameraOpen: boolean;

  setView: (v: 'home' | 'editor') => void;
  setCameraOpen: (open: boolean) => void;
  addPages: (ps: Page[], selectFirst?: boolean) => void;
  insertPage: (index: number, p: Page) => void;
  removePage: (index: number) => void;
  duplicatePage: (index: number) => void;
  movePage: (from: number, to: number) => void;
  setCurrent: (i: number) => void;
  updatePage: (id: string, patch: Partial<Page>, history?: boolean) => void;
  updateFilter: (id: string, patch: Partial<FilterState>, history?: boolean) => void;
  applyFilterToAll: (mode: FilterState['mode']) => void;
  autoEnhanceAll: () => void;
  autoCropAll: () => void;
  resetCorners: (id: string) => void;

  pushHistory: () => void;
  undo: () => void;
  redo: () => void;

  toast: (text: string, tone?: Toast['tone']) => void;
  dropToast: (id: number) => void;
  setExporting: (e: Store['exporting']) => void;
}

let toastSeq = 1;

export const useStore = create<Store>((set, get) => ({
  view: 'home',
  pages: [],
  current: 0,
  past: [],
  future: [],
  toasts: [],
  exporting: null,
  cameraOpen: false,

  setView: (v) => set({ view: v }),
  setCameraOpen: (open) => set({ cameraOpen: open }),

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
    get().pushHistory();
    set((s) => {
      const pages = s.pages.filter((_, i) => i !== index);
      const current = Math.min(s.current, Math.max(0, pages.length - 1));
      return { pages, current };
    });
  },

  duplicatePage: (index) => {
    get().pushHistory();
    set((s) => {
      const src = s.pages[index];
      if (!src) return {};
      const copy: Page = {
        ...src,
        id: crypto.randomUUID(),
        name: src.name.replace(/(\.\w+)?$/, '') + ' - 副本',
        filter: { ...src.filter },
        corners: src.corners.map((c) => ({ ...c })),
        polygon: src.polygon ? src.polygon.map((c) => ({ ...c })) : null,
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

  applyFilterToAll: (mode) => {
    get().pushHistory();
    set((s) => ({
      pages: s.pages.map((p) => ({
        ...p,
        filter: { ...defaultFilter(mode), block: p.filter.block, cValue: p.filter.cValue },
        filterName: filterLabel(mode),
      })),
    }));
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

  /** 角点批量重测由调用方（Workspace）异步执行后调用 updatePage */
  autoCropAll: () => {
    /* 在 Workspace 中异步执行：逐页 detect 后 updatePage(id, {corners}, false)，最后统一 pushHistory */
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

  toast: (text, tone = 'info') => {
    const id = toastSeq++;
    set((s) => ({ toasts: [...s.toasts, { id, text, tone }] }));
    setTimeout(() => get().dropToast(id), 2600);
  },

  dropToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  setExporting: (e) => set({ exporting: e }),
}));

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
