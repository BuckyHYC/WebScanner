import { useRef } from 'react';
import { useStore } from '../store/useStore';
import { clearDraft } from '../utils/idb';
import { importFiles } from '../utils/importer';

interface Props {
  draftRestored: boolean;
  onDraftSeen: () => void;
}

export default function Home({ draftRestored, onDraftSeen }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const setCameraOpen = useStore((s) => s.setCameraOpen);
  const pages = useStore((s) => s.pages);
  const toast = useStore((s) => s.toast);

  return (
    <div className="h-full flex flex-col items-center justify-center px-6 gap-6 overflow-y-auto py-6">
      <div className="text-center">
        <div className="text-4xl font-bold mb-2">
          智能<span className="text-accent">扫描</span>
        </div>
        <p className="text-slate-400 text-sm">
          边缘检测 · 透视矫正 · 滤镜增强 · 导出 PDF/JPG
          <br />
          全程本地处理，图片不会上传
        </p>
      </div>

      {draftRestored && pages.length > 0 && (
        <div className="w-full max-w-md flex items-center justify-between rounded-xl bg-ink-800 border border-ink-600 px-4 py-3">
          <span className="text-sm">已恢复上次草稿（{pages.length} 页）</span>
          <button
            className="btn-ghost text-rose-400 text-xs"
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

      <div className="flex flex-col sm:flex-row gap-3">
        <button className="btn-primary px-6 py-3 text-base" onClick={() => inputRef.current?.click()}>
          📁 选择图片
        </button>
        <button className="btn-panel px-6 py-3 text-base" onClick={() => setCameraOpen(true)}>
          📷 拍照扫描
        </button>
        {pages.length > 0 && (
          <button className="btn-ghost px-6 py-3 text-base" onClick={() => useStore.getState().setView('editor')}>
            ✏️ 继续编辑（{pages.length} 页）
          </button>
        )}
      </div>

      <div className="text-xs text-slate-500 text-center leading-5">
        支持 JPG / PNG / WebP / BMP / GIF / TIFF / HEIC · 多选 · 拖入窗口 · Ctrl+V 粘贴
        <br />
        摄像头功能仅在 <b>localhost 或 HTTPS</b> 下可用
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
