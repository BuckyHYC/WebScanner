import { useEffect, useRef, useState } from 'react';
import type { ChatTurn, Page } from '../types';
import { useStore } from '../store/useStore';
import { MAX_HISTORY_TURNS, chatWithVlm, renderPageImage, type VlmSettings } from '../utils/xiaomiOcr';

interface Props {
  page: Page;
  vlm: VlmSettings;
  /** 批量识别等占用中时禁用输入 */
  disabled?: boolean;
}

/** 空态引导：都是针对文档的短问句，模型实测能答好 */
const SUGGESTIONS = ['文档里出现了哪些日期？', '总金额是多少？', '把表格内容整理成列表'];
/** 单条问题长度上限：超过容易把上下文顶满，也不利于 0.8B 模型理解 */
const MAX_QUESTION_CHARS = 12000;

function errMsg(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.length > 160 ? msg.slice(0, 160) + '…' : msg || '未知错误';
}

/**
 * 文档对话面板：就当前页与本机 VLM 连续问答。
 *
 * 关键设计（依据实测）：
 * - 图片只在首条消息里注入一次，后续轮次纯文本仍能引用图中内容（历史里的图片 token 持续有效），
 *   每轮只增约 30~50 tokens；因此渲染图在这里按 geoKey 缓存，页面不变就不重新渲染。
 * - 首问首答固定保留，其余只留最近若干轮（见 trimChatHistory）；图片丢了模型就看不到文档。
 */
