import { useEffect, useRef, useState } from 'react';
import { useStore } from './store/useStore';
import { importFiles } from './utils/importer';
import { loadOpenCV } from './utils/opencvLoader';
import { getDraft, migrateLegacyDraft, openDraft } from './utils/draftsDb';
import { flushSave, notePages, resetSyncBaseline } from './utils/draftSync';
import type { Route } from './utils/router';
import { goHome, parseRoute, watchRoute } from './utils/router';
import Home from './components/Home';
import Workspace from './components/Workspace';
import CameraView from './components/CameraView';
import CvProgressBar from './components/CvProgressBar';

/** 路由处理序号守卫：快速切换路由时丢弃过期加载结果 */
let routeSeq = 0;

/** 路由处理：进入编辑页加载草稿；回首页 flush 保存并清空编辑态 */
async function handleRoute(r: Route) {
  const seq = ++routeSeq;
  const s = useStore.getState();
  if (r.view === 'editor') {
    if (s.draftId === r.draftId) {
      if (s.view !== 'editor') useStore.setState({ view: 'editor' });
      return;
    }
    const meta = await getDraft(r.draftId);
    if (seq !== routeSeq) return;
    if (!meta) {
      useStore.getState().toast('草稿不存在或已被删除');
      goHome();
      return;
    }
    const pages = await openDraft(r.draftId);
    if (seq !== routeSeq) return;
    if (!pages) {
      useStore.getState().toast('草稿不存在或已被删除');
      goHome();
      return;
    }
    resetSyncBaseline(pages);
    useStore.setState({
      view: 'editor',
      draftId: r.draftId,
      draftName: meta.name,
      pages,
      current: 0,
      past: [],
      future: [],
    });
    return;
  }
  // home：离开编辑页时立即快照保存（后台完成后再刷新列表，更新时间与封面）
  if (s.draftId !== null) {
    void flushSave()
      .catch(() => {})
      .finally(() => void useStore.getState().refreshDrafts());
  } else {
    void useStore.getState().refreshDrafts();
  }
  useStore.setState({
    view: 'home',
    draftId: null,
    draftName: '',
    pages: [],
    current: 0,
    past: [],
    future: [],
  });
}

export default function App() {
  const view = useStore((s) => s.view);
  const toasts = useStore((s) => s.toasts);
  const exporting = useStore((s) => s.exporting);
  const exportCancel = useStore((s) => s.exportCancel);
  const cameraOpen = useStore((s) => s.cameraOpen);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);

  // 启动：后台预热 OpenCV + 旧单草稿迁移 + 初始路由 + 监听路由变化
  useEffect(() => {
    loadOpenCV().catch(() => {
      /* 首次用到算法时会再次尝试 */
    });

    let disposed = false;
    (async () => {
      await migrateLegacyDraft();
      if (disposed) return;
      await handleRoute(parseRoute());
    })();

    const unwatch = watchRoute((r) => void handleRoute(r));
    return () => {
      disposed = true;
      unwatch();
    };
  }, []);

  // 草稿自动保存：pages 引用变化 → 800ms 防抖差量落盘（draftId 非空即在编辑态）
  useEffect(() => {
    const unsub = useStore.subscribe(
      (s) => s.pages,
      (pages) => {
        if (useStore.getState().draftId !== null) notePages(pages);
      },
    );
    return unsub;
  }, []);

  // 移动端杀后台/切后台/关闭前立即落盘（防抖可能来不及触发）
  useEffect(() => {
    const flush = () => {
      void flushSave();
    };
    const onVis = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', onVis);
    return () => {
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
      {view === 'home' ? <Home /> : <Workspace />}

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
