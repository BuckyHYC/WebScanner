import { useEffect } from 'react';

interface Props {
  title: string;
  desc?: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/** 二次确认弹窗：移动端底部 ActionSheet、PC 居中 Modal */
export default function ConfirmModal({ title, desc, confirmLabel = '确定', danger = false, onConfirm, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center bg-black/60"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full sm:w-[360px] rounded-t-2xl sm:rounded-2xl bg-ink-900 border border-ink-700 p-5 flex flex-col gap-4 safe-bottom"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h3 className="text-base font-semibold text-slate-100">{title}</h3>
          {desc && <p className="mt-1.5 text-sm text-slate-400 leading-relaxed">{desc}</p>}
        </div>
        <div className="flex gap-2">
          <button className="btn-panel flex-1 py-2.5" onClick={onClose}>
            取消
          </button>
          <button className={`${danger ? 'btn-danger' : 'btn-primary'} flex-1 py-2.5`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