export default function ChatPanel({ page, vlm, disabled }: Props) {
  const [input, setInput] = useState('');
  const [chatting, setChatting] = useState(false);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const imageRef = useRef<{ key: string; url: string } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const chat = page.chat ?? [];

  // 页面视觉状态的指纹：变化后渲染图缓存失效，模型看到的是旧图
  const geoKey = JSON.stringify([page.corners, page.rotation, page.flipH, page.flipV, page.fineRotate, page.polygon, page.filter, page.eraseMask]);
  const imageKey = `${page.id}|${geoKey}`;

  // 新消息或等待回答时滚到底
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.length, chatting]);

  // 卸载/切页时中止进行中的请求
  useEffect(() => () => abortRef.current?.abort(), [page.id]);

  /** 取当前页渲染图，按页面视觉指纹缓存（识别与对话用的是同一套 2048 长边预处理） */
  const getImage = async (): Promise<string> => {
    if (imageRef.current?.key === imageKey) return imageRef.current.url;
    const url = await renderPageImage(page);
    imageRef.current = { key: imageKey, url };
    return url;
  };

  const toast = (text: string, tone: 'info' | 'success' | 'error' = 'info') => useStore.getState().toast(text, tone);

  const send = async () => {
    const question = input.trim();
    if (!question || chatting || disabled) return;
    if (question.length > MAX_QUESTION_CHARS) {
      toast('问题过长，请拆成几次提问', 'error');
      return;
    }

    setInput('');
    const turn: ChatTurn = { role: 'user', content: question, at: Date.now() };
    const store = useStore.getState();
    store.appendChatTurn(page.id, turn);
    setChatting(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const imageDataUrl = await getImage();
      // 用 store 里的最新历史（刚追加的这条在里面），避免拿到渲染闭包里的旧值
      const latest = useStore.getState().pages.find((p) => p.id === page.id);
      const turns = latest?.chat ?? [turn];
      const answer = await chatWithVlm({ turns, imageDataUrl, settings: vlm, signal: ctrl.signal });
      useStore.getState().appendChatTurn(page.id, { role: 'assistant', content: answer, at: Date.now() });
    } catch (e) {
      // 撤回这条悬空的提问，避免留下没有回答的问题
      const cur = useStore.getState().pages.find((p) => p.id === page.id);
      if (cur?.chat?.length) {
        useStore.getState().updatePage(page.id, { chat: cur.chat.slice(0, -1) }, false);
      }
      if (ctrl.signal.aborted) {
        setInput(question); // 主动停止：把问题还回输入框，方便改写重问
      } else {
        console.warn('对话失败', e);
        toast(`提问失败：${errMsg(e)}`, 'error');
      }
    } finally {
      abortRef.current = null;
      setChatting(false);
    }
  };

  const stop = () => abortRef.current?.abort();

  const clear = () => {
    abortRef.current?.abort();
    useStore.getState().clearChat(page.id);
    imageRef.current = null;
    setCopiedIdx(null);
  };

  const copy = async (text: string, idx: number) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(null), 1500);
    } catch {
      toast('复制失败，请手动选择文本复制', 'error');
    }
  };

  const rounds = Math.ceil(chat.filter((t) => t.role === 'user').length);
  const atLimit = rounds > MAX_HISTORY_TURNS;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* 结果过期提示：页面图像被编辑后，模型手里还是旧图 */}
      {page.chatStale && (
        <div className="mx-3 mt-3 text-xs rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-300 px-3 py-2">
          页面图像在此对话开始后被编辑，回答可能不准确，建议清空对话重新开始
        </div>
      )}

      {/* 消息列表 */}
      <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-2.5">
        {chat.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center gap-3 text-center px-2">
            <span className="text-sm text-slate-400">就这一页内容向模型提问</span>
            <div className="flex flex-col gap-1.5 w-full">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  className="text-xs rounded-lg border border-ink-600 bg-ink-800/60 px-3 py-2 text-slate-300 hover:border-accent/50 hover:text-slate-100 transition-colors text-left"
                  onClick={() => setInput(s)}
                >
                  {s}
                </button>
              ))}
            </div>
            <span className="text-[11px] text-slate-600 leading-relaxed">
              模型会直接看图回答，不需要先把识别结果发过去
            </span>
          </div>
        ) : (
          chat.map((turn, i) =>
            turn.role === 'user' ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[85%] rounded-lg rounded-br-sm bg-accent/20 border border-accent/30 px-3 py-2 text-sm text-slate-100 whitespace-pre-wrap break-words">
                  {turn.content}
                </div>
              </div>
            ) : (
              <div key={i} className="flex flex-col items-start gap-1">
                <div className="max-w-[92%] rounded-lg rounded-bl-sm bg-ink-800 border border-ink-600 px-3 py-2 text-sm text-slate-200 whitespace-pre-wrap break-words">
                  {turn.content}
                </div>
                <button className="text-[11px] text-slate-600 hover:text-slate-300 px-1" onClick={() => void copy(turn.content, i)}>
                  {copiedIdx === i ? '已复制' : '复制'}
                </button>
              </div>
            ),
          )
        )}

        {chatting && (
          <div className="flex items-center gap-2 text-xs text-slate-500 px-1">
            <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
            模型思考中…
          </div>
        )}
      </div>

      {/* 输入区 */}
      <div className="border-t border-ink-800 p-3 space-y-1.5">
        <div className="flex gap-2 items-end">
          <textarea
            value={input}
            rows={2}
            placeholder={disabled ? '批量识别进行中…' : 'Enter 发送，Shift+Enter 换行'}
            disabled={disabled}
            className="flex-1 min-h-[2.75rem] max-h-32 resize-none rounded-lg bg-ink-800 border border-ink-600 px-2.5 py-2 text-sm text-slate-200 outline-none focus:border-accent/60 disabled:opacity-50"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          {chatting ? (
            <button className="btn-panel shrink-0 h-[2.75rem]" onClick={stop}>
              停止
            </button>
          ) : (
            <button className="btn-primary shrink-0 h-[2.75rem]" disabled={!input.trim() || disabled} onClick={() => void send()}>
              发送
            </button>
          )}
        </div>
        <div className="flex items-center gap-2 text-[11px] text-slate-600">
          <span className="flex-1">
            {rounds > 0 && `已问 ${rounds} 轮`}
            {atLimit && `（超出 ${MAX_HISTORY_TURNS} 轮，模型只保留首轮与最近若干轮）`}
          </span>
          {chat.length > 0 && (
            <button className="hover:text-slate-300" disabled={chatting} onClick={clear}>
              清空对话
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
