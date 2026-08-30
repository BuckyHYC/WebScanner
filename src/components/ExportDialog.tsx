import { useEffect, useMemo, useRef, useState } from 'react';
import type { ExportOptions, Page, PdfSize, Quality } from '../types';
import { useStore } from '../store/useStore';
import { downloadBlob, exportJpgDirectly, exportJpgZip, exportPdf, exportSingleJpg } from '../utils/exporter';
import { renderFinal } from '../utils/render';

interface Props {
  onClose: () => void;
}

export default function ExportDialog({ onClose }: Props) {
  const pages = useStore((s) => s.pages);
  const current = useStore((s) => s.current);
  const [opts, setOpts] = useState<ExportOptions>({
    format: 'pdf',
    pageIds: 'all',
    pdfSize: 'a4',
    quality: 'high',
    jpgQuality: 92,
    prefix: 'Scan',
    title: '',
    author: '',
  });
  const [jpgScope, setJpgScope] = useState<'current' | 'all'>('all');
  const [jpgDelivery, setJpgDelivery] = useState<'zip' | 'direct'>('zip');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [running, setRunning] = useState(false);

  const set = <K extends keyof ExportOptions>(k: K, v: ExportOptions[K]) => setOpts((o) => ({ ...o, [k]: v }));

  const targets: Page[] = useMemo(() => {
    if (opts.format === 'pdf') return pages;
    return jpgScope === 'current' && pages[current] ? [pages[current]] : pages;
  }, [opts.format, jpgScope, pages, current]);

  const run = async () => {
    if (targets.length === 0) return;
    const s = useStore.getState();
    setRunning(true);
    s.setExporting({ active: true, done: 0, total: targets.length, label: '正在导出…' });
    try {
      if (opts.format === 'pdf') {
        const blob = await exportPdf(targets, opts, (done, total) =>
          s.setExporting({ active: true, done, total, label: '正在生成 PDF…' }),
        );
        downloadBlob(blob, `${opts.prefix || 'scan'}.pdf`);
      } else if (targets.length === 1) {
        await exportSingleJpg(targets[0], opts, pages.indexOf(targets[0]));
      } else if (jpgDelivery === 'direct') {
        // 逐张直接导出：每张单独下载，移动端可直接存入相册
        const indices = targets.map((t) => pages.indexOf(t));
        await exportJpgDirectly(targets, opts, indices, (done, total) =>
          s.setExporting({ active: true, done, total, label: '正在逐张导出…' }),
        );
        s.toast(`已逐张导出 ${targets.length} 张，请在下载/相册中查看`, 'success');
      } else {
        const blob = await exportJpgZip(targets, opts, (done, total) =>
          s.setExporting({ active: true, done, total, label: '正在打包 ZIP…' }),
        );
        downloadBlob(blob, `${opts.prefix || 'scan'}.zip`);
      }
      s.toast('导出完成，已开始下载', 'success');
      onClose();
    } catch (e) {
      console.error(e);
      s.toast('导出失败，请重试', 'error');
    } finally {
      s.setExporting(null);
      setRunning(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full sm:w-[420px] max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl bg-ink-900 border border-ink-700 p-5 flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">导出文档</h2>
          <button className="btn-ghost px-2" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* 格式 */}
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ['pdf', '📄 PDF 文档'],
              ['jpg', '🖼️ JPG 图片'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              className={`rounded-lg py-2.5 text-sm border ${
                opts.format === k ? 'border-accent bg-accent/15 text-accent' : 'border-ink-600 bg-ink-800 text-slate-300'
              }`}
              onClick={() => set('format', k)}
            >
              {label}
            </button>
          ))}
        </div>

        {/* JPG 多页打包方式 */}
        {opts.format === 'jpg' && targets.length > 1 && (
          <Field label="导出方式">
            <Segmented
              value={jpgDelivery}
              onChange={(v) => setJpgDelivery(v as 'zip' | 'direct')}
              options={[
                ['zip', 'ZIP 压缩包'],
                ['direct', '逐张直接导出'],
              ]}
            />
            {jpgDelivery === 'zip' ? (
              <p className="text-[11px] text-slate-500">多页打包为一个 ZIP 文件（共 {targets.length} 页），适合电脑端整理</p>
            ) : (
              <p className="text-[11px] text-slate-500">
                逐张下载 {targets.length} 张图片，手机端可直接保存到相册；若浏览器提示是否允许下载多个文件，请选择允许
              </p>
            )}
          </Field>
        )}

        {/* JPG 范围 */}
        {opts.format === 'jpg' && pages.length > 1 && (
          <Field label="导出范围">
            <Segmented
              value={jpgScope}
              onChange={(v) => setJpgScope(v as 'current' | 'all')}
              options={[
                ['current', `当前页（第 ${current + 1} 页）`],
                ['all', `全部页（${pages.length} 页）`],
              ]}
            />
          </Field>
        )}

        {/* PDF 尺寸 */}
        {opts.format === 'pdf' && (
          <Field label="页面尺寸">
            <Segmented
              value={opts.pdfSize}
              onChange={(v) => set('pdfSize', v as PdfSize)}
              options={[
                ['a4', 'A4 适配'],
                ['fit', '原始尺寸'],
                ['fitWidth', '适应宽度'],
              ]}
            />
          </Field>
        )}

        {/* 质量 */}
        <Field label="画质">
          <Segmented
            value={opts.quality}
            onChange={(v) => set('quality', v as Quality)}
            options={[
              ['high', '高'],
              ['mid', '中'],
              ['low', '低'],
            ]}
          />
        </Field>

        {/* JPG 质量滑块 */}
        {opts.format === 'jpg' && (
          <Field label={`JPG 质量：${opts.jpgQuality}`}>
            <input
              type="range"
              min={1}
              max={100}
              value={opts.jpgQuality}
              onChange={(e) => set('jpgQuality', Number(e.target.value))}
              className="w-full"
            />
          </Field>
        )}

        <Field label="文件名前缀">
          <input
            className="w-full rounded-lg bg-ink-800 border border-ink-600 px-3 py-2 text-sm focus:border-accent outline-none"
            value={opts.prefix}
            onChange={(e) => set('prefix', e.target.value)}
            placeholder="Scan"
          />
          <p className="text-[11px] text-slate-500 mt-1">
            {opts.format === 'pdf'
              ? `将导出 ${opts.prefix || 'scan'}.pdf`
              : targets.length > 1
                ? `文件名形如 ${opts.prefix || 'scan'}_001.jpg`
                : `将导出 ${opts.prefix || 'scan'}_${String(pages.indexOf(targets[0]) + 1).padStart(3, '0')}.jpg`}
          </p>
        </Field>

        {opts.format === 'pdf' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="标题（可选）">
              <input
                className="w-full rounded-lg bg-ink-800 border border-ink-600 px-3 py-2 text-sm focus:border-accent outline-none"
                value={opts.title}
                onChange={(e) => set('title', e.target.value)}
                placeholder="文档标题"
              />
            </Field>
            <Field label="作者（可选）">
              <input
                className="w-full rounded-lg bg-ink-800 border border-ink-600 px-3 py-2 text-sm focus:border-accent outline-none"
                value={opts.author}
                onChange={(e) => set('author', e.target.value)}
                placeholder="作者"
              />
            </Field>
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <button className="btn-panel flex-1" disabled={running || targets.length === 0} onClick={() => setPreviewOpen(true)}>
            👁 导出前预览
          </button>
          <button className="btn-primary flex-1" disabled={running || targets.length === 0} onClick={() => void run()}>
            ⬇️ 导出（{targets.length} 页）
          </button>
        </div>

        {previewOpen && <PreviewModal pages={targets} onClose={() => setPreviewOpen(false)} />}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-slate-400">{label}</span>
      {children}
    </div>
  );
}

