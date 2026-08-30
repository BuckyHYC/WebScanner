import { useRef } from 'react';
import { useStore } from '../store/useStore';
import { clearDraft } from '../utils/idb';
import { importFiles } from '../utils/importer';

interface Props {
  draftRestored: boolean;
  onDraftSeen: () => void;
}

/* ===== 内联 SVG 图标（统一 1.7 描边风格）===== */
const IconImage = ({ className = 'w-5 h-5' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <circle cx="9" cy="10" r="1.7" />
    <path d="M3.5 17.5l4.5-4.5 4 4 3-3 5.5 5.5" />
  </svg>
);

const IconCamera = ({ className = 'w-5 h-5' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M4 7.5h3l1.6-2.3h6.8L17 7.5h3A1.5 1.5 0 0 1 21.5 9v9A1.5 1.5 0 0 1 20 19.5H4A1.5 1.5 0 0 1 2.5 18V9A1.5 1.5 0 0 1 4 7.5z" />
    <circle cx="12" cy="13" r="3.2" />
  </svg>
);

const IconEdit = ({ className = 'w-5 h-5' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M4.5 19.5l.9-3.6L16.6 4.7a1.8 1.8 0 0 1 2.6 0l.1.1a1.8 1.8 0 0 1 0 2.6L8.1 18.6l-3.6.9z" />
    <path d="M14.5 6.8l2.7 2.7" />
  </svg>
);

const IconLock = ({ className = 'w-3.5 h-3.5' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </svg>
);

/** 签名视觉：文档取景框 + 扫描线（呼应边缘检测核心） */
function ViewFinder() {
  return (
    <div className="relative w-56 h-40 sm:w-64 sm:h-44" aria-hidden="true">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" fill="none" className="absolute inset-0 w-full h-full">
        {/* 四角取景角标 */}
        <path d="M6 26V12a6 6 0 0 1 6-6h14" stroke="#2f81f7" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M74 6h14a6 6 0 0 1 6 6v14" stroke="#2f81f7" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M94 74v14a6 6 0 0 1-6 6H74" stroke="#2f81f7" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M26 94H12a6 6 0 0 1-6-6V74" stroke="#2f81f7" strokeWidth="1.6" strokeLinecap="round" />
        {/* 文档内容横线 */}
        <path
          d="M24 34h30M24 45h52M24 56h38M24 67h48M24 78h26"
          stroke="#31405a"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
      </svg>
      {/* 扫描线 */}
      <div className="scan-line absolute left-[8%] right-[8%] top-[10%] h-[2px] rounded-full bg-accent/80 shadow-[0_1px_10px_rgba(47,129,247,0.9)]" />
    </div>
  );
}

const FORMATS = ['JPG', 'PNG', 'WebP', 'BMP', 'GIF', 'TIFF', 'HEIC'];

export default function Home({ draftRestored, onDraftSeen }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const setCameraOpen = useStore((s) => s.setCameraOpen);
  const pages = useStore((s) => s.pages);
  const toast = useStore((s) => s.toast);

  return (
    <div className="h-full flex flex-col items-center justify-center gap-7 px-6 py-8 overflow-y-auto">
      {/* 草稿恢复提示 */}
      {draftRestored && pages.length > 0 && (
        <div className="w-full max-w-md flex items-center justify-between rounded-xl bg-ink-800 border border-ink-600 px-4 py-3">
          <span className="text-sm">已恢复上次草稿（{pages.length} 页）</span>
          <button
            className="btn-ghost text-rose-400 text-xs focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-ink-950"
            onClick={async () => {
              await clearDraft();
              useStore.setState({ pages: [], view: 'home' });
              onDraftSeen();
              toast('草稿已清空');
            }}
          >
            清空
          </button>
        </div>
      )}

      {/* 主视觉：取景框 + 标题 */}
      <div className="flex flex-col items-center gap-5">
        <ViewFinder />
        <div className="text-center">
          <h1 className="text-5xl sm:text-6xl font-extrabold tracking-tight text-slate-100">
            智能<span className="text-accent">扫描</span>
          </h1>
          <p className="mt-4 text-sm sm:text-base text-slate-400 tracking-wide">
            边缘检测 · 透视矫正 · 滤镜增强 · 导出 PDF/JPG
          </p>
          <p className="mt-2 text-xs sm:text-sm text-slate-500 flex items-center justify-center gap-1.5">
            <IconLock />
            全程本地处理，图片不会上传
          </p>
        </div>
      </div>

      {/* 主操作 */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 w-full max-w-md sm:w-auto">
        <button
          className="btn-primary px-8 py-3.5 text-base rounded-xl shadow-lg shadow-accent/25 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-ink-950"
          onClick={() => inputRef.current?.click()}
        >
          <IconImage className="w-[18px] h-[18px]" />
          选择图片
        </button>
        <button
          className="btn px-8 py-3.5 text-base rounded-xl border border-accent/60 text-accent hover:bg-accent/10 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-ink-950"
          onClick={() => setCameraOpen(true)}
        >
          <IconCamera className="w-[18px] h-[18px]" />
          拍照扫描
        </button>
        {pages.length > 0 && (
          <button
            className="btn-ghost px-6 py-3.5 text-base rounded-xl focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-ink-950"
            onClick={() => useStore.getState().setView('editor')}
          >
            <IconEdit className="w-[18px] h-[18px]" />
            继续编辑（{pages.length} 页）
          </button>
        )}
      </div>

      {/* 支持格式与导入方式 */}
      <div className="flex flex-col items-center gap-2.5">
        <div className="flex flex-wrap justify-center gap-1.5">
          {FORMATS.map((f) => (
            <span
              key={f}
              className="rounded-md bg-ink-800 border border-ink-700 px-2 py-0.5 text-[10px] font-medium tracking-wide text-slate-400"
            >
              {f}
            </span>
          ))}
        </div>
        <p className="text-[11px] text-slate-500 text-center">
          支持多选 · 拖入窗口 · Ctrl+V 粘贴
        </p>
        <p className="text-[11px] text-slate-500 text-center">
          摄像头功能仅在 <span className="text-slate-400 font-medium">localhost 或 HTTPS</span> 下可用
        </p>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*,.heic,.heif,.tif,.tiff"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length > 0) void importFiles(files);
          e.target.value = '';
        }}
      />
    </div>
  );
}
