import { useCallback, useEffect, useRef, useState } from 'react';
import type { Page, Point } from '../types';
import { useStore } from '../store/useStore';
import { applyFilterToCanvas, renderGeometry } from '../utils/render';

interface Props {
  page: Page;
}

/**
 * 增强阶段：几何结果缓存 + 滤镜实时应用（滑块调节只跑滤镜，不重跑透视）。
 * 内置"任意多边形裁剪"（套索）模式，用于书籍曲页/缺角文档。
 */
export default function EnhanceStage({ page }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const displayRef = useRef<HTMLCanvasElement>(null);
  const baseRef = useRef<{ key: string; canvas: HTMLCanvasElement } | null>(null);
  const [busy, setBusy] = useState(false);
  const [lasso, setLasso] = useState(false);
  const [pts, setPts] = useState<Point[]>([]);

  const geoKey = JSON.stringify([page.corners, page.rotation, page.flipH, page.flipV, page.fineRotate, page.polygon]);

  const applyFilter = useCallback(async () => {
    const base = baseRef.current;
    const display = displayRef.current;
    if (!base || !display) return;
    try {
      const out = await applyFilterToCanvas(base.canvas, page.filter);
      display.width = out.width;
      display.height = out.height;
      display.getContext('2d')!.drawImage(out, 0, 0);
      out.width = 0;
    } catch (e) {
      console.warn('滤镜应用失败', e);
    }
  }, [page.filter]);

  // 几何变化 → 重建基础画布 → 应用滤镜
  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    const t = setTimeout(async () => {
      try {
        // 按容器尺寸渲染合适分辨率（上限 1600）
        const el = containerRef.current;
        const cw = el?.clientWidth ?? 1000;
        const target = Math.max(800, Math.min(1600, Math.round(cw * (window.devicePixelRatio || 1))));
        const canvas = await renderGeometry(page, target);
        if (cancelled) {
          canvas.width = 0;
          return;
        }
        baseRef.current = { key: geoKey, canvas };
        await applyFilter();
      } catch (e) {
        console.warn('几何渲染失败', e);
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, 60);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id, geoKey]);

  // 滤镜变化 → 只重跑滤镜（防抖 120ms）
  useEffect(() => {
    if (baseRef.current?.key !== geoKey) return;
    let cancelled = false;
    const t = setTimeout(() => {
      if (!cancelled) void applyFilter();
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [page.filter, geoKey, applyFilter]);

  // 切页清理
  useEffect(() => {
    baseRef.current = null;
    setLasso(false);
    setPts([]);
  }, [page.id]);

  const setPoly = (p: Point[] | null) => useStore.getState().updatePage(page.id, { polygon: p }, true);

  /** 套索点击加点（相对显示画布归一化） */
  const addPoint = (e: React.MouseEvent) => {
    if (!lasso) return;
    const rect = displayRef.current!.getBoundingClientRect();
    setPts((p) => [
      ...p,
      { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height },
    ]);
  };

  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* 工具行 */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 overflow-x-auto shrink-0 border-b border-ink-800 bg-ink-900/40">
        <button className={`btn-panel shrink-0 text-xs ${lasso ? '!bg-accent !text-white' : ''}`} onClick={() => { setLasso((v) => !v); setPts([]); }}>
          ✏️ {lasso ? '退出套索' : '多边形裁剪'}
        </button>
        {lasso && (
          <>
            <button className="btn-panel shrink-0 text-xs" disabled={pts.length === 0} onClick={() => setPts((p) => p.slice(0, -1))}>
              ↩️ 撤销点
            </button>
            <button
              className="btn-primary shrink-0 text-xs"
              disabled={pts.length < 3}
              onClick={() => {
                setPoly(pts);
                setLasso(false);
                setPts([]);
                useStore.getState().toast('多边形裁剪已应用', 'success');
              }}
            >
              ✅ 闭合并应用
            </button>
          </>
        )}
        {!lasso && page.polygon && (
          <button className="btn-panel shrink-0 text-xs" onClick={() => setPoly(null)}>
            🗑️ 清除多边形
          </button>
        )}
        <div className="flex-1" />
        <span className="text-[11px] text-slate-500 hidden sm:inline">
          {page.polygon ? '已启用多边形裁剪' : '套索可去除书籍曲页/缺角'}
        </span>
      </div>

      {/* 画布区 */}
      <div ref={containerRef} className="flex-1 min-h-0 relative overflow-hidden flex items-center justify-center p-2 bg-ink-950">
        <div className="relative" style={{ maxHeight: '100%', maxWidth: '100%' }}>
          <canvas
            ref={displayRef}
            onClick={addPoint}
            className={`block object-contain rounded shadow-2xl ${lasso ? 'cursor-crosshair' : ''}`}
            style={{ maxHeight: 'calc(100vh - 220px)', maxWidth: '100%', height: 'auto', width: '100%' }}
          />
          {/* 套索覆盖层 */}
          {(lasso || page.polygon) && (
            <svg
              className="absolute inset-0 w-full h-full pointer-events-none"
              viewBox="0 0 1 1"
              preserveAspectRatio="none"
            >
              {page.polygon && !lasso && (
                <polygon
                  points={page.polygon.map((p) => `${p.x},${p.y}`).join(' ')}
                  fill="none"
                  stroke="#f59e0b"
                  strokeWidth={1.5 / dpr}
                  vectorEffect="non-scaling-stroke"
                  strokeDasharray="6 4"
                />
              )}
              {lasso && pts.length > 0 && (
                <>
                  <polyline
                    points={pts.map((p) => `${p.x},${p.y}`).join(' ')}
                    fill="rgba(47,129,247,0.12)"
                    stroke="#2f81f7"
                    strokeWidth={1.5}
                    vectorEffect="non-scaling-stroke"
                  />
                  {pts.map((p, i) => (
                    <circle key={i} cx={p.x} cy={p.y} r={3 / dpr} fill="#fff" stroke="#2f81f7" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                  ))}
                </>
              )}
            </svg>
          )}
        </div>

        {busy && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40 pointer-events-none">
            <div className="rounded-lg bg-ink-800/95 px-4 py-2 text-sm flex items-center gap-2">
              <span className="animate-spin inline-block w-4 h-4 border-2 border-accent border-t-transparent rounded-full" />
              渲染中…
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
