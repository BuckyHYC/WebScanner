import { useCallback, useEffect, useRef, useState } from 'react';
import type { Page, Point } from '../types';
import { useStore } from '../store/useStore';
import { loadOpenCV } from '../utils/opencvLoader';
import { renderGeometry } from '../utils/render';
import { applyEraseMask, composeMask, loadImage, paintStroke } from '../utils/erase';

interface Props {
  page: Page;
}

type Tool = 'brush' | 'eraser';

/**
 * 去污工作台：在滤镜处理结果上涂抹蒙版，松手即 Telea 修复。
 * - 画笔/橡皮 + 笔径滑块
 * - 每笔一撤销（Ctrl+Z 或按钮）；重置清除全部擦除
 * - 累计蒙版存入 page.eraseMask，导出/预览全分辨率生效
 */
export default function EraseStage({ page }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const displayRef = useRef<HTMLCanvasElement>(null); // 工作画布（滤镜结果 + 已执行擦除）
  const overlayRef = useRef<HTMLCanvasElement>(null); // 蒙版覆盖层
  const [busy, setBusy] = useState(false);
  const [tool, setTool] = useState<Tool>('brush');
  const [brushSize, setBrushSize] = useState(30);
  const [strokeCount, setStrokeCount] = useState(0);

  // 底图缓存（仅几何+滤镜，不含擦除）与逐笔蒙版历史
  const baseRef = useRef<{ key: string; canvas: HTMLCanvasElement } | null>(null);
  const strokesRef = useRef<string[]>([]); // 每笔蒙版 dataURL（显示分辨率）
  const painting = useRef(false);
  const lastPt = useRef<Point | null>(null);

  const geoKey = JSON.stringify([page.corners, page.rotation, page.flipH, page.flipV, page.fineRotate, page.polygon, page.filter]);

  /** 渲染干净底图并重放已有擦除（切页/几何变化时调用） */
  const rebuild = useCallback(async () => {
    setBusy(true);
    try {
      const el = containerRef.current;
      const target = Math.max(800, Math.min(1600, Math.round((el?.clientWidth ?? 1000) * (window.devicePixelRatio || 1))));
      const canvas = await renderGeometry(page, target);
      // 应用已存储的累计蒙版（来自历史草稿）
      let working = canvas;
      if (page.eraseMask) {
        working = await applyEraseMask(await loadOpenCV(), working, page.eraseMask);
      }
      baseRef.current = { key: geoKey, canvas: working };
      strokesRef.current = [];
      setStrokeCount(0);
      const display = displayRef.current;
      const overlay = overlayRef.current;
      if (display && overlay) {
        display.width = working.width;
        display.height = working.height;
        display.getContext('2d')!.drawImage(working, 0, 0);
        overlay.width = working.width;
        overlay.height = working.height;
      }
    } catch (e) {
      console.warn('去污底图渲染失败', e);
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id, geoKey]);

  useEffect(() => {
    baseRef.current = null;
    void rebuild();
  }, [rebuild]);

  /** 提交一笔：把覆盖层蒙版写入历史、在工作画布上执行修复、更新存储蒙版 */
  const commitStroke = useCallback(async () => {
    const overlay = overlayRef.current;
    const base = baseRef.current;
    const display = displayRef.current;
    if (!overlay || !base || !display) return;
    // 蒙版内容是否为空
    const data = overlay.getContext('2d')!.getImageData(0, 0, overlay.width, overlay.height).data;
    let painted = false;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 40) { painted = true; break; }
    }
    if (!painted) return;

    setBusy(true);
    try {
      const strokeUrl = overlay.toDataURL('image/png');
      strokesRef.current.push(strokeUrl);
      // 工作画布上执行修复
      const cv = await loadOpenCV();
      await applyEraseMask(cv, display, strokeUrl, display);
      // 更新存储蒙版（累计）
      const cumulative = await composeMask(strokesRef.current, overlay.width, overlay.height);
      useStore.getState().updatePage(page.id, { eraseMask: cumulative }, true);
      setStrokeCount(strokesRef.current.length);
    } catch (e) {
      console.warn('擦除执行失败', e);
      useStore.getState().toast('擦除执行失败', 'error');
    } finally {
      // 清空覆盖层
      overlay.getContext('2d')!.clearRect(0, 0, overlay.width, overlay.height);
      setBusy(false);
    }
  }, [page.id]);

  /** 撤销上一笔：弹出一笔蒙版，从干净底图顺序重放剩余各笔 */
  const undoStroke = useCallback(async () => {
    if (strokesRef.current.length === 0 || !baseRef.current) return;
    setBusy(true);
    try {
      strokesRef.current.pop();
      const cv = await loadOpenCV();
      // 从干净底图重放
      const working = await (async () => {
        const c = document.createElement('canvas');
        c.width = baseRef.current!.canvas.width;
        c.height = baseRef.current!.canvas.height;
        c.getContext('2d')!.drawImage(baseRef.current!.canvas, 0, 0);
        return c;
      })();
      for (const s of strokesRef.current) {
        await applyEraseMask(cv, working, s, working);
      }
      const display = displayRef.current;
      if (display) {
        display.width = working.width;
        display.height = working.height;
        display.getContext('2d')!.drawImage(working, 0, 0);
      }
      const overlay = overlayRef.current;
      const cumulative = await composeMask(strokesRef.current, overlay?.width ?? working.width, overlay?.height ?? working.height);
      useStore.getState().updatePage(page.id, { eraseMask: cumulative }, true);
      setStrokeCount(strokesRef.current.length);
    } finally {
      setBusy(false);
    }
  }, [page.id]);

  /** 重置全部擦除 */
  const resetAll = useCallback(async () => {
    if (!page.eraseMask && strokesRef.current.length === 0) return;
    setBusy(true);
    try {
      strokesRef.current = [];
      setStrokeCount(0);
      useStore.getState().updatePage(page.id, { eraseMask: null }, true);
      const base = baseRef.current;
      const display = displayRef.current;
      if (base && display) {
        display.width = base.canvas.width;
        display.height = base.canvas.height;
        display.getContext('2d')!.drawImage(base.canvas, 0, 0);
      }
      overlayRef.current?.getContext('2d')!.clearRect(0, 0, overlayRef.current!.width, overlayRef.current!.height);
      useStore.getState().toast('已清除全部擦除痕迹', 'success');
    } finally {
      setBusy(false);
    }
  }, [page.eraseMask, page.id]);

  // ===== 涂抹交互：触摸走原生非被动监听，鼠标走 React 事件 =====
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const sizeRef = useRef(brushSize);
  sizeRef.current = brushSize;

  const toCanvasPos = (clientX: number, clientY: number) => {
    const rect = overlayRef.current!.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * overlayRef.current!.width,
      y: ((clientY - rect.top) / rect.height) * overlayRef.current!.height,
    };
  };

  const beginStroke = useCallback((clientX: number, clientY: number) => {
    const overlay = overlayRef.current;
    if (!overlay || busy) return;
    painting.current = true;
    const pos = toCanvasPos(clientX, clientY);
    lastPt.current = pos;
    const ctx = overlay.getContext('2d')!;
    const ratio = overlay.width / (overlay.getBoundingClientRect().width || 1);
    paintStroke(ctx, pos, pos, sizeRef.current * ratio, 'rgba(255,64,96,0.5)', toolRef.current === 'eraser');
  }, [busy]);

  const moveStroke = useCallback((clientX: number, clientY: number) => {
    if (!painting.current) return;
    const overlay = overlayRef.current;
    if (!overlay) return;
    const pos = toCanvasPos(clientX, clientY);
    const ctx = overlay.getContext('2d')!;
    const ratio = overlay.width / (overlay.getBoundingClientRect().width || 1);
    paintStroke(ctx, lastPt.current ?? pos, pos, sizeRef.current * ratio, 'rgba(255,64,96,0.5)', toolRef.current === 'eraser');
    lastPt.current = pos;
  }, []);

  const endStroke = useCallback(() => {
    if (!painting.current) return;
    painting.current = false;
    lastPt.current = null;
    void commitStroke();
  }, [commitStroke]);

  // 触摸（原生非被动）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onStart = (e: TouchEvent) => {
      e.preventDefault();
      const t = e.changedTouches[0];
      beginStroke(t.clientX, t.clientY);
    };
    const onMove = (e: TouchEvent) => {
      e.preventDefault();
      const t = e.changedTouches[0];
      moveStroke(t.clientX, t.clientY);
    };
    const onEnd = (e: TouchEvent) => {
      e.preventDefault();
      endStroke();
    };
    el.addEventListener('touchstart', onStart, { passive: false });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: false });
    el.addEventListener('touchcancel', onEnd, { passive: false });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, [beginStroke, moveStroke, endStroke]);

  // Ctrl+Z 撤销上一笔（捕获阶段，避免触发全局页面级撤销）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        if (strokesRef.current.length > 0) {
          e.preventDefault();
          e.stopImmediatePropagation();
          void undoStroke();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [undoStroke]);

  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* 工具行（md+ 自动换行，手机横向滚动） */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 shrink-0 border-b border-ink-800 bg-ink-900/40 flex-nowrap overflow-x-auto md:flex-wrap md:overflow-visible">
        <button
          className={`btn-panel shrink-0 text-xs ${tool === 'brush' ? '!bg-accent !text-white' : ''}`}
          onClick={() => setTool('brush')}
        >
          🖌️ 画笔
        </button>
        <button
          className={`btn-panel shrink-0 text-xs ${tool === 'eraser' ? '!bg-accent !text-white' : ''}`}
          onClick={() => setTool('eraser')}
        >
          🧽 橡皮擦
        </button>
        <label className="flex items-center gap-1.5 shrink-0 text-xs text-slate-400 px-1">
          笔径
          <input
            type="range"
            min={5}
            max={100}
            value={brushSize}
            className="w-24"
            onChange={(e) => setBrushSize(Number(e.target.value))}
          />
          <span className="w-8 tabular-nums">{brushSize}</span>
        </label>
        <div className="flex-1 min-w-2" />
        <button
          className="btn-panel shrink-0 text-xs"
          disabled={strokeCount === 0 || busy}
          onClick={() => void undoStroke()}
          title="撤销上一笔 (Ctrl+Z)"
        >
          ↩️ 撤销{strokeCount > 0 ? `(${strokeCount})` : ''}
        </button>
        <button
          className="btn-panel shrink-0 text-xs !text-rose-300"
          disabled={busy || (!page.eraseMask && strokeCount === 0)}
          onClick={() => void resetAll()}
        >
          🗑️ 重置擦除
        </button>
      </div>

      {/* 画布区：触摸走原生事件，鼠标走 React 事件 */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 relative overflow-hidden flex items-center justify-center p-2 bg-ink-950 touch-none select-none"
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          beginStroke(e.clientX, e.clientY);
        }}
        onMouseMove={(e) => moveStroke(e.clientX, e.clientY)}
        onMouseUp={() => endStroke()}
        onMouseLeave={() => endStroke()}
      >
        <div className="relative" style={{ maxHeight: '100%', maxWidth: '100%' }}>
          <canvas
            ref={displayRef}
            className="block object-contain rounded shadow-2xl"
            style={{ maxHeight: '100%', maxWidth: '100%', height: 'auto', width: '100%' }}
          />
          <canvas
            ref={overlayRef}
            className="absolute inset-0 w-full h-full cursor-crosshair"
            style={{ pointerEvents: 'none' }}
          />
        </div>

        {busy && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40 pointer-events-none">
            <div className="rounded-lg bg-ink-800/95 px-4 py-2 text-sm flex items-center gap-2">
              <span className="animate-spin inline-block w-4 h-4 border-2 border-accent border-t-transparent rounded-full" />
              修复中…
            </div>
          </div>
        )}

        {!busy && strokeCount === 0 && !page.eraseMask && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-[11px] text-slate-300 pointer-events-none whitespace-nowrap">
            用 {tool === 'brush' ? '画笔' : '橡皮'}涂抹需要{tool === 'brush' ? '清除' : '还原'}的区域 · 松手自动修复
          </div>
        )}
      </div>
      <span className="hidden">{dpr}</span>
    </div>
  );
}

// 供 loadImage 类型引用（避免未使用告警的兼容引用）
void loadImage;
