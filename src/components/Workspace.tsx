import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { useShortcuts } from '../hooks/useShortcuts';
import { IconHome, IconUndo, IconRedo, IconScissors, IconSparkles, IconPlus, IconCamera, IconSliders } from './icons';
import ThumbList from './ThumbList';
import CropStage from './CropStage';
import EnhanceStage from './EnhanceStage';
import EraseStage from './EraseStage';
import FilterPanel from './FilterPanel';
import ExportDialog from './ExportDialog';
import { importFiles } from '../utils/importer';
import { autoDetectPage } from '../utils/render';
import type { Page } from '../types';

/** 批量自动裁剪：逐页重测角点（共享一段历史快照） */
async function runAutoCropAll() {
  const s = useStore.getState();
  const pages = s.pages;
  if (pages.length === 0) return;
  const snapshots = pages.map((p) => ({ ...p }));
  useStore.setState({ past: [...s.past.slice(-49), { pages: snapshots }], future: [] });
  useStore.getState().toast('正在批量识别边缘…');
  for (const p of pages) {
    try {
      const outcome = await autoDetectPage(p);
      if (outcome) useStore.getState().updatePage(p.id, { corners: outcome.quad }, false);
    } catch {
      /* 忽略单页失败 */
    }
  }
  useStore.getState().toast('批量自动裁剪完成', 'success');
}

