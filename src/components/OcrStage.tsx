import { useCallback, useEffect, useRef, useState } from 'react';
import type { Page } from '../types';
import { useStore } from '../store/useStore';
import { renderFinal } from '../utils/render';
import { prepareOcr, recognizePageByEngine } from '../utils/ocrEngine';
import { loadOcrPrefs, saveOcrPrefs, type OcrEngine, type OcrPrefs } from '../utils/ocrSettings';
import { checkVlmService, type ServiceStatus } from '../utils/xiaomiOcr';
import { downloadBlob } from '../utils/exporter';

interface Props {
  page: Page;
}

/** 提取错误关键信息（toast 展示用，便于不同浏览器环境下定位） */
function errMsg(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.length > 160 ? msg.slice(0, 160) + '…' : msg || '未知错误';
}

const ENGINE_LABEL: Record<OcrEngine, string> = {
  paddle: '浏览器内 OCR',
  vlm: '本机 Xiaomi-OCR',
};

/**
 * 文字识别工作台（第④步）：
 * - 左侧显示当前页处理后画面（裁剪+滤镜+擦除+旋转），右侧结果面板
 * - 双引擎：浏览器内 PaddleOCR（离线、逐行文本）/ 本机 Xiaomi-OCR-0 服务（整页 Markdown）
 * - 单页识别 / 全部页批量（复用导出进度遮罩，可取消）
 * - 结果随草稿持久化；图片再编辑时由 useStore 自动标记「已过期」
 * - 支持复制、下载 TXT（单页 / 多页合并）
 */
