import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore, filterLabel } from '../store/useStore';
import type { Page } from '../types';

interface Props {
  direction: 'vertical' | 'horizontal';
  className?: string;
}

interface DragState {
  from: number; // 被拖项原始索引
  drop: number; // 当前插入位置
  left: number; // 浮层当前 left（相对滚动内容）
  top: number;
  settling: boolean; // 松手吸附动画中
}

const LONG_PRESS_MS = 500;
const MOVE_THRESHOLD = 8; // 长按判定内允许的位移
const ITEM_W = 80; // 横向缩略图宽
const ITEM_H = 112;
const GAP = 8;
const EDGE_ZONE = 44; // 边缘自动滚动触发区
const SCROLL_STEP = 14;

/**
 * 页面缩略图列表。
 * - vertical（PC 左栏）：HTML5 拖拽排序 + 插入指示线
 * - horizontal（移动底部栏 / PC 底部栏）：指针拖拽——
 *   移动端长按 500ms 触发、PC 鼠标直接拖；浮层跟随 + 虚线占位符
 *   实时插入指示 + 松手吸附动画 + 边缘自动滚动 + 移出取消 + 短按选中页
 */
export default function ThumbList({ direction, className = '' }: Props) {
  const pages = useStore((s) => s.pages);
  const current = useStore((s) => s.current);

  // ---- vertical: 原生拖拽 ----
  const dragFrom = useRef<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  // ---- horizontal: 指针拖拽 ----
  const scrollRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [drag, setDrag] = useState<DragState | null>(null);
  // 拖拽状态 ref 镜像：pointermove 高频更新与 pointerup 同 tick 时，
  // state 可能未重渲染（闭包 stale），逻辑一律读 ref
  const dragRef = useRef<DragState | null>(null);
  const setDragBoth = (d: DragState | null) => {
    dragRef.current = d;
    setDrag(d);
  };
  const pointerRef = useRef<{
    from: number;
    cx: number; // 指针相对滚动内容的坐标（含 scrollLeft）
    cy: number;
    startCx: number;
    startCy: number;
    baseLeft: number;
    baseTop: number;
    moved: boolean;
    clientX: number;
    clientY: number;
  } | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number>(0);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // pointercancel（touch）后 touch 事件流可能中断的兜底：350ms 内若无
  // touchmove/touchend 续命，就用最后坐标完成排序，避免浮层卡死
  const touchFallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (pages.length === 0) return null;

  /** 计算插入位置：内容坐标 x 落在哪个 item 间隔 */
  const calcDrop = useCallback((cx: number, count: number, from: number): number => {
    const pitch = ITEM_W + GAP;
    let idx = 0;
    for (let i = 0; i < count; i++) {
      if (i === from) continue;
      const r = itemRefs.current[i];
      if (!r) continue;
      const left = r.offsetLeft;
      if (cx < left + ITEM_W / 2) {
        idx = i;
        break;
      }
      idx = i + 1;
    }
    return Math.min(idx, count - 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages.length]);

  /** 进入拖拽（长按达成 / PC 直接按下） */
  const startDrag = useCallback(
    (from: number, cx: number, cy: number, clientX: number, clientY: number) => {
      const el = itemRefs.current[from];
      if (!el) return;
      pointerRef.current = {
        from,
        cx,
        cy,
        startCx: cx,
        startCy: cy,
        baseLeft: el.offsetLeft,
        baseTop: el.offsetTop,
        moved: false,
        clientX,
        clientY,
      };
      setDragBoth({ from, drop: from, left: el.offsetLeft, top: el.offsetTop, settling: false });
    },
    [],
  );

  const clearLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse') return; // touch/pen 走原生 touch 路径（pointercancel 后事件会断）
    if ((e.target as HTMLElement).closest('button')) return; // 操作按钮不触发拖拽
    const el = scrollRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = e.clientX - rect.left + el.scrollLeft;
    const cy = e.clientY - rect.top;
    const from = (e.target as HTMLElement).closest('[data-idx]')?.getAttribute('data-idx');
    if (from === null || from === undefined) return;
    const fromIdx = Number(from);
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    startDrag(fromIdx, cx, cy, e.clientX, e.clientY);
  };

  /** 更新指针坐标并刷新浮层/drop（mouse 与 touch 共用） */
  const updatePointer = useCallback((cx: number, cy: number, clientX: number, clientY: number) => {
    const ptr = pointerRef.current;
    if (!ptr) return;
    ptr.cx = cx;
    ptr.cy = cy;
    ptr.clientX = clientX;
    ptr.clientY = clientY;
    const cur = dragRef.current;
    if (!cur) {
      // 长按期间位移过大 → 视为滚动/取消长按
      if (Math.hypot(cx - ptr.startCx, cy - ptr.startCy) > MOVE_THRESHOLD) {
        ptr.moved = true;
        clearLongPress();
      }
      return;
    }
    if (cur.settling) return; // 吸附动画中不再移动浮层
    // touch 流还活着（touchmove 到达）→ 续命兜底定时器，等 touchend 正常定案
    if (touchFallbackTimer.current) {
      clearTimeout(touchFallbackTimer.current);
      touchFallbackTimer.current = null;
    }
    const drop = calcDrop(cx, pages.length, ptr.from);
    setDragBoth({ ...cur, left: ptr.baseLeft + (cx - ptr.startCx), top: ptr.baseTop + (cy - ptr.startCy), drop });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages.length]);

  /** 结束拖拽：短按选中 / 排序。
   * - mouse（PC）：保留 280ms 吸附动画后排序（原行为，不变）
   * - touch（移动端）：松手立即到位，无动画（用户要求） */
  const finishDrag = useCallback((immediate = false) => {
    clearLongPress();
    const ptr = pointerRef.current;
    if (!ptr) return;
    const d = dragRef.current;
    if (!d) {
      // 短按（未达长按/未移动）→ 选中该页
      if (!ptr.moved) useStore.getState().setCurrent(ptr.from);
      pointerRef.current = null;
      return;
    }
    const dropEl = itemRefs.current[d.drop];
    const from = ptr.from;
    const drop = d.drop;
    pointerRef.current = null;
    if (drop === from) {
      setDragBoth(null);
      return;
    }
    if (immediate) {
      // 移动端：直接排序，浮层立即消失
      setDragBoth(null);
      useStore.getState().movePage(from, drop);
      return;
    }
    // PC：吸附动画后排序
    setDragBoth(d ? { ...d, settling: true, left: dropEl?.offsetLeft ?? d.left, top: dropEl?.offsetTop ?? d.top } : d);
    settleTimer.current = setTimeout(() => {
      settleTimer.current = null;
      setDragBoth(null);
      if (drop !== from) useStore.getState().movePage(from, drop);
    }, reducedMotion ? 0 : 280);
  }, [reducedMotion]);

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' && e.pointerType !== 'touch') return;
    const el = scrollRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    updatePointer(e.clientX - rect.left + el.scrollLeft, e.clientY - rect.top, e.clientX, e.clientY);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse') return;
    finishDrag();
  };

  // 原生 touch 路径：长按 500ms 触发拖拽。滚动容器是 touch-pan-x，
  // 浏览器可能在 touchstart 时就把手势锁定为横向滚动并派发 pointercancel
  // （pointer 事件流就此中断），而 touch 事件流会继续——所以拖拽跟踪用原生 touch。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || direction !== 'horizontal') return;
    const rectOf = () => el.getBoundingClientRect();
    const onTouchStart = (e: TouchEvent) => {
      if ((e.target as HTMLElement).closest('button')) return;
      const t = e.touches[0];
      if (!t) return;
      const rect = rectOf();
      const from = (e.target as HTMLElement).closest('[data-idx]')?.getAttribute('data-idx');
      if (from === null || from === undefined) return;
      const fromIdx = Number(from);
      const cx = t.clientX - rect.left + el.scrollLeft;
      const cy = t.clientY - rect.top;
      clearLongPress();
      pointerRef.current = {
        from: fromIdx, cx, cy, startCx: cx, startCy: cy,
        baseLeft: itemRefs.current[fromIdx]?.offsetLeft ?? 0,
        baseTop: itemRefs.current[fromIdx]?.offsetTop ?? 0,
        moved: false, clientX: t.clientX, clientY: t.clientY,
      };
      longPressTimer.current = setTimeout(() => {
        longPressTimer.current = null;
        if (!pointerRef.current || pointerRef.current.moved) return;
        const ptr = pointerRef.current;
        startDrag(fromIdx, ptr.cx, ptr.cy, ptr.clientX, ptr.clientY);
      }, LONG_PRESS_MS);
    };
    const onTouchMove = (e: TouchEvent) => {
      const ptr = pointerRef.current;
      if (!ptr) return;
      const t = e.touches[0];
      if (!t) return;
      if (touchFallbackTimer.current) {
        clearTimeout(touchFallbackTimer.current);
        touchFallbackTimer.current = null;
      }
      if (e.cancelable) e.preventDefault(); // 尽力阻止浏览器滚动
      const rect = rectOf();
      updatePointer(t.clientX - rect.left + el.scrollLeft, t.clientY - rect.top, t.clientX, t.clientY);
    };
    const onTouchEnd = () => {
      if (touchFallbackTimer.current) {
        clearTimeout(touchFallbackTimer.current);
        touchFallbackTimer.current = null;
      }
      finishDrag(true);
    };
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    el.addEventListener('touchcancel', onTouchEnd);
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages.length, direction]);

  // 拖拽激活期间：document 级捕获监听，确保松手事件不因目标变化/冒泡中断而丢失。
  // - touchend/touchcancel：正常松手 → 完成排序
  // - pointerup（touch）：事件流未断时也会到达 → 完成排序
  // - pointercancel（touch）：浏览器抢手势，touch 流可能继续（等 touchend）
  //   也可能中断 → 启动兜底定时器，150ms 无续命则用最后坐标定案
  useEffect(() => {
    if (!drag || drag.settling) return;
    const startFallback = () => {
      if (touchFallbackTimer.current) clearTimeout(touchFallbackTimer.current);
      touchFallbackTimer.current = setTimeout(() => {
        touchFallbackTimer.current = null;
        finishDrag(true);
      }, 150);
    };
    const onTouchEnd = () => {
      if (touchFallbackTimer.current) {
        clearTimeout(touchFallbackTimer.current);
        touchFallbackTimer.current = null;
      }
      finishDrag(true);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return; // mouse 由组件内 React endDrag 处理
      onTouchEnd();
    };
    const onPointerCancel = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') {
        cancelDrag();
        return;
      }
      startFallback();
    };
    document.addEventListener('touchend', onTouchEnd, true);
    document.addEventListener('touchcancel', onTouchEnd, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('pointercancel', onPointerCancel, true);
    return () => {
      document.removeEventListener('touchend', onTouchEnd, true);
      document.removeEventListener('touchcancel', onTouchEnd, true);
      document.removeEventListener('pointerup', onPointerUp, true);
      document.removeEventListener('pointercancel', onPointerCancel, true);
      if (touchFallbackTimer.current) {
        clearTimeout(touchFallbackTimer.current);
        touchFallbackTimer.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, reducedMotion]);

  const cancelDrag = () => {
    clearLongPress();
    if (settleTimer.current) {
      clearTimeout(settleTimer.current);
      settleTimer.current = null;
    }
    if (touchFallbackTimer.current) {
      clearTimeout(touchFallbackTimer.current);
      touchFallbackTimer.current = null;
    }
    pointerRef.current = null;
    setDragBoth(null);
  };

  // 拖拽中：边缘自动滚动（rAF 循环，手指停在边缘也持续滚动）+ 移出过远取消
  useEffect(() => {
    if (!drag || drag.settling) return;
    const el = scrollRef.current;
    if (!el) return;
    const loop = () => {
      const ptr = pointerRef.current;
      if (!ptr || !el) return;
      const rect = el.getBoundingClientRect();
      let scrolled = false;
      if (ptr.clientX < rect.left + EDGE_ZONE) {
        el.scrollLeft = Math.max(0, el.scrollLeft - SCROLL_STEP);
        scrolled = true;
      } else if (ptr.clientX > rect.right - EDGE_ZONE) {
        el.scrollLeft += SCROLL_STEP;
        scrolled = true;
      }
      if (scrolled) {
        const cx = ptr.clientX - rect.left + el.scrollLeft;
        ptr.cx = cx;
        const cur = dragRef.current;
        if (cur) setDragBoth({ ...cur, left: ptr.baseLeft + (cx - ptr.startCx), top: ptr.baseTop + (ptr.cy - ptr.startCy), drop: calcDrop(cx, pages.length, ptr.from) });
      }
      // 移出容器太远 → 取消拖拽
      if (ptr.clientX < rect.left - 120 || ptr.clientX > rect.right + 120 || ptr.clientY < rect.top - 120 || ptr.clientY > rect.bottom + 120) {
        cancelDrag();
        return;
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.settling, drag?.from]);

  // 拖拽中阻止移动端原生横向滚动：手势抢占发生在 compositor 层，
  // 仅靠 touchmove preventDefault 来不及——须动态改为 touch-action:none 让浏览器不抢手势
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (drag) {
      el.style.touchAction = 'none';
      const onTouchMove = (ev: TouchEvent) => {
        if (ev.cancelable) ev.preventDefault();
      };
      el.addEventListener('touchmove', onTouchMove, { passive: false });
      return () => el.removeEventListener('touchmove', onTouchMove);
    }
    el.style.touchAction = '';
    return undefined;
  }, [drag]);

  // 卸载清理
  useEffect(
    () => () => {
      clearLongPress();
      if (settleTimer.current) clearTimeout(settleTimer.current);
      if (touchFallbackTimer.current) clearTimeout(touchFallbackTimer.current);
      cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  const isDragging = drag !== null && !drag.settling;

  const renderItem = (p: Page, i: number) => (
    <div
      key={p.id}
      data-idx={i}
      ref={(el) => {
        itemRefs.current[i] = el;
      }}
      className={`relative shrink-0 select-none [-webkit-touch-callout:none] ${
        direction === 'vertical' ? 'w-full px-2 py-1' : 'w-20'
      } ${
        i === current && !drag ? 'ring-2 ring-accent rounded-lg shadow-lg shadow-black/30' : ''
      }`}
      draggable={direction === 'vertical'}
      onDragStart={(e) => {
        if (direction !== 'vertical') return;
        dragFrom.current = i;
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={(e) => {
        if (direction !== 'vertical') return;
        e.preventDefault();
        setDragOver(i);
      }}
      onDragLeave={() => setDragOver(null)}
      onDrop={(e) => {
        e.preventDefault();
        if (direction === 'vertical' && dragFrom.current !== null && dragFrom.current !== i) {
          useStore.getState().movePage(dragFrom.current, i);
        }
        dragFrom.current = null;
        setDragOver(null);
      }}
      onClick={() => {
        if (direction === 'vertical') useStore.getState().setCurrent(i);
      }}
      role="button"
    >
      <div className="relative group cursor-pointer">
        <img
          src={p.thumb}
          alt={p.name}
          draggable={false}
          className={`rounded-md border border-ink-600 object-cover bg-white/5 transition-colors group-hover:border-ink-700 ${
            direction === 'vertical' ? 'w-full h-28' : 'w-20 h-28'
          }`}
        />
        <span className="absolute top-1 left-1 rounded bg-ink-950/85 border border-white/10 px-1.5 text-[10px] leading-4 text-slate-200">
          {i + 1}
        </span>
        <span className="absolute bottom-1 left-1 rounded bg-accent px-1.5 text-[10px] leading-4 text-white shadow-sm shadow-accent/40">
          {p.filterName}
        </span>
        {/* 操作按钮 */}
        <div
          className={`absolute top-1 right-1 flex flex-col gap-0.5 ${
            direction === 'vertical' ? 'opacity-0 group-hover:opacity-100' : 'opacity-90'
          } transition-opacity`}
        >
          <button
            className="rounded bg-ink-950/85 border border-white/10 w-5 h-5 text-[10px] leading-5 text-slate-200 hover:border-accent hover:text-accent"
            title="复制页"
            onClick={(e) => {
              e.stopPropagation();
              useStore.getState().duplicatePage(i);
            }}
          >
            ⧉
          </button>
          <button
            className="rounded bg-ink-950/85 border border-white/10 w-5 h-5 text-[10px] leading-5 text-rose-300 hover:border-rose-500 hover:bg-rose-950/60"
            title="删除页"
            onClick={(e) => {
              e.stopPropagation();
              useStore.getState().removePage(i);
            }}
          >
            ✕
          </button>
        </div>
        {/* 上/下移（移动端与键盘替代拖拽） */}
        {direction === 'vertical' && (
          <div className="absolute bottom-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              className="rounded bg-ink-950/85 border border-white/10 w-5 h-5 text-[10px] leading-5 hover:border-accent hover:text-accent disabled:opacity-30"
              disabled={i === 0}
              title="前移"
              onClick={(e) => {
                e.stopPropagation();
                useStore.getState().movePage(i, i - 1);
              }}
            >
              ↑
            </button>
            <button
              className="rounded bg-black/70 w-5 h-5 text-[10px] leading-5 hover:bg-ink-600 disabled:opacity-30"
              disabled={i === pages.length - 1}
              title="后移"
              onClick={(e) => {
                e.stopPropagation();
                useStore.getState().movePage(i, i + 1);
              }}
            >
              ↓
            </button>
          </div>
        )}
      </div>
      {/* 插入指示线（vertical 拖拽悬停时） */}
      {direction === 'vertical' && dragOver === i && dragFrom.current !== null && dragFrom.current !== i && (
        <div className={`absolute left-1 right-1 h-0.5 bg-accent ${i > (dragFrom.current ?? 0) ? '-bottom-0.5' : '-top-0.5'}`} />
      )}
    </div>
  );

  // ===== horizontal：拖拽渲染（占位符 + 浮层） =====
  const renderHorizontal = () => {
    const items: React.ReactNode[] = [];
    for (let i = 0; i < pages.length; i++) {
      // 拖拽中：在插入位置放占位符，跳过被拖项
      if (isDragging && drag!.drop === i) {
        items.push(
          <div
            key={`ph-${i}`}
            className="w-20 shrink-0 rounded-md border-2 border-dashed border-accent/70 bg-accent/10"
            style={{ height: ITEM_H }}
          />,
        );
      }
      if (isDragging && drag!.from === i) continue;
      items.push(renderItem(pages[i], i));
    }
    return items;
  };

  return (
    <div
      ref={scrollRef}
      className={`${className} ${direction === 'horizontal' ? 'relative touch-pan-x' : ''}`}
      onPointerDown={direction === 'horizontal' ? onPointerDown : undefined}
      onPointerMove={direction === 'horizontal' ? onPointerMove : undefined}
      onPointerUp={direction === 'horizontal' ? endDrag : undefined}
      onPointerCancel={
        direction === 'horizontal'
          ? (e) => {
              // touch 的 pointercancel 是浏览器抢占滚动手势：touch 事件流可能
              // 继续（等 touchend 完成排序），也可能中断（由 document 监听里的
              // 兜底定时器定案）。这里不直接排序，避免移动中途提前定案。
              // mouse 的 cancel 才是真取消。
              if (e.pointerType === 'mouse') cancelDrag();
            }
          : undefined
      }
      style={direction === 'horizontal' && isDragging ? { cursor: 'grabbing' } : undefined}
    >
      {direction === 'vertical' ? (
        pages.map((p, i) => renderItem(p, i))
      ) : (
        <>
          {renderHorizontal()}
          {/* 横向列表末尾添加按钮 */}
          {!drag && (
            <button
              className="w-20 h-28 shrink-0 rounded-md border border-dashed border-ink-600 text-slate-500 hover:border-accent hover:text-accent text-2xl"
              onClick={() => document.getElementById('ws-file-input')?.click()}
              title="添加图片"
            >
              ＋
            </button>
          )}
          {/* 拖拽浮层（跟随指针） */}
          {drag && (
            <div
              className="absolute z-10 rounded-lg shadow-2xl shadow-black/50 ring-1 ring-accent/60"
              style={{
                left: drag.left,
                top: drag.top,
                width: ITEM_W,
                height: ITEM_H,
                pointerEvents: 'none',
                opacity: 0.92,
                transform: `scale(${drag.settling ? 1.02 : 1.06})`,
                transition: drag.settling
                  ? `left 260ms cubic-bezier(0.22, 1, 0.36, 1), top 260ms cubic-bezier(0.22, 1, 0.36, 1), transform 260ms cubic-bezier(0.22, 1, 0.36, 1)`
                  : 'none',
              }}
            >
              <img
                src={pages[drag.from]?.thumb}
                alt=""
                className="w-full h-full rounded-lg object-cover bg-white/5"
                draggable={false}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