export default function Workspace() {
  const pages = useStore((s) => s.pages);
  const current = useStore((s) => s.current);
  const [tab, setTab] = useState<'crop' | 'enhance' | 'erase'>('crop');
  const [exportOpen, setExportOpen] = useState(false);
  const [mobilePanel, setMobilePanel] = useState(false);
  const page: Page | undefined = pages[current];

  useShortcuts();

  // 无页面时回首页
  useEffect(() => {
    if (pages.length === 0) useStore.getState().setView('home');
  }, [pages.length]);

  if (!page) return null;

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* ===== 顶部工具栏 ===== */}
      <header className="flex items-center gap-1 px-2 sm:px-3 h-12 border-b border-ink-700 bg-gradient-to-b from-ink-900 to-[#0d131a] shrink-0">
        <button className="btn-ghost px-2 text-slate-400 hover:text-slate-100" title="返回首页" onClick={() => useStore.getState().setView('home')}>
          <IconHome className="w-[18px] h-[18px]" />
        </button>
        <span className="hidden sm:inline font-semibold mr-2 text-slate-200">智能扫描</span>
        <span className="text-xs text-slate-500 hidden md:inline">
          {pages.length} 页 · 当前 {current + 1}
        </span>
        <div className="flex-1" />
        <button className="btn-ghost text-slate-400 hover:text-slate-100" title="撤销 (Ctrl+Z)" onClick={() => useStore.getState().undo()}>
          <IconUndo className="w-[18px] h-[18px]" />
        </button>
        <button className="btn-ghost text-slate-400 hover:text-slate-100" title="重做 (Ctrl+Y)" onClick={() => useStore.getState().redo()}>
          <IconRedo className="w-[18px] h-[18px]" />
        </button>
        <button
          className="btn-ghost text-slate-400 hover:text-slate-100"
          title="批量自动裁剪"
          onClick={() => void runAutoCropAll()}
        >
          <IconScissors className="w-[18px] h-[18px]" />
          <span className="hidden sm:inline ml-1">全部裁剪</span>
        </button>
        <button
          className="btn-ghost text-slate-400 hover:text-slate-100"
          title="全部自动增强"
          onClick={() => {
            useStore.getState().autoEnhanceAll();
            useStore.getState().toast('已对全部页面应用自动增强', 'success');
          }}
        >
          <IconSparkles className="w-[18px] h-[18px]" />
          <span className="hidden sm:inline ml-1">全部增强</span>
        </button>
        <button className="btn-ghost text-slate-400 hover:text-slate-100" title="添加图片" onClick={() => document.getElementById('ws-file-input')?.click()}>
          <IconPlus className="w-[18px] h-[18px]" />
          <span className="hidden sm:inline ml-1">添加</span>
        </button>
        <button className="btn-ghost text-slate-400 hover:text-slate-100" title="拍照" onClick={() => useStore.getState().setCameraOpen(true)}>
          <IconCamera className="w-[18px] h-[18px]" />
          <span className="hidden sm:inline ml-1">拍照</span>
        </button>
        <button className="btn-primary ml-1 rounded-lg shadow-md shadow-accent/20" onClick={() => setExportOpen(true)}>
          导出
        </button>
      </header>

      {/* ===== 主体三栏（PC）/ 单栏（移动）===== */}
      <div className="flex-1 flex min-h-0">
        <ThumbList direction="vertical" className="hidden md:flex flex-col min-h-0 w-52 lg:w-60 border-r border-ink-700 bg-ink-900 overflow-y-auto landscape-hide-left" />

        <main className="flex-1 min-w-0 flex flex-col">
          {/* 裁剪 / 增强 / 去污 Tab */}
          <div className="flex items-center gap-1 px-3 h-10 border-b border-ink-700 bg-ink-900/60 shrink-0">
            {(
              [
                ['crop', '① 裁剪矫正'],
                ['enhance', '② 增强滤镜'],
                ['erase', '③ 去污'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                className={`relative px-3 py-1.5 rounded-t-lg text-sm font-medium transition-colors ${
                  tab === k ? 'bg-ink-800 text-accent' : 'text-slate-400 hover:text-slate-200 hover:bg-ink-800/40'
                }`}
                onClick={() => setTab(k)}
              >
                {label}
                {tab === k && <span className="absolute left-2 right-2 bottom-0 h-0.5 rounded-full bg-accent" />}
              </button>
            ))}
            <div className="flex-1" />
            <PageNameEditor page={page} />
          </div>

          <div className="flex-1 min-h-0 relative bg-ink-950">
            {tab === 'crop' ? <CropStage page={page} onNext={() => setTab('enhance')} /> : tab === 'enhance' ? <EnhanceStage page={page} onNext={() => setTab('erase')} /> : <EraseStage page={page} />}
          </div>
        </main>

        <FilterPanel page={page} className="hidden lg:flex min-h-0 w-80 border-l border-ink-700 bg-ink-900 flex-col overflow-y-auto" />
      </div>

      {/* ===== 移动底部：缩略图横滑 + 工具（矮横屏手机同样显示）===== */}
      <div className="md:hidden landscape-bar relative z-50 shrink-0 border-t border-ink-700 bg-ink-900 safe-bottom">
        <ThumbList direction="horizontal" className="flex gap-2 overflow-x-auto px-2 py-2" />
        <div className="flex items-center gap-1 px-2 py-1.5 border-t border-ink-800 overflow-x-auto">
          <button className="btn-panel shrink-0 text-xs" onClick={() => setMobilePanel((v) => !v)}>
            <IconSliders className="w-3.5 h-3.5" /> 滤镜
          </button>
          <button className="btn-panel shrink-0 text-xs" onClick={() => setTab('crop')}>
            <IconScissors className="w-3.5 h-3.5" /> 裁剪
          </button>
          <button className="btn-panel shrink-0 text-xs" onClick={() => useStore.getState().setCameraOpen(true)}>
            <IconCamera className="w-3.5 h-3.5" /> 拍照
          </button>
          <button className="btn-panel shrink-0 text-xs" onClick={() => void runAutoCropAll()}>
            <IconScissors className="w-3.5 h-3.5" /> 全部裁剪
          </button>
          <div className="flex-1" />
          <button className="btn-primary shrink-0 text-xs" onClick={() => setExportOpen(true)}>
            导出
          </button>
        </div>
        {mobilePanel && (
          <div className="fixed right-0 top-12 bottom-0 w-72 z-40 bg-ink-900 border-l border-ink-700 overflow-y-auto shadow-2xl lg:hidden">
            <FilterPanel page={page} className="flex flex-col p-3 gap-4 pb-24" onDone={() => setMobilePanel(false)} />
          </div>
        )}
      </div>

      {/* 隐藏的添加文件入口（供工具栏"添加"按钮与指定位置插入复用） */}
      <input
        id="ws-file-input"
        type="file"
        accept="image/*,.heic,.heif,.tif,.tiff"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length > 0) void importFiles(files);
          e.target.value = '';
        }}
      />

      {exportOpen && <ExportDialog onClose={() => setExportOpen(false)} />}
    </div>
  );
}

/** 顶栏页名显示：双击（PC）/ 长按 500ms（移动）进入重命名 */
function PageNameEditor({ page }: { page: Page }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(page.name);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };
  useEffect(() => clearTimer, []);

  const startEdit = () => {
    setDraft(page.name);
    setEditing(true);
  };

  const commit = () => {
    setEditing(false);
    const name = draft.trim();
    if (name && name !== page.name) {
      useStore.getState().updatePage(page.id, { name }, true);
    }
  };

  if (editing) {
    return (
      <input
        autoFocus
        className="w-28 sm:w-40 min-w-0 bg-ink-800 border border-accent/60 rounded px-1.5 py-0.5 text-xs text-slate-200 outline-none"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setEditing(false);
        }}
      />
    );
  }

  return (
    <span
      className="text-xs text-slate-500 min-w-0 max-w-[7rem] sm:max-w-none truncate cursor-text"
      title="双击或长按重命名"
      onDoubleClick={startEdit}
      onTouchStart={() => {
        clearTimer();
        timerRef.current = setTimeout(startEdit, 500);
      }}
      onTouchEnd={clearTimer}
      onTouchMove={clearTimer}
      onTouchCancel={clearTimer}
    >
      {page.name}
      <span className="hidden sm:inline"> · {page.width}×{page.height}</span>
    </span>
  );
}
