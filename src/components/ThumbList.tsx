import { useRef, useState } from 'react';
import { useStore, filterLabel } from '../store/useStore';
import type { Page } from '../types';

interface Props {
  direction: 'vertical' | 'horizontal';
  className?: string;
}

/** 页面缩略图列表：支持拖拽排序（PC）、复制/删除/插入（需求：多页管理） */
export default function ThumbList({ direction, className = '' }: Props) {
  const pages = useStore((s) => s.pages);
  const current = useStore((s) => s.current);
  const dragFrom = useRef<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  if (pages.length === 0) return null;

  return (
    <div className={className}>
      {pages.map((p: Page, i: number) => (
        <div
          key={p.id}
          className={`relative shrink-0 ${
            direction === 'vertical' ? 'w-full px-2 py-1' : 'w-20'
          } ${i === current ? 'ring-2 ring-accent rounded-lg' : ''}`}
          draggable={direction === 'vertical'}
          onDragStart={(e) => {
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
          onClick={() => useStore.getState().setCurrent(i)}
          role="button"
        >
          <div className="relative group cursor-pointer">
            <img
              src={p.thumb}
              alt={p.name}
              className={`rounded-md border border-ink-600 object-cover bg-white/5 ${
                direction === 'vertical' ? 'w-full h-28' : 'w-20 h-28'
              }`}
            />
            <span className="absolute top-1 left-1 rounded bg-black/70 px-1.5 text-[10px] leading-4 text-slate-200">
              {i + 1}
            </span>
            <span className="absolute bottom-1 left-1 rounded bg-accent/90 px-1.5 text-[10px] leading-4 text-white">
              {p.filterName}
            </span>
            {/* 操作按钮 */}
            <div
              className={`absolute top-1 right-1 flex flex-col gap-0.5 ${
                direction === 'vertical' ? 'opacity-0 group-hover:opacity-100' : 'opacity-90'
              } transition-opacity`}
            >
              <button
                className="rounded bg-black/70 w-5 h-5 text-[10px] leading-5 text-slate-200 hover:bg-ink-600"
                title="复制页"
                onClick={(e) => {
                  e.stopPropagation();
                  useStore.getState().duplicatePage(i);
                }}
              >
                ⧉
              </button>
              <button
                className="rounded bg-black/70 w-5 h-5 text-[10px] leading-5 text-rose-300 hover:bg-rose-900"
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
                  className="rounded bg-black/70 w-5 h-5 text-[10px] leading-5 hover:bg-ink-600 disabled:opacity-30"
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
          {/* 插入指示线（拖拽悬停时） */}
          {direction === 'vertical' && dragOver === i && dragFrom.current !== null && dragFrom.current !== i && (
            <div className={`absolute left-1 right-1 h-0.5 bg-accent ${i > (dragFrom.current ?? 0) ? '-bottom-0.5' : '-top-0.5'}`} />
          )}
        </div>
      ))}
      {/* 横向列表末尾添加按钮 */}
      {direction === 'horizontal' && (
        <button
          className="w-20 h-28 shrink-0 rounded-md border border-dashed border-ink-600 text-slate-500 hover:border-accent hover:text-accent text-2xl"
          onClick={() => document.getElementById('ws-file-input')?.click()}
          title="添加图片"
        >
          ＋
        </button>
      )}
    </div>
  );
}