function Segmented({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <div className="flex rounded-lg bg-ink-800 border border-ink-600 p-0.5">
      {options.map(([k, label]) => (
        <button
          key={k}
          className={`flex-1 rounded-md px-2 py-1.5 text-xs transition-colors ${
            value === k ? 'bg-accent text-white' : 'text-slate-400 hover:text-slate-200'
          }`}
          onClick={() => onChange(k)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** 导出前全屏逐页预览（展示最终渲染效果） */
function PreviewModal({ pages, onClose }: { pages: Page[]; onClose: () => void }) {
  const [idx, setIdx] = useState(0);
  const [canvases, setCanvases] = useState<(HTMLCanvasElement | null)[]>([]);

  // 逐页渲染最终效果（异步、可取消）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const results: (HTMLCanvasElement | null)[] = [];
      for (const p of pages) {
        try {
          const c = await renderFinal(p, 1200);
          results.push(c);
        } catch {
          results.push(null);
        }
        if (cancelled) return;
        setCanvases([...results]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pages]);

  const page = pages[idx];
  const canvas = canvases[idx];
  const displayRef = useRef<HTMLCanvasElement>(null);

  // 切换页码 / 渲染完成后把结果绘制到显示画布
  useEffect(() => {
    const el = displayRef.current;
    if (!el || !canvas) return;
    el.width = canvas.width;
    el.height = canvas.height;
    el.getContext('2d')!.drawImage(canvas, 0, 0);
  }, [canvas, idx]);

  return (
    <div className="fixed inset-0 z-[60] bg-black/95 flex flex-col">
      <div className="flex items-center justify-between px-4 h-12 shrink-0">
        <span className="text-sm text-slate-300">
          预览 {idx + 1} / {pages.length}
        </span>
        <button className="btn-ghost" onClick={onClose}>
          ✕ 关闭预览
        </button>
      </div>
      <div className="flex-1 min-h-0 flex items-center justify-center p-4 gap-2">
        <button
          className="btn-ghost px-2 text-2xl shrink-0"
          disabled={idx === 0}
          onClick={() => setIdx((i) => Math.max(0, i - 1))}
        >
          ‹
        </button>
        <div className="flex-1 h-full flex items-center justify-center min-w-0">
          <canvas
            ref={displayRef}
            className={`max-w-full max-h-full object-contain rounded shadow-2xl ${canvas ? '' : 'hidden'}`}
          />
          {!canvas && <span className="text-slate-500 text-sm">{canvas === null ? '该页渲染失败' : '渲染中…'}</span>}
        </div>
        <button
          className="btn-ghost px-2 text-2xl shrink-0"
          disabled={idx >= pages.length - 1}
          onClick={() => setIdx((i) => Math.min(pages.length - 1, i + 1))}
        >
          ›
        </button>
      </div>
      <div className="text-center text-xs text-slate-500 pb-4">{page?.name}</div>
    </div>
  );
}
