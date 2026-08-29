import { useCallback, useEffect, useRef, useState } from 'react';
import type { Page, Point } from '../types';
import { useStore } from '../store/useStore';
import { renderFinal, autoDetectPage } from '../utils/render';
import { loadOpenCV } from '../utils/opencvLoader';
import { detectQuadInCanvas, detectSkewInCanvas } from '../utils/detect';

interface Props {
  page: Page;
  onNext: () => void;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** 双线性插值取四边形内部点（画三分网格用） */
function bilinear(q: Point[], u: number, v: number): Point {
  const top = { x: q[0].x + (q[1].x - q[0].x) * u, y: q[0].y + (q[1].y - q[0].y) * u };
  const bottom = { x: q[3].x + (q[2].x - q[3].x) * u, y: q[3].y + (q[2].y - q[3].y) * u };
  return { x: top.x + (bottom.x - top.x) * v, y: top.y + (bottom.y - top.y) * v };
}

export default function CropStage({ page, onNext }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [container, setContainer] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [showPreview, setShowPreview] = useState(true);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<
    | null
    | { kind: 'corner'; idx: number }
    | { kind: 'pan'; startX: number; startY: number; basePan: { x: number; y: number } }
    | { kind: 'pinch'; baseDist: number; baseZoom: number; imgX: number; imgY: number }
  >(null);

  const scaleFit = imgSize && container.w > 0 ? Math.min(container.w / imgSize.w, container.h / imgSize.h) : 1;
  const dispW = imgSize ? imgSize.w * scaleFit : 0;
  const dispH = imgSize ? imgSize.h * scaleFit : 0;
  const left = (container.w - dispW * zoom) / 2 + pan.x;
  const top = (container.h - dispH * zoom) / 2 + pan.y;

  // 容器尺寸监听
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setContainer({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setContainer({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // 切页时重置视图
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setImgSize(null);
  }, [page.id]);

  // ===== 实时矫正小预览（几何+滤镜，防抖）=====
  useEffect(() => {
    if (!showPreview) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const canvas = await renderFinal(page, 360);
        if (cancelled) return;
        const target = previewRef.current;
        if (target) {
          target.width = canvas.width;
          target.height = canvas.height;
          target.getContext('2d')!.drawImage(canvas, 0, 0);
        }
        canvas.width = 0;
      } catch (e) {
        console.warn('预览渲染失败', e);
      }
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [page, showPreview]);

  /** 屏幕坐标 → 归一化坐标 */
  const toNorm = useCallback(
    (sx: number, sy: number): Point => {
      const rect = containerRef.current!.getBoundingClientRect();
      const x = sx - rect.left;
      const y = sy - rect.top;
      return { x: (x - left) / (dispW * zoom), y: (y - top) / (dispH * zoom) };
    },
    [left, top, dispW, dispH, zoom],
  );

  // ===== 指针手势：拖角点 / 单指平移 / 双指缩放平移 =====
  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const rect = containerRef.current!.getBoundingClientRect();
    const pos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    pointers.current.set(e.pointerId, pos);

    if (pointers.current.size === 2) {
      // 进入双指捏合
      const [a, b] = [...pointers.current.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      gesture.current = {
        kind: 'pinch',
        baseDist: Math.hypot(a.x - b.x, a.y - b.y),
        baseZoom: zoom,
        imgX: (mid.x - left) / (scaleFit * zoom),
        imgY: (mid.y - top) / (scaleFit * zoom),
      };
      return;
    }

    // 命中检测：角点与边中点（屏幕 22px 内）
    const r = 22;
    const cs = page.corners.map((c) => ({
      x: left + c.x * dispW * zoom,
      y: top + c.y * dispH * zoom,
    }));
    for (let i = 0; i < 4; i++) {
      if (Math.hypot(cs[i].x - pos.x, cs[i].y - pos.y) < r) {
        useStore.getState().pushHistory();
        gesture.current = { kind: 'corner', idx: i };
        return;
      }
    }
    for (let i = 0; i < 4; i++) {
      const a = cs[i];
      const b = cs[(i + 1) % 4];
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (Math.hypot(m.x - pos.x, m.y - pos.y) < r) {
        useStore.getState().pushHistory();
        gesture.current = { kind: 'corner', idx: i === 3 ? 7 : 4 + i }; // 4~7 表示边中点
        return;
      }
    }

    gesture.current = { kind: 'pan', startX: pos.x, startY: pos.y, basePan: { ...pan } };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    const rect = containerRef.current!.getBoundingClientRect();
    const pos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    pointers.current.set(e.pointerId, pos);
    const g = gesture.current;
    if (!g) return;

    if (g.kind === 'corner') {
      const n = toNorm(pos.x + rect.left, pos.y + rect.top);
      const corners = page.corners.map((c) => ({ ...c }));
      if (g.idx < 4) {
        corners[g.idx] = { x: clamp01(n.x), y: clamp01(n.y) };
      } else {
        // 边中点：相邻两角一起移动
        const edge = g.idx - 4;
        const dx = n.x - (page.corners[edge].x + page.corners[(edge + 1) % 4].x) / 2;
        const dy = n.y - (page.corners[edge].y + page.corners[(edge + 1) % 4].y) / 2;
        corners[edge] = { x: clamp01(page.corners[edge].x + dx), y: clamp01(page.corners[edge].y + dy) };
        corners[(edge + 1) % 4] = {
          x: clamp01(page.corners[(edge + 1) % 4].x + dx),
          y: clamp01(page.corners[(edge + 1) % 4].y + dy),
        };
      }
      useStore.getState().updatePage(page.id, { corners }, false);
      return;
    }

    if (g.kind === 'pan') {
      setPan({ x: g.basePan.x + pos.x - g.startX, y: g.basePan.y + pos.y - g.startY });
      return;
    }

    if (g.kind === 'pinch' && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const nz = Math.min(8, Math.max(0.6, (g.baseZoom * dist) / Math.max(1, g.baseDist)));
      // 保持捏合起点图像位置跟随当前中点（同时完成缩放围绕中点与双指平移）
      setZoom(nz);
      setPan({
        x: mid.x - (container.w - dispW * nz) / 2 - g.imgX * scaleFit * nz,
        y: mid.y - (container.h - dispH * nz) / 2 - g.imgY * scaleFit * nz,
      });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2 && gesture.current?.kind === 'pinch') gesture.current = null;
    if (pointers.current.size === 0) gesture.current = null;
  };

  // 滚轮缩放（以光标为中心，需非 passive 监听才能 preventDefault）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      setZoom((z) => {
        const nz = Math.min(8, Math.max(0.6, z * Math.exp(-e.deltaY * 0.0012)));
        if (nz === z || !imgSize) return z;
        // 光标下的图像点保持不动
        const left0 = (container.w - dispW * z) / 2 + pan.x;
        const top0 = (container.h - dispH * z) / 2 + pan.y;
        const imgX = (cx - left0) / (scaleFit * z);
        const imgY = (cy - top0) / (scaleFit * z);
        const leftN = cx - imgX * scaleFit * nz;
        const topN = cy - imgY * scaleFit * nz;
        setPan({ x: leftN - (container.w - dispW * nz) / 2, y: topN - (container.h - dispH * nz) / 2 });
        return nz;
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [container, dispW, dispH, scaleFit, pan, imgSize]);

  // ===== 工具动作 =====
  const setProps = (patch: Partial<Page>) => useStore.getState().updatePage(page.id, patch, true);

  const autoDetect = async () => {
    useStore.getState().toast('正在识别边缘…');
    try {
      const quad = await autoDetectPage(page);
      if (quad) {
        setProps({ corners: quad });
        useStore.getState().toast('边缘识别完成', 'success');
      } else {
        useStore.getState().toast('未识别到文档边缘，请手动拖动角点', 'error');
      }
    } catch {
      useStore.getState().toast('边缘识别失败', 'error');
    }
  };

  const deskew = async () => {
    try {
      const cv = await loadOpenCV();
      const img = new Image();
      img.src = page.preview;
      await img.decode();
      const c = document.createElement('canvas');
      const s = Math.min(1, 800 / Math.max(img.width, img.height));
      c.width = Math.round(img.width * s);
      c.height = Math.round(img.height * s);
      c.getContext('2d', { willReadFrequently: true })!.drawImage(img, 0, 0, c.width, c.height);
      const angle = await detectSkewAngleSafe(cv, c);
      if (Math.abs(angle) > 0.05) {
        setProps({ fineRotate: Math.max(-15, Math.min(15, -angle)) });
        useStore.getState().toast(`检测到倾斜 ${angle.toFixed(1)}°，已自动摆正`, 'success');
      } else {
        useStore.getState().toast('未检测到明显倾斜');
      }
    } catch {
      useStore.getState().toast('自动摆正失败', 'error');
    }
  };

  const q = page.corners;
  const z = zoom;
  const vx = q[0].x * dispW;
  const vy = q[0].y * dispH;
  const stroke = 1.6 / z;
  const handleR = 11 / z;
  const midR = 7 / z;
  // 四边形三分网格线端点
  const gridV = [1 / 3, 2 / 3].map((u) => [bilinear(q, u, 0), bilinear(q, u, 1)]);
  const gridH = [1 / 3, 2 / 3].map((v) => [bilinear(q, 0, v), bilinear(q, 1, v)]);
  const midPts = [0, 1, 2, 3].map((i) => ({
    x: (q[i].x + q[(i + 1) % 4].x) / 2,
    y: (q[i].y + q[(i + 1) % 4].y) / 2,
  }));

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* 工具行 */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 overflow-x-auto shrink-0 border-b border-ink-800 bg-ink-900/40">
        <button className="btn-panel shrink-0 text-xs" onClick={() => void autoDetect()}>
          🔍 自动检测
        </button>
        <button
          className="btn-panel shrink-0 text-xs"
          onClick={() =>
            setProps({
              corners: [
                { x: 0, y: 0 },
                { x: 1, y: 0 },
                { x: 1, y: 1 },
                { x: 0, y: 1 },
              ],
            })
          }
        >
          ♻️ 重置角点
        </button>
        <button className="btn-panel shrink-0 text-xs" onClick={() => setProps({ rotation: (((page.rotation + 90) % 360) as 0 | 90 | 180 | 270) })}>
          ↻ 90°
        </button>
        <button className="btn-panel shrink-0 text-xs" onClick={() => setProps({ flipH: !page.flipH })}>
          ⇄ 镜像
        </button>
        <button className="btn-panel shrink-0 text-xs" onClick={() => setProps({ flipV: !page.flipV })}>
          ⇅ 翻转
        </button>
        <button className="btn-panel shrink-0 text-xs" onClick={() => void deskew()}>
          📐 自动摆正
        </button>
        <label className="flex items-center gap-1.5 shrink-0 text-xs text-slate-400 px-1">
          微调
          <input
            type="range"
            min={-15}
            max={15}
            step={0.1}
            value={page.fineRotate}
            className="w-24"
            onPointerDown={() => useStore.getState().pushHistory()}
            onChange={(e) => useStore.getState().updatePage(page.id, { fineRotate: Number(e.target.value) }, false)}
          />
          <span className="w-10 tabular-nums">{page.fineRotate.toFixed(1)}°</span>
        </label>
        <div className="flex-1 min-w-2" />
        <button
          className="btn-ghost shrink-0 text-xs"
          onClick={() => {
            setZoom(1);
            setPan({ x: 0, y: 0 });
          }}
        >
          适应
        </button>
        <button className="btn-ghost shrink-0 text-xs" onClick={() => setShowPreview((v) => !v)}>
          {showPreview ? '👁 隐藏预览' : '👁 显示预览'}
        </button>
        <button className="btn-primary shrink-0 text-xs" onClick={onNext}>
          下一步 →
        </button>
      </div>

      {/* 画布区 */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 relative overflow-hidden touch-none select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div
          className="absolute"
          style={{
            left,
            top,
            width: dispW,
            height: dispH,
            boxShadow: '0 0 0 1px rgba(255,255,255,0.08)',
          }}
        >
          <img
            src={page.preview}
            alt={page.name}
            className="w-full h-full block"
            draggable={false}
            onLoad={(e) => setImgSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          />
          {imgSize && (
            <svg
              className="absolute inset-0 w-full h-full"
              viewBox={`0 0 ${dispW} ${dispH}`}
              preserveAspectRatio="none"
              style={{ overflow: 'visible' }}
            >
              {/* 四边形 + 内部网格 */}
              <path
                d={`M ${vx} ${vy} L ${q[1].x * dispW} ${q[1].y * dispH} L ${q[2].x * dispW} ${q[2].y * dispH} L ${q[3].x * dispW} ${q[3].y * dispH} Z`}
                fill="rgba(47,129,247,0.14)"
                stroke="#2f81f7"
                strokeWidth={stroke}
                vectorEffect="non-scaling-stroke"
              />
              {gridV.concat(gridH).map(([a, b], i) => (
                <line
                  key={i}
                  x1={a.x * dispW}
                  y1={a.y * dispH}
                  x2={b.x * dispW}
                  y2={b.y * dispH}
                  stroke="rgba(255,255,255,0.55)"
                  strokeWidth={stroke * 0.6}
                  strokeDasharray={`${4 / z} ${4 / z}`}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {/* 边中点手柄 */}
              {midPts.map((m, i) => (
                <circle
                  key={`m${i}`}
                  cx={m.x * dispW}
                  cy={m.y * dispH}
                  r={midR}
                  fill="#2f81f7"
                  stroke="#fff"
                  strokeWidth={stroke}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {/* 四角手柄 */}
              {q.map((c, i) => (
                <circle
                  key={i}
                  cx={c.x * dispW}
                  cy={c.y * dispH}
                  r={handleR}
                  fill="#fff"
                  stroke="#2f81f7"
                  strokeWidth={stroke * 1.4}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </svg>
          )}
        </div>

        {/* 操作提示 */}
        <div className="absolute top-2 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-[11px] text-slate-300 pointer-events-none whitespace-nowrap">
          拖动角点调整边缘 · 滚轮/双指缩放 · 单指平移
        </div>

        {/* 实时矫正预览 */}
        {showPreview && (
          <div className="absolute bottom-3 right-3 rounded-lg border border-ink-600 bg-ink-900/90 p-1.5 shadow-xl">
            <div className="text-[10px] text-slate-400 px-0.5 pb-1">矫正预览</div>
            <canvas ref={previewRef} className="max-w-[42vw] sm:max-w-[220px] max-h-[30vh] rounded bg-white object-contain" />
          </div>
        )}
      </div>
    </div>
  );
}

/** deskew 检测的容错包装 */
async function detectSkewAngleSafe(cv: any, canvas: HTMLCanvasElement): Promise<number> {
  try {
    return detectSkewInCanvas(cv, canvas);
  } catch {
    return 0;
  }
}
