import { useEffect, useRef, useState } from 'react';
import type { DraftMeta } from '../types';
import { formatDateTime } from '../utils/format';
import { IconCheck, IconEdit, IconGridDoc, IconTrash } from './icons';

interface Props {
  draft: DraftMeta;
  selectMode: boolean;
  selected: boolean;
  /** 当前处于滑开状态的卡片 id（互斥收起） */
  swipedId: number | null;
  onSwipeStart: (id: number) => void;
  onToggle: (id: number) => void;
  onOpen: (id: number) => void;
  onRename: (id: number, name: string) => void;
  onDelete: (draft: DraftMeta) => void;
}

const SWIPE_W = 72; // 左滑露出的删除按钮宽
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * 草稿卡片：
 * - Mobile：单列，缩略图左信息右；左滑露出删除（原生 touch，passive:false）
 * - PC：网格卡片，缩略图上信息下；hover 显示重命名/删除
 * - 重命名：双击名称（PC）/ 长按名称 500ms（移动），Enter/失焦提交，Esc 取消
 */
export default function DraftCard({
  draft,
  selectMode,
  selected,
  swipedId,
  onSwipeStart,
  onToggle,
  onOpen,
  onRename,
  onDelete,
}: Props) {
  const [swipe, setSwipe] = useState(0);
  const [animating, setAnimating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);
  const swipeRef = useRef(0);
  const touchRef = useRef<{ x: number; y: number; start: number; axis: 'none' | 'h' | 'v' } | null>(null);
  const suppressClick = useRef(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applySwipe = (v: number) => {
    swipeRef.current = v;
    setSwipe(v);
  };

  // 其他卡片滑开时收起自己
  useEffect(() => {
    if (swipedId !== null && swipedId !== draft.id && swipeRef.current !== 0) {
      setAnimating(true);
      applySwipe(0);
    }
  }, [swipedId, draft.id]);

  // 选择模式下滑动复位
  useEffect(() => {
    if (selectMode && swipeRef.current !== 0) {
      setAnimating(true);
      applySwipe(0);
    }
  }, [selectMode]);

  // 原生 touch：左滑露出删除（React onTouchMove 是 passive，无法 preventDefault）
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const onTouchStart = (e: TouchEvent) => {
      if (selectMode || editing) return;
      const t = e.touches[0];
      if (!t) return;
      touchRef.current = { x: t.clientX, y: t.clientY, start: swipeRef.current, axis: 'none' };
    };
    const onTouchMove = (e: TouchEvent) => {
      const tc = touchRef.current;
      if (!tc) return;
      const t = e.touches[0];
      if (!t) return;
      const dx = t.clientX - tc.x;
      const dy = t.clientY - tc.y;
      if (tc.axis === 'none') {
        if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
          tc.axis = 'h';
          setAnimating(false);
        } else if (Math.abs(dy) > 10) {
          tc.axis = 'v';
        }
      }
      if (tc.axis === 'h') {
        if (e.cancelable) e.preventDefault();
        const v = clamp(tc.start + dx, -SWIPE_W, 0);
        if (v !== swipeRef.current) {
          if (v !== 0) onSwipeStart(draft.id);
          applySwipe(v);
        }
      }
    };
    const onTouchEnd = () => {
      const tc = touchRef.current;
      touchRef.current = null;
      if (tc?.axis === 'h') {
        suppressClick.current = true;
        setTimeout(() => (suppressClick.current = false), 400);
        setAnimating(true);
        applySwipe(swipeRef.current < -SWIPE_W / 2 ? -SWIPE_W : 0);
      }
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
  }, [selectMode, editing, draft.id, onSwipeStart]);

  // 卸载清理长按计时器
  useEffect(
    () => () => {
      if (longPressTimer.current) clearTimeout(longPressTimer.current);
    },
    [],
  );

  const startEdit = () => {
    setNameDraft(draft.name);
    setEditing(true);
  };

  const clearLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const commit = () => {
    setEditing(false);
    const name = nameDraft.trim();
    if (name && name !== draft.name) onRename(draft.id, name);
  };

  const onCardClick = () => {
    if (suppressClick.current) return;
    if (selectMode) {
      onToggle(draft.id);
      return;
    }
    if (swipeRef.current !== 0) {
      setAnimating(true);
      applySwipe(0);
      return;
    }
    onOpen(draft.id);
  };

  const pageCount = draft.pageOrder.length;

  return (
    <div className="relative rounded-xl overflow-hidden">
      {/* 左滑露出的删除按钮（仅移动端） */}
      {!selectMode && !editing && (
        <button
          className="absolute inset-y-0 right-0 w-[72px] flex flex-col items-center justify-center gap-1 bg-rose-600 text-white active:bg-rose-500 sm:hidden"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(draft);
          }}
        >
          <IconTrash className="w-5 h-5" />
          <span className="text-[11px]">删除</span>
        </button>
      )}

      {/* 卡片主体（可滑动） */}
      <div
        ref={bodyRef}
        role="button"
        tabIndex={0}
        className={`group relative bg-ink-900 border rounded-xl cursor-pointer select-none ${
          selected ? 'border-accent' : 'border-ink-700 hover:border-ink-600 hover:bg-ink-900/80'
        }`}
        style={{
          transform: swipe !== 0 ? `translateX(${swipe}px)` : undefined,
          transition: animating ? 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)' : undefined,
        }}
        onClick={onCardClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !editing) onCardClick();
        }}
        title={`创建：${formatDateTime(draft.createdAt)}\n最近编辑：${formatDateTime(draft.updatedAt)}`}
      >
        <div className="flex gap-3 p-3 sm:p-2.5 sm:block">
          {/* 封面缩略图 */}
          <div className="relative shrink-0 w-24 h-32 sm:w-full sm:h-auto sm:aspect-[3/4] rounded-lg overflow-hidden bg-ink-800 border border-ink-600">
            {draft.coverThumb ? (
              <img
                src={draft.coverThumb}
                alt={draft.name}
                draggable={false}
                loading="lazy"
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center gap-1.5 text-slate-600">
                <IconGridDoc className="w-8 h-8" />
                <span className="text-[10px]">{pageCount > 0 ? `${pageCount} 页` : '空草稿'}</span>
              </div>
            )}
            {/* 多选勾选框 */}
            {selectMode && (
              <div
                className={`absolute top-1.5 left-1.5 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${
                  selected ? 'bg-accent border-accent' : 'bg-ink-950/70 border-slate-400'
                }`}
              >
                {selected && <IconCheck className="w-3 h-3 text-white" />}
              </div>
            )}
            {/* PC hover 操作按钮 */}
            {!selectMode && !editing && (
              <div className="hidden sm:flex absolute top-1.5 right-1.5 gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  className="w-6 h-6 rounded bg-ink-950/85 border border-white/10 text-slate-200 hover:border-accent hover:text-accent flex items-center justify-center"
                  title="重命名"
                  onClick={(e) => {
                    e.stopPropagation();
                    startEdit();
                  }}
                >
                  <IconEdit className="w-3.5 h-3.5" />
                </button>
                <button
                  className="w-6 h-6 rounded bg-ink-950/85 border border-white/10 text-rose-300 hover:border-rose-500 hover:bg-rose-950/60 flex items-center justify-center"
                  title="删除草稿"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(draft);
                  }}
                >
                  <IconTrash className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
            {/* 移动端页数徽章（PC 信息区已有） */}
            {!selectMode && pageCount > 0 && (
              <span className="sm:hidden absolute bottom-1 left-1 rounded bg-ink-950/85 border border-white/10 px-1.5 text-[10px] leading-4 text-slate-200">
                {pageCount} 页
              </span>
            )}
          </div>

          {/* 信息区 */}
          <div className="flex-1 min-w-0 sm:pt-2.5">
            {editing ? (
              <input
                autoFocus
                onFocus={(e) => e.currentTarget.select()}
                className="w-full min-w-0 bg-ink-800 border border-accent/60 rounded px-1.5 py-1 text-sm text-slate-200 outline-none"
                value={nameDraft}
                maxLength={60}
                onChange={(e) => setNameDraft(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onBlur={commit}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') commit();
                  if (e.key === 'Escape') setEditing(false);
                }}
              />
            ) : (
              <span
                className="block truncate text-sm font-medium text-slate-200 cursor-text"
                title="点击重命名"
                onClick={(e) => {
                  // PRD：点击名称重命名（行内编辑）；阻止冒泡避免触发卡片「打开」
                  e.stopPropagation();
                  startEdit();
                }}
                onTouchStart={() => {
                  clearLongPress();
                  longPressTimer.current = setTimeout(() => {
                    suppressClick.current = true;
                    setTimeout(() => (suppressClick.current = false), 400);
                    startEdit();
                  }, 500);
                }}
                onTouchEnd={clearLongPress}
                onTouchMove={clearLongPress}
                onTouchCancel={clearLongPress}
              >
                {draft.name}
              </span>
            )}
            <div className="mt-1 sm:mt-0.5 flex items-center gap-2 text-xs text-slate-500">
              <span>{formatDateTime(draft.createdAt)}</span>
            </div>
            <div className="hidden sm:block mt-0.5 text-xs text-slate-600">{pageCount} 页</div>
          </div>
        </div>
      </div>
    </div>
  );
}
