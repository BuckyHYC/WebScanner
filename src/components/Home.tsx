import { useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { importFiles } from '../utils/importer';
import { clearAllDrafts, deleteDrafts, renameDraft } from '../utils/draftsDb';
import { openEditorRoute } from '../utils/router';
import type { DraftMeta } from '../types';
import DraftCard from './DraftCard';
import ConfirmModal from './ConfirmModal';
import { IconImage, IconCamera, IconTrash, IconChevronDown } from './icons';

/* ===== 内联 SVG 图标（统一 1.7 描边风格）===== */
const IconLock = ({ className = 'w-5 h-5' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </svg>
);

/** 签名视觉：文档取景框 + 扫描线（呼应边缘检测核心）——纵向文档比例，避免拉伸变扁 */
function ViewFinder() {
  return (
    <div className="relative w-44 h-56 sm:w-48 sm:h-64" aria-hidden="true">
      <svg viewBox="0 0 100 128" preserveAspectRatio="none" fill="none" className="absolute inset-0 w-full h-full">
        {/* 四角取景角标（纵向文档，x∈[10,90]、y∈[14,114]） */}
        <path d="M10 28V20a6 6 0 0 1 6-6h16" stroke="#2f81f7" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M74 14h16a6 6 0 0 1 6 6v14" stroke="#2f81f7" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M96 100v14a6 6 0 0 1-6 6H74" stroke="#2f81f7" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M30 120H16a6 6 0 0 1-6-6v-14" stroke="#2f81f7" strokeWidth="1.6" strokeLinecap="round" />
        {/* 文档内容横线 */}
        <path
          d="M22 38h30M22 52h52M22 66h44M22 80h50M22 94h32M22 108h20"
          stroke="#31405a"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
      </svg>
      {/* 扫描线 */}
      <div className="scan-line absolute left-[10%] right-[10%] h-[2px] rounded-full bg-accent/80 shadow-[0_1px_10px_rgba(47,129,247,0.9)]" />
    </div>
  );
}

const FORMATS = ['JPG', 'PNG', 'WebP', 'BMP', 'GIF', 'TIFF', 'HEIC'];

interface ConfirmState {
  title: string;
  desc?: string;
  run: () => void;
}

/**
 * 首页：无草稿时保持原空状态布局；有草稿时 hero 保持原大小，
 * 手机端占满首屏（「选择图片」位于屏幕中线，下方提示下滑查看草稿），
 * 草稿列表随页面滚动展示（updatedAt 倒序）。
 */
export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const setCameraOpen = useStore((s) => s.setCameraOpen);
  const drafts = useStore((s) => s.drafts);
  const toast = useStore((s) => s.toast);

  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [swipedId, setSwipedId] = useState<number | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);

  const hasDrafts = drafts.length > 0;
  const allSelected = drafts.length > 0 && drafts.every((d) => selected.has(d.id));

  /* ===== 草稿操作 ===== */
  const doDelete = async (ids: number[]) => {
    try {
      await deleteDrafts(ids);
      await useStore.getState().refreshDrafts();
      setSelected(new Set());
      toast(ids.length > 1 ? `已删除 ${ids.length} 个草稿` : '草稿已删除');
      if (useStore.getState().drafts.length === 0) setSelectMode(false);
    } catch {
      toast('删除失败，请重试', 'error');
    }
  };

  const doClearAll = async () => {
    try {
      await clearAllDrafts();
      await useStore.getState().refreshDrafts();
      setSelected(new Set());
      setSelectMode(false);
      toast('已清空所有草稿');
    } catch {
      toast('清空失败，请重试', 'error');
    }
  };

  const doRename = async (id: number, name: string) => {
    try {
      await renameDraft(id, name);
      await useStore.getState().refreshDrafts();
    } catch {
      toast('重命名失败', 'error');
    }
  };

  const askDelete = (d: DraftMeta) => {
    setConfirmState({
      title: '删除草稿',
      desc: `「${d.name}」共 ${d.pageOrder.length} 页，删除后无法恢复。`,
      run: () => void doDelete([d.id]),
    });
  };

  const askBatchDelete = () => {
    const ids = [...selected];
    const totalPages = drafts.filter((d) => selected.has(d.id)).reduce((n, d) => n + d.pageOrder.length, 0);
    setConfirmState({
      title: `删除 ${ids.length} 个草稿`,
      desc: `共 ${totalPages} 页，删除后无法恢复。`,
      run: () => void doDelete(ids),
    });
  };

  const askClearAll = () => {
    const totalPages = drafts.reduce((n, d) => n + d.pageOrder.length, 0);
    setConfirmState({
      title: '清空所有草稿',
      desc: `将删除全部 ${drafts.length} 个草稿（共 ${totalPages} 页），删除后无法恢复。`,
      run: () => void doClearAll(),
    });
  };

  const toggleSelect = (id: number) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const toggleSelectAll = () => setSelected(allSelected ? new Set() : new Set(drafts.map((d) => d.id)));

  const exitSelect = () => {
    setSelectMode(false);
    setSelected(new Set());
  };

  /* ===== 视图 ===== */

  return (
    <div className="h-full overflow-y-auto">
      {/* ===== Hero：新建区 =====
          手机端（有草稿）：占满首屏，「选择图片」按钮位于屏幕中线，下方提示下滑查看草稿；
          PC（有草稿）：原大小常规置顶排布，草稿区紧随其后；空态：整体居中。 */}
      <div
        className={
          hasDrafts
            ? 'min-h-[100dvh] sm:min-h-0 flex flex-col items-center px-6 pb-10 sm:pt-14 sm:pb-8'
            : 'h-full flex flex-col items-center justify-center gap-7 px-6 py-8'
        }
      >
        {/* 动画 + 标题：手机端贴首屏中线（min-h 锚定 50dvh - 半按钮高，使「选择图片」中心落屏幕正中） */}
        <div
          className={
            hasDrafts
              ? 'min-h-[calc(50dvh-26px)] flex flex-col items-center justify-end gap-4 sm:min-h-0 sm:flex-none sm:justify-start sm:gap-5'
              : 'flex flex-col items-center gap-5'
          }
        >
          <ViewFinder />
          <div className="text-center">
            <h1 className="text-5xl sm:text-6xl font-extrabold tracking-tight text-slate-100">
              智能<span className="text-accent">扫描</span>
            </h1>
            <p className="mt-4 text-sm sm:text-base text-slate-400 tracking-wide">
              边缘检测 · 透视矫正 · 滤镜增强 · 导出 PDF/JPG
            </p>
            <p className="mt-2 text-xs sm:text-sm text-slate-500 flex items-center justify-center gap-1.5">
              <IconLock className="w-3.5 h-3.5" />
              全程本地处理，图片不会上传
            </p>
          </div>
        </div>

        {/* 主操作：新建草稿入口（手机端位于屏幕正中） */}
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
        </div>

        {/* 手机端滚动提示（hero 占满首屏，提示草稿在下方） */}
        {hasDrafts && (
          <div className="flex-1 flex flex-col items-center justify-start pt-7 sm:hidden">
            <span className="text-xs text-slate-500">下滑查看 {drafts.length} 个草稿</span>
            <IconChevronDown className="w-4 h-4 text-slate-500 animate-bounce motion-reduce:animate-none" />
          </div>
        )}

        {/* 支持格式与导入方式（仅空态展示，保持原有信息层级） */}
        {!hasDrafts && (
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
            <p className="text-[11px] text-slate-500 text-center">支持多选 · 拖入窗口 · Ctrl+V 粘贴</p>
            <p className="text-[11px] text-slate-500 text-center">
              摄像头功能仅在 <span className="text-slate-400 font-medium">localhost 或 HTTPS</span> 下可用
            </p>
          </div>
        )}
      </div>

      {/* ===== 草稿列表 ===== */}
      {hasDrafts && (
        <section className="max-w-6xl mx-auto w-full px-4 sm:px-6 pb-20">
          <header className="flex items-center gap-1 mb-3 h-9">
            <h2 className="text-sm font-semibold text-slate-300 mr-1">我的草稿</h2>
            <span className="text-xs text-slate-500">{drafts.length}</span>
            <div className="flex-1" />
            {selectMode ? (
              <>
                <button className="btn-ghost text-xs px-2.5 py-1.5" onClick={toggleSelectAll}>
                  {allSelected ? '取消全选' : '全选'}
                </button>
                <button className="btn-danger text-xs px-3 py-1.5" disabled={selected.size === 0} onClick={askBatchDelete}>
                  <IconTrash className="w-3.5 h-3.5" />
                  删除{selected.size > 0 ? `(${selected.size})` : ''}
                </button>
                <button className="btn-ghost text-xs px-2.5 py-1.5" onClick={exitSelect}>
                  取消
                </button>
              </>
            ) : (
              <>
                <button
                  className="btn-ghost text-xs px-2.5 py-1.5 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-ink-950"
                  onClick={() => {
                    setSelectMode(true);
                    setSelected(new Set());
                  }}
                >
                  选择
                </button>
                <button
                  className="btn-ghost text-xs px-2.5 py-1.5 text-rose-400 hover:text-rose-300 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-ink-950"
                  onClick={askClearAll}
                >
                  <IconTrash className="w-3.5 h-3.5" />
                  清空
                </button>
              </>
            )}
          </header>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {drafts.map((d) => (
              <DraftCard
                key={d.id}
                draft={d}
                selectMode={selectMode}
                selected={selected.has(d.id)}
                swipedId={swipedId}
                onSwipeStart={setSwipedId}
                onToggle={toggleSelect}
                onOpen={(id) => openEditorRoute(id)}
                onRename={doRename}
                onDelete={askDelete}
              />
            ))}
          </div>

          <p className="mt-4 text-[11px] text-slate-600 text-center">
            按最近编辑时间排序 · 草稿自动保存在本地浏览器
          </p>
        </section>
      )}

      {/* 二次确认弹窗 */}
      {confirmState && (
        <ConfirmModal
          title={confirmState.title}
          desc={confirmState.desc}
          confirmLabel="删除"
          danger
          onConfirm={() => {
            confirmState.run();
            setConfirmState(null);
          }}
          onClose={() => setConfirmState(null)}
        />
      )}

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
