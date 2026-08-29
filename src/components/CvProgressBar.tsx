import { useEffect, useState } from 'react';
import { onCvLoadState, loadOpenCV, type CvLoadState } from '../utils/opencvLoader';

/** OpenCV 加载进度条：下载百分比 → 初始化提示 → 完成淡出；失败可重试 */
export default function CvProgressBar() {
  const [s, setS] = useState<CvLoadState>({ status: 'idle', progress: 0 });
  const [hidden, setHidden] = useState(false);

  useEffect(() => onCvLoadState(setS), []);

  useEffect(() => {
    if (s.status === 'ready') {
      const t = setTimeout(() => setHidden(true), 900);
      return () => clearTimeout(t);
    }
    if (s.status !== 'idle') setHidden(false);
  }, [s.status]);

  if (s.status === 'idle' || hidden) return null;

  return (
    <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[85] w-[86vw] max-w-sm safe-bottom">
      <div className="rounded-xl bg-ink-800/95 border border-ink-600 shadow-2xl px-4 py-3 flex flex-col gap-2">
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-300">
            {s.status === 'downloading' && '正在加载图像引擎（约 10MB，仅首次）'}
            {s.status === 'initializing' && '正在初始化图像引擎…'}
            {s.status === 'error' && `图像引擎加载失败：${s.error ?? ''}`}
            {s.status === 'ready' && '✅ 图像引擎已就绪'}
          </span>
          {s.status === 'downloading' && <span className="tabular-nums text-accent font-semibold">{s.progress}%</span>}
        </div>
        {(s.status === 'downloading' || s.status === 'initializing') && (
          <div className="h-1.5 rounded bg-ink-600 overflow-hidden">
            <div
              className={`h-full bg-accent transition-all duration-200 ${s.status === 'initializing' ? 'animate-pulse w-full' : ''}`}
              style={{ width: `${s.progress}%` }}
            />
          </div>
        )}
        {s.status === 'error' && (
          <button className="btn-primary text-xs self-start" onClick={() => void loadOpenCV().catch(() => {})}>
            重试
          </button>
        )}
      </div>
    </div>
  );
}
