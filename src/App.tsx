import { useEffect, useRef, useState } from 'react';
import { useStore } from './store/useStore';
import { importFiles } from './utils/importer';
import { loadDraft, saveDraft } from './utils/idb';
import { loadOpenCV } from './utils/opencvLoader';
import Home from './components/Home';
import Workspace from './components/Workspace';
import CameraView from './components/CameraView';
import CvProgressBar from './components/CvProgressBar';

export default function App() {
  const view = useStore((s) => s.view);
  const toasts = useStore((s) => s.toasts);
  const exporting = useStore((s) => s.exporting);
  const exportCancel = useStore((s) => s.exportCancel);
  const cameraOpen = useStore((s) => s.cameraOpen);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);

  // 启动：后台预热 OpenCV + 恢复草稿 + 草稿自动保存
  useEffect(() => {
    loadOpenCV().catch(() => {
      /* 首次用到算法时会再次尝试 */
    });

    (async () => {
      const draft = await loadDraft();
      if (draft && draft.length > 0) {
        useStore.setState({ pages: draft, view: 'editor' });
        setDraftRestored(true);
      }
    })();

    let timer: ReturnType<typeof setTimeout> | undefined;
    // 仅订阅 pages 引用变化：toast/切页/导出状态等非 pages 变化不再触发草稿全量重写
    const unsub = useStore.subscribe(
      (s) => s.pages,
      (pages) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          saveDraft(pages).catch(() => {});
        }, 1500);
      },
    );

    // 移动端杀后台/切后台前立即落盘最新草稿（防抖可能来不及触发）
    const flush = () => {
      clearTimeout(timer);
      const pages = useStore.getState().pages;
      if (pages.length > 0) void saveDraft(pages);
    };
    const onVis = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', onVis);

    return () => {
      unsub();
      clearTimeout(timer);
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  // 全局粘贴导入
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length > 0) {
        e.preventDefault();
        void importFiles(files);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  // 全窗口拖拽导入
  useEffect(() => {
    const onEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      dragDepth.current++;
      setDragging(true);
    };
    const onLeave = () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    };
    const onOver = (e: DragEvent) => e.preventDefault();
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length > 0) void importFiles(files);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  return (
    <div className="h-full min-h-0">
      {view === 'home' ? <Home draftRestored={draftRestored} onDraftSeen={() => setDraftRestored(false)} /> : <Workspace />}

      {cameraOpen && <CameraView />}

      {/* OpenCV 引擎加载进度 */}
      <CvProgressBar />

      {/* 导出进度遮罩 */}
      {exporting?.active && (
        <div className="fixed inset-0 z-[90] flex flex-col items-center justify-center bg-black/70 gap-4">
          <div className="text-lg font-medium">{exporting.label}</div>
          <div className="w-64 h-2 rounded bg-ink-700 overflow-hidden">
            <div
              className="h-full bg-accent transition-all"
              style={{ width: `${exporting.total ? (exporting.done / exporting.total) * 100 : 0}%` }}
            />
          </div>
          <div className="text-sm text-slate-400">
            {exporting.done} / {exporting.total}
          </div>
          {exportCancel && (
            <button className="btn-panel mt-1" onClick={exportCancel}>
              取消导出
            </button>
          )}
        </div>
      )}

      {/* 拖拽提示遮罩 */}
      {dragging && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center bg-accent/20 border-4 border-dashed border-accent pointer-events-none">
          <div className="rounded-xl bg-ink-900/90 px-6 py-4 text-lg">松开以导入图片</div>
        </div>
      )}

      {/* Toasts */}
      <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[99] flex flex-col gap-2 items-center pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto rounded-lg px-4 py-2 text-sm shadow-lg flex items-center gap-3 ${
              t.tone === 'success'
                ? 'bg-emerald-600/90 text-white'
                : t.tone === 'error'
                  ? 'bg-rose-600/90 text-white'
                  : 'bg-ink-700/95 text-slate-200'
            }`}
          >
            <span>{t.text}</span>
            {t.action && (
              <button
                className="shrink-0 font-medium text-accent hover:text-accent-hover underline underline-offset-2"
                onClick={() => {
                  t.action!.run();
                  useStore.getState().dropToast(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