export default function OcrStage({ page }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const displayRef = useRef<HTMLCanvasElement>(null);
  const cancelRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // 忙碌状态文案（null=空闲）
  const [copied, setCopied] = useState(false);

  const [prefs, setPrefs] = useState<OcrPrefs>(() => loadOcrPrefs());
  const [showConfig, setShowConfig] = useState(false);
  const [svc, setSvc] = useState<ServiceStatus | null>(null);
  const [checking, setChecking] = useState(false);

  const ocr = page.ocr ?? null;
  const geoKey = JSON.stringify([page.corners, page.rotation, page.flipH, page.flipV, page.fineRotate, page.polygon, page.filter, page.eraseMask]);

  /** 更新并持久化引擎偏好 */
  const updatePrefs = (patch: Partial<OcrPrefs>) => {
    setPrefs((prev) => {
      const next: OcrPrefs = { ...prev, ...patch, vlm: patch.vlm ?? prev.vlm };
      saveOcrPrefs(next);
      return next;
    });
  };

  /** 探测本机推理服务（仅在选用 VLM 时才有意义） */
  const probeService = useCallback(async (vlm = prefs.vlm) => {
    setChecking(true);
    try {
      const status = await checkVlmService(vlm);
      setSvc(status);
      return status;
    } finally {
      setChecking(false);
    }
  }, [prefs.vlm]);

  // 切到本机引擎且尚未探测过时，自动检测一次服务连通性
  useEffect(() => {
    if (prefs.engine === 'vlm' && !svc && !checking) void probeService();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.engine]);

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
  const commit = (pageId: string, text: string, engine: OcrEngine) => {
    useStore.getState().updatePage(pageId, { ocr: { text, stale: false, updatedAt: Date.now(), engine } }, false);
  };

  /** 识别单页（含引擎懒加载），返回是否识别到内容 */
  const runOne = async (p: Page, signal?: AbortSignal): Promise<boolean> => {
    const outcome = await recognizePageByEngine(p, prefs.engine, prefs.vlm, signal);
    commit(p.id, outcome.text, outcome.engine);
    return outcome.lines > 0;
  };

  // 单页识别
  const recognizeCurrent = async () => {
    if (busy) return;
    const engine = prefs.engine;
    if (engine === 'vlm' && svc && !svc.ok) {
      useStore.getState().toast('本机识别服务不可用，请先启动服务', 'error');
      return;
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(engine === 'vlm' ? '连接本机模型…' : '正在加载识别引擎…');
    try {
      await prepareOcr(engine);
      setBusy('识别中…');
      const hasText = await runOne(page, ctrl.signal);
      if (!hasText) useStore.getState().toast('未识别到文字');
      if (engine === 'vlm') void probeService(); // 成功后刷新状态（首次请求会加载模型）
    } catch (e) {
      console.warn('OCR 识别失败', e);
      useStore.getState().toast(`识别失败：${errMsg(e)}`, 'error');
    } finally {
      abortRef.current = null;
      setBusy(null);
    }
  };

  // 全部页批量识别：复用导出进度遮罩（setExporting），可取消
  const recognizeAll = async () => {
    const s = useStore.getState();
    if (s.exporting?.active || busy) return;
    const pages = s.pages;
    if (pages.length === 0) return;
    const engine = prefs.engine;
    cancelRef.current = false;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    s.setExportCancel(() => {
      cancelRef.current = true;
      ctrl.abort(new Error('cancel'));
    });
    setBusy('批量识别中…');
    let done = 0;
    let withText = 0;
    let failed = 0;
    try {
      await prepareOcr(engine);
      for (const p of useStore.getState().pages) {
        if (cancelRef.current) break;
        // 页可能在识别过程中被删除
        if (!useStore.getState().pages.some((q) => q.id === p.id)) {
          done++;
          continue;
        }
        useStore.getState().setExporting({ active: true, done, total: pages.length, label: `OCR 识别中（${p.name}）` });
        try {
          if (await runOne(p, ctrl.signal)) withText++;
        } catch (e) {
          if (cancelRef.current) break;
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
      useStore.getState().toast(`识别失败：${errMsg(e)}`, 'error');
    } finally {
      abortRef.current = null;
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
  const isVlm = prefs.engine === 'vlm';

  /** 服务状态指示点 */
  const dotClass = checking ? 'bg-slate-500 animate-pulse' : !svc ? 'bg-slate-600' : svc.ok ? 'bg-emerald-500' : 'bg-rose-500';

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
        {/* 引擎选择 */}
        <div className="p-3 pb-0">
          <div className="flex rounded-lg bg-ink-800 p-0.5 text-xs">
            {(Object.keys(ENGINE_LABEL) as OcrEngine[]).map((k) => (
              <button
                key={k}
                className={`flex-1 rounded-md px-2 py-1.5 transition-colors ${
                  prefs.engine === k ? 'bg-accent text-white font-medium' : 'text-slate-400 hover:text-slate-200'
                }`}
                disabled={!!busy}
                onClick={() => updatePrefs({ engine: k })}
              >
                {ENGINE_LABEL[k]}
              </button>
            ))}
          </div>
        </div>

        {/* 本机服务配置（仅 VLM 引擎） */}
        {isVlm && (
          <div className="px-3 pt-2 space-y-1.5">
            <div className="flex items-center gap-1.5 text-xs text-slate-400">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`} />
              <span className="flex-1 truncate" title={svc?.detail ?? ''}>
                {checking ? '检测中…' : (svc?.detail ?? '未检测')}
              </span>
              <button className="btn-ghost px-1.5 py-0.5 text-xs" disabled={checking || !!busy} onClick={() => void probeService()}>
                检测
              </button>
              <button className="btn-ghost px-1.5 py-0.5 text-xs" onClick={() => setShowConfig((v) => !v)}>
                {showConfig ? '收起' : '设置'}
              </button>
            </div>
            {showConfig && (
              <div className="space-y-1.5 rounded-lg bg-ink-800/60 p-2">
                <label className="block text-[11px] text-slate-500">
                  服务地址
                  <input
                    className="mt-0.5 w-full rounded bg-ink-900 border border-ink-600 px-2 py-1 text-xs text-slate-200 outline-none focus:border-accent/60"
                    value={prefs.vlm.endpoint}
                    spellCheck={false}
                    onChange={(e) => updatePrefs({ vlm: { ...prefs.vlm, endpoint: e.target.value } })}
                    onBlur={() => setSvc(null)}
                  />
                </label>
                <label className="block text-[11px] text-slate-500">
                  模型名
                  <input
                    className="mt-0.5 w-full rounded bg-ink-900 border border-ink-600 px-2 py-1 text-xs text-slate-200 outline-none focus:border-accent/60"
                    value={prefs.vlm.model}
                    spellCheck={false}
                    onChange={(e) => updatePrefs({ vlm: { ...prefs.vlm, model: e.target.value } })}
                    onBlur={() => setSvc(null)}
                  />
                </label>
                <p className="text-[11px] leading-relaxed text-slate-500">
                  需本机运行 Ollama（<code className="text-slate-400">ollama serve</code>）并已拉取该模型。浏览器直连本机服务时，Ollama 需设置{' '}
                  <code className="text-slate-400">OLLAMA_ORIGINS=*</code>。
                </p>
              </div>
            )}
          </div>
        )}

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
                {ocr?.engine === 'vlm' && <span className="text-[11px] text-slate-500">Markdown</span>}
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
                  {isVlm
                    ? '由本机 Xiaomi-OCR-0 输出整页 Markdown（含表格/公式），首次请求需加载模型'
                    : '首次使用需加载本地识别模型（约 42MB，仅此一次），之后浏览器缓存'}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
