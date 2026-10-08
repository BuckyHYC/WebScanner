import { useCallback, useEffect, useRef, useState } from 'react';
import type { Page } from '../types';
import { useStore } from '../store/useStore';
import { renderFinal } from '../utils/render';
import { loadOcrEngine, recognizePage } from '../utils/ocrEngine';
import { downloadBlob } from '../utils/exporter';

interface Props {
  page: Page;
}

/** 提取错误关键信息（toast 展示用，便于不同浏览器环境下定位） */
function errMsg(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.length > 80 ? msg.slice(0, 80) + '…' : msg || '未知错误';
}

/**
 * 文字识别工作台（第④步）：
 * - 左侧显示当前页处理后画面（裁剪+滤镜+擦除+旋转），右侧结果面板
 * - 单页识别 / 全部页批量（复用导出进度遮罩，可取消）
 * - 结果随草稿持久化；图片再编辑时由 useStore 自动标记「已过期」
 * - 支持复制、下载 TXT（单页 / 多页合并）
 */
export default function OcrStage({ page }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const displayRef = useRef<HTMLCanvasElement>(null);
  const cancelRef = useRef(false);
  const [busy, setBusy] = useState<string | null>(null); // 忙碌状态文案（null=空闲）
  const [copied, setCopied] = useState(false);

  const ocr = page.ocr ?? null;
  const geoKey = JSON.stringify([page.corners, page.rotation, page.flipH, page.flipV, page.fineRotate, page.polygon, page.filter, page.eraseMask]);

  // 渲染当前页处理结果预览（切页/任何视觉编辑时刷新）
  const rebuild = useCallback(async () => {
    try {
      const el = containerRef.current;
      const target = Math.max(800, Math.min(1280, Math.round((el?.clientWidth ?? 1000) * (window.devicePixelRatio || 1))));
      const canvas = await renderFinal(page, target);
      const display = displayRef.current;
      if (display) {
        display.width = canvas.width;
        display.height = canvas.height;
        display.getContext('2d')!.drawImage(canvas, 0, 0);
      }
    } catch (e) {
      console.warn('OCR 预览渲染失败', e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id, geoKey]);

  useEffect(() => {
    void rebuild();
  }, [rebuild]);

  /** 把识别结果写入页面（不进撤销历史，避免每次识别污染操作栈） */
  const commit = (pageId: string, text: string) => {
    useStore.getState().updatePage(pageId, { ocr: { text, stale: false, updatedAt: Date.now() } }, false);
  };

  /** 识别单页（含引擎懒加载），返回是否成功 */
  const runOne = async (p: Page): Promise<boolean> => {
    const outcome = await recognizePage(p);
    commit(p.id, outcome.text);
    return outcome.lines > 0;
  };

  // 单页识别
  const recognizeCurrent = async () => {
    if (busy) return;
    setBusy('正在加载识别引擎…');
    try {
      await loadOcrEngine();
      setBusy('识别中…');
      const hasText = await runOne(page);
      if (!hasText) useStore.getState().toast('未识别到文字');
    } catch (e) {
      console.warn('OCR 识别失败', e);
      useStore.getState().toast(`识别失败：${errMsg(e)}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  // 全部页批量识别：复用导出进度遮罩（setExporting），可取消
  const recognizeAll = async () => {
    const s = useStore.getState();
    if (s.exporting?.active || busy) return;
    const pages = s.pages;
    if (pages.length === 0) return;
    cancelRef.current = false;
    s.setExportCancel(() => {
      cancelRef.current = true;
    });
    setBusy('批量识别中…');
    let done = 0;
    let withText = 0;
    let failed = 0;
    try {
      await loadOcrEngine();
      for (const p of useStore.getState().pages) {
        if (cancelRef.current) break;
        // 页可能在识别过程中被删除
        if (!useStore.getState().pages.some((q) => q.id === p.id)) {
          done++;
          continue;
        }
        useStore.getState().setExporting({ active: true, done, total: pages.length, label: `OCR 识别中（${p.name}）` });
        try {
          if (await runOne(p)) withText++;
        } catch (e) {
          /* 单页失败不中断批量 */
          failed++;
          console.warn(`「${p.name}」识别失败`, e);
        }
        done++;
        useStore.getState().setExporting({ active: true, done, total: pages.length, label: 'OCR 识别中' });
      }
      if (cancelRef.current) {
        useStore.getState().toast('批量识别已取消');
      } else if (failed > 0) {
        useStore.getState().toast(`批量识别完成：成功 ${done - failed}/${done} 页（失败 ${failed} 页，详见控制台）`, failed === done ? 'error' : 'info');
      } else {
        useStore.getState().toast(`批量识别完成：${withText}/${done} 页含文字`, 'success');
      }
    } catch (e) {
      console.warn('批量 OCR 失败', e);
      useStore.getState().toast(`识别引擎加载失败：${errMsg(e)}`, 'error');
    } finally {
      setBusy(null);
      useStore.getState().setExporting(null);
      useStore.getState().setExportCancel(null);
    }
  };

  const copyText = async () => {
    if (!ocr?.text) return;
    try {
      await navigator.clipboard.writeText(ocr.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      useStore.getState().toast('复制失败，请手动选择文本复制', 'error');
    }
  };

  const downloadTxt = (pages: { name: string; text: string }[], filename: string) => {
    const content = pages.map((p) => p.text).join('\n\n');
    downloadBlob(new Blob([content], { type: 'text/plain;charset=utf-8' }), filename);
  };

  const downloadCurrent = () => {
    if (!ocr?.text) return;
    const draftName = useStore.getState().draftName || '扫描';
    downloadTxt([{ name: page.name, text: ocr.text }], `${draftName}_${page.name}.txt`);
  };

  // 多页合并 TXT（每页一节，页名作分隔标题）
  const downloadMerged = () => {
    const all = useStore.getState().pages.filter((p) => p.ocr?.text);
    if (all.length === 0) return;
    const draftName = useStore.getState().draftName || '扫描';
    const sections = all.map((p) => `—— ${p.name} ——\n${p.ocr!.text}`);
    downloadTxt([{ name: 'all', text: sections.join('\n\n') }], `${draftName}_全部文字.txt`);
  };

  const hasMultiText = useStore((s) => s.pages.filter((p) => p.ocr?.text).length > 1);
  const exportingActive = useStore((s) => !!s.exporting?.active);
  const text = ocr?.text ?? '';

  return (
    <div className="h-full flex flex-col lg:flex-row min-h-0">
      {/* 左：当前页处理结果预览 */}
      <div ref={containerRef} className="flex-1 min-h-0 min-w-0 relative flex items-center justify-center p-3 overflow-hidden">
        <canvas
          ref={displayRef}
          className="max-w-full max-h-full object-contain rounded-lg shadow-lg bg-white"
        />
      </div>

      {/* 右：识别结果面板 */}
      <div className="lg:w-96 shrink-0 border-t lg:border-t-0 lg:border-l border-ink-700 bg-ink-900 flex flex-col min-h-0">
        {/* 操作区 */}
        <div className="p-3 flex flex-wrap gap-2 border-b border-ink-800">
          <button className="btn-primary flex-1 min-w-[7rem]" disabled={!!busy || exportingActive} onClick={() => void recognizeCurrent()}>
            {busy === '识别中…' ? '识别中…' : ocr?.text ? '重新识别' : '开始识别'}
          </button>
          <button className="btn-panel" disabled={!!busy || exportingActive} onClick={() => void recognizeAll()}>
            全部页识别
          </button>
        </div>

        {/* 结果区 */}
        <div className="flex-1 min-h-0 flex flex-col p-3 gap-2">
          {ocr?.stale && (
            <div className="text-xs rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-300 px-3 py-2">
              图片在此结果生成后又被编辑，建议重新识别
            </div>
          )}
          {text ? (
            <>
              <div className="flex items-center gap-2">
                <span className="panel-title flex-1">识别结果</span>
                <button className="btn-ghost text-xs px-2 py-1" onClick={() => void copyText()} disabled={!text}>
                  {copied ? '已复制' : '复制'}
                </button>
                <button className="btn-ghost text-xs px-2 py-1" onClick={downloadCurrent}>
                  下载 TXT
                </button>
                {hasMultiText && (
                  <button className="btn-ghost text-xs px-2 py-1" onClick={downloadMerged} title="合并全部页文本为一个 TXT">
                    合并全部
                  </button>
                )}
              </div>
              <textarea
                readOnly
                value={text}
                className="flex-1 min-h-40 w-full resize-none rounded-lg bg-ink-800 border border-ink-600 p-2.5 text-sm leading-relaxed text-slate-200 outline-none focus:border-accent/60"
              />
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center px-4">
              <span className="text-sm text-slate-400">
                {busy ? busy : '识别当前页处理后的文字内容'}
              </span>
              {!busy && (
                <span className="text-xs text-slate-600">
                  首次使用需加载本地识别模型（约 42MB，仅此一次），之后浏览器缓存
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
