import { useCallback, useEffect, useRef, useState } from 'react';
import type { Page, Point } from '../types';
import { useStore } from '../store/useStore';
import { renderFinal, autoDetectPage, rotatedDims } from '../utils/render';
import { loadOpenCV } from '../utils/opencvLoader';
import { detectSkewInCanvas } from '../utils/detect';

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

type Gesture =
  | null
  | { kind: 'corner'; idx: number; touchId?: number }
  | { kind: 'pan'; touchId?: number; startX: number; startY: number; basePan: Point }
  | { kind: 'pinch'; baseDist: number; baseZoom: number; imgX: number; imgY: number };

export default function CropStage({ page, onNext }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dispCanvasRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);

  const [container, setContainer] = useState({ w: 0, h: 0 });
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [showPreview, setShowPreview] = useState(true);

  // 视图状态镜像（原生事件处理器内读 ref，避免闭包过期与重复绑定）
  const viewRef = useRef({ zoom: 1, pan: { x: 0, y: 0 } as Point });
  const imgSizeRef = useRef<{ w: number; h: number } | null>(null);
  const containerRef2 = useRef({ w: 0, h: 0 });
  const pageRef = useRef(page);
  pageRef.current = page;

  const scaleFit = imgSize && container.w > 0 ? Math.min(container.w / imgSize.w, container.h / imgSize.h) : 1;
  const dispW = imgSize ? imgSize.w * scaleFit : 0;
  const dispH = imgSize ? imgSize.h * scaleFit : 0;
  const left = (container.w - dispW * zoom) / 2 + pan.x;
  const top = (container.h - dispH * zoom) / 2 + pan.y;

  const setView = useCallback((z: number, p: Point) => {
    viewRef.current = { zoom: z, pan: p };
    setZoom(z);
    setPan(p);
  }, []);

  // 容器尺寸监听
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const s = { w: el.clientWidth, h: el.clientHeight };
      containerRef2.current = s;
      setContainer(s);
    });
    ro.observe(el);
    containerRef2.current = { w: el.clientWidth, h: el.clientHeight };
    setContainer(containerRef2.current);
    return () => ro.disconnect();
  }, []);

  // ===== 显示画布：把预览图按 rotation/flip 绘制，与导出渲染保持一致 =====
  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.src = page.preview;
    img
      .decode()
      .then(() => {
        if (cancelled) return;
        const c = dispCanvasRef.current;
        if (!c) return;
        const rot = rotatedDims(img.naturalWidth, img.naturalHeight, page.rotation);
        c.width = rot.w;
        c.height = rot.h;
        const ctx = c.getContext('2d')!;
        ctx.save();
        ctx.translate(rot.w / 2, rot.h / 2);
        ctx.scale(page.flipH ? -1 : 1, page.flipV ? -1 : 1);
        ctx.rotate((page.rotation * Math.PI) / 180);
        ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
        ctx.restore();
        imgSizeRef.current = { w: rot.w, h: rot.h };
        setImgSize({ w: rot.w, h: rot.h });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [page.preview, page.rotation, page.flipH, page.flipV, page.id]);

  // 切页 / 旋转 / 翻转时重置视图（比例变了，旧缩放无意义）
  useEffect(() => {
    setView(1, { x: 0, y: 0 });
    setImgSize(null);
    imgSizeRef.current = null;
  }, [page.id, page.rotation, page.flipH, page.flipV, setView]);

  /** 当前布局参数（屏幕像素映射） */
  const getLayout = useCallback(() => {
    const c = containerRef2.current;
    const i = imgSizeRef.current;
    const v = viewRef.current;
    const sf = i && c.w > 0 ? Math.min(c.w / i.w, c.h / i.h) : 1;
    const dw = (i?.w ?? 0) * sf;
    const dh = (i?.h ?? 0) * sf;
    const left0 = (c.w - dw * v.zoom) / 2 + v.pan.x;
    const top0 = (c.h - dh * v.zoom) / 2 + v.pan.y;
    return { sf, dw, dh, left: left0, top: top0, zoom: v.zoom };
  }, []);

  /** 把角点/边中点拖到归一化位置 n */
  const applyCorner = useCallback((idx: number, n: Point) => {
    const p = pageRef.current;
    const corners = p.corners.map((c) => ({ ...c }));
    if (idx < 4) {
      corners[idx] = n;
    } else {
      const edge = idx - 4;
      const dx = n.x - (p.corners[edge].x + p.corners[(edge + 1) % 4].x) / 2;
      const dy = n.y - (p.corners[edge].y + p.corners[(edge + 1) % 4].y) / 2;
      corners[edge] = { x: clamp01(p.corners[edge].x + dx), y: clamp01(p.corners[edge].y + dy) };
      corners[(edge + 1) % 4] = {
        x: clamp01(p.corners[(edge + 1) % 4].x + dx),
        y: clamp01(p.corners[(edge + 1) % 4].y + dy),
      };
    }
    useStore.getState().updatePage(p.id, { corners }, false);
  }, []);

  // ===== 触摸手势（原生非被动监听：拖角点 / 单指平移 / 双指缩放）=====
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const touches = new Map<number, Point>();
    let gesture: Gesture = null;

    const rect = () => el.getBoundingClientRect();

    const hitHandle = (pos: Point): number | null => {
      const { left: l, top: t, dw, dh, zoom: z } = getLayout();
      const cs = pageRef.current.corners.map((c) => ({ x: l + c.x * dw * z, y: t + c.y * dh * z }));
      const r = 24;
      for (let i = 0; i < 4; i++) {
        if (Math.hypot(cs[i].x - pos.x, cs[i].y - pos.y) < r) return i;
      }
      for (let i = 0; i < 4; i++) {
        const a = cs[i];
        const b = cs[(i + 1) % 4];
        if (Math.hypot((a.x + b.x) / 2 - pos.x, (a.y + b.y) / 2 - pos.y) < r) return 4 + i;
      }
      return null;
    };

    const onTouchStart = (e: TouchEvent) => {
      e.preventDefault();
      const r = rect();
      for (const t of Array.from(e.changedTouches)) {
        touches.set(t.identifier, { x: t.clientX - r.left, y: t.clientY - r.top });
      }
      const list = [...touches.entries()];
      if (list.length === 1) {
        const pos = list[0][1];
        const h = hitHandle(pos);
        if (h !== null) {
          useStore.getState().pushHistory();
          gesture = { kind: 'corner', idx: h, touchId: list[0][0] };
        } else {
          gesture = { kind: 'pan', touchId: list[0][0], startX: pos.x, startY: pos.y, basePan: { ...viewRef.current.pan } };
        }
      } else if (list.length >= 2) {
        const a = list[0][1];
        const b = list[1][1];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const { left: l, top: t, sf, zoom: z } = getLayout();
        gesture = {
          kind: 'pinch',
          baseDist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
          baseZoom: z,
          imgX: (mid.x - l) / (sf * z),
          imgY: (mid.y - t) / (sf * z),
        };
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      if (!gesture) return;
      const r = rect();
      for (const t of Array.from(e.changedTouches)) {
        touches.set(t.identifier, { x: t.clientX - r.left, y: t.clientY - r.top });
      }
      if (gesture.kind === 'pinch' && touches.size >= 2) {
        const list = [...touches.values()].slice(0, 2);
        const mid = { x: (list[0].x + list[1].x) / 2, y: (list[0].y + list[1].y) / 2 };
        const dist = Math.max(1, Math.hypot(list[0].x - list[1].x, list[0].y - list[1].y));
        const nz = Math.min(8, Math.max(0.6, (gesture.baseZoom * dist) / gesture.baseDist));
        const { sf, dw, dh } = getLayout();
        const c = containerRef2.current;
        setView(
          nz,
          {
            x: mid.x - gesture.imgX * sf * nz - (c.w - dw * nz) / 2,
            y: mid.y - gesture.imgY * sf * nz - (c.h - dh * nz) / 2,
          },
        );
      } else if (gesture.kind === 'corner') {
        const t = touches.get(gesture.touchId ?? 0);
        if (!t) return;
        const { left: l, top: t2, dw, dh, zoom: z } = getLayout();
        applyCorner(gesture.idx, { x: clamp01((t.x - l) / (dw * z)), y: clamp01((t.y - t2) / (dh * z)) });
      } else if (gesture.kind === 'pan') {
        const t = touches.get(gesture.touchId ?? 0);
        if (!t) return;
        setView(viewRef.current.zoom, { x: gesture.basePan.x + t.x - gesture.startX, y: gesture.basePan.y + t.y - gesture.startY });
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) touches.delete(t.identifier);
      if (touches.size === 0) gesture = null;
      else if (touches.size === 1 && gesture?.kind === 'pinch') gesture = null;
      e.preventDefault();
    };

    el.addEventListener('touchstart', onTouchStart, { passive: false });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: false });
    el.addEventListener('touchcancel', onTouchEnd, { passive: false });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [applyCorner, getLayout, setView]);

  // ===== 鼠标手势（桌面：拖角点 / 拖拽平移）=====
  const mouse = useRef<Gesture>(null);

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const rect = containerRef.current!.getBoundingClientRect();
    const pos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const { left: l, top: t, dw, dh, zoom: z } = getLayout();
    const cs = pageRef.current.corners.map((c) => ({ x: l + c.x * dw * z, y: t + c.y * dh * z }));
    const r = 22;
    for (let i = 0; i < 4; i++) {
      if (Math.hypot(cs[i].x - pos.x, cs[i].y - pos.y) < r) {
        useStore.getState().pushHistory();
        mouse.current = { kind: 'corner', idx: i };
        return;
      }
    }
    for (let i = 0; i < 4; i++) {
      const a = cs[i];
      const b = cs[(i + 1) % 4];
      if (Math.hypot((a.x + b.x) / 2 - pos.x, (a.y + b.y) / 2 - pos.y) < r) {
        useStore.getState().pushHistory();
        mouse.current = { kind: 'corner', idx: 4 + i };
        return;
      }
    }
    mouse.current = { kind: 'pan', startX: pos.x, startY: pos.y, basePan: { ...viewRef.current.pan } };
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const g = mouse.current;
    if (!g) return;
    const rect = containerRef.current!.getBoundingClientRect();
    const pos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    if (g.kind === 'corner') {
      const { left: l, top: t, dw, dh, zoom: z } = getLayout();
      applyCorner(g.idx, { x: clamp01((pos.x - l) / (dw * z)), y: clamp01((pos.y - t) / (dh * z)) });
    } else if (g.kind === 'pan') {
      setView(viewRef.current.zoom, { x: g.basePan.x + pos.x - g.startX, y: g.basePan.y + pos.y - g.startY });
    }
  };

  const onMouseUp = () => {
    mouse.current = null;
  };

  // 滚轮缩放（以光标为中心）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const { left: l0, top: t0, sf, zoom: z } = getLayout();
      const nz = Math.min(8, Math.max(0.6, z * Math.exp(-e.deltaY * 0.0012)));
      if (nz === z || !imgSizeRef.current) return;
      const imgX = (cx - l0) / (sf * z);
      const imgY = (cy - t0) / (sf * z);
      const c = containerRef2.current;
      const { dw, dh } = getLayout();
      setView(nz, {
        x: cx - imgX * sf * nz - (c.w - dw * nz) / 2,
        y: cy - imgY * sf * nz - (c.h - dh * nz) / 2,
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [getLayout, setView]);

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
      } catch (err) {
        console.warn('预览渲染失败', err);
      }
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [page, showPreview]);

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
        useStore.getState().toast('未识别到文档边缘，已保留当前角点', 'error');
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
      const angle = detectSkewInCanvas(cv, c);
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
  const stroke = 1.6 / z;
  const handleR = 11 / z;
  const midR = 7 / z;
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
            setView(1, { x: 0, y: 0 });
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

      {/* 画布区：触摸走原生事件，鼠标走 React 事件 */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 relative overflow-hidden touch-none select-none"
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
      >
        <div
          className="absolute"
          style={{
            left,
            top,
            width: dispW || 1,
            height: dispH || 1,
            transform: `scale(${zoom})`,
            transformOrigin: '0 0',
            boxShadow: '0 0 0 1px rgba(255,255,255,0.08)',
          }}
        >
          <canvas ref={dispCanvasRef} className="w-full h-full block" />

          {imgSize && (
            <svg
              className="absolute inset-0 w-full h-full"
              viewBox={`0 0 ${dispW} ${dispH}`}
              preserveAspectRatio="none"
              style={{ overflow: 'visible' }}
            >
              <path
                d={`M ${q[0].x * dispW} ${q[0].y * dispH} L ${q[1].x * dispW} ${q[1].y * dispH} L ${q[2].x * dispW} ${q[2].y * dispH} L ${q[3].x * dispW} ${q[3].y * dispH} Z`}
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
