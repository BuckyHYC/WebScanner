/**
 * Xiaomi-OCR-0 本机服务调用层（0.8B 文档解析 VLM，OpenAI 兼容 /v1/chat/completions）。
 *
 * 协议对齐上游 Xiaomi-OCR-0 的 demo/server.py：
 * - 单图 + 固定 non-thinking 提示词，greedy 解码（temperature=0 / top_p=0.8 / repetition=1.0）
 * - 图片预处理对齐上游 fit_image：RGB、长边压到 2048 以内
 * - 输出为整页 Markdown（表格转 HTML/OTSL、公式转 LaTeX），而非逐行文本
 *
 * 服务端缺省为本机 Ollama（127.0.0.1:11434），也兼容 vLLM / SGLang（端口 8000）。
 */
import type { ChatTurn, Page } from '../types';
import { renderFinal } from './render';
import { finalizeDocument } from './document';

/** 上游 DOC_PROMPT 原文，勿改措辞：模型按该提示词做对齐训练 */
const DOC_PROMPT =
  'Extract all information from the main body of the document image and represent it in markdown format, ' +
  'ignoring headers and footers. Tables should be expressed in OTSL format, formulas in the document should ' +
  'be represented using LATEX format, and the parsing should be organized according to the reading order.';

/** 送模型的页面最大长边（上游 evaluation_pipeline/cropping.py 的 MAX_IMAGE_EDGE） */
const MAX_EDGE = 2048;
/** 单页推理超时：GPU 约 2-6s，纯 CPU 兜底可能到两分钟 */
const REQUEST_TIMEOUT_MS = 300_000;
const MAX_TOKENS = 4096;

/** 缺省本机服务（Ollama 默认端口）与社区 GGUF 模型名 */
export const DEFAULT_VLM_ENDPOINT = 'http://127.0.0.1:11434';
export const DEFAULT_VLM_MODEL = 'longwayxu/xiaomi-ocr-0:bf16';

export interface VlmSettings {
  /** 服务根地址，如 http://127.0.0.1:11434 或 http://127.0.0.1:8000/v1 */
  endpoint: string;
  /** 模型名，如 longwayxu/xiaomi-ocr-0:bf16 */
  model: string;
}

/** 拼接 chat/completions 地址：兼容用户填根地址、/v1 结尾、或完整端点 */
function chatUrl(endpoint: string): string {
  const base = endpoint.trim().replace(/\/+$/, '');
  if (base.endsWith('/chat/completions')) return base;
  if (/\/v1$/.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

function modelsUrl(endpoint: string): string {
  const base = endpoint.trim().replace(/\/+$/, '');
  if (base.endsWith('/chat/completions')) return base.replace(/\/chat\/completions$/, '/models');
  return /\/v1$/.test(base) ? `${base}/models` : `${base}/v1/models`;
}

/** 合并外部取消信号与超时，避免依赖 AbortSignal.any（Safari 旧版不支持） */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), ms);
  const abort = () => {
    clearTimeout(timer);
    ctrl.abort(signal?.reason);
  };
  if (signal) {
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  }
  // 请求正常结束后由调用方 clearTimeout：为简化在 fetch 完成时清理
  ctrl.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  (ctrl.signal as AbortSignal & { __cleanup?: () => void }).__cleanup = () => clearTimeout(timer);
  return ctrl.signal;
}

/** 把 fetch 的原始异常翻译成可操作的提示（浏览器直连本机服务时 CORS 是最常见原因） */
function describeFetchError(e: unknown, endpoint: string): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/aborted|timeout/i.test(msg)) return '推理超时，模型可能仍在加载，稍后重试或改用更小的页面';
  if (e instanceof TypeError) {
    // 带上当前站点 origin：部署到新域名后最常见的失败原因就是没把它加进白名单
    const origin = typeof location !== 'undefined' ? location.origin : '当前站点';
    return (
      `无法连接 ${endpoint}。请确认本机推理服务已启动；` +
      `若已启动仍报错，通常是跨域限制——需把 ${origin} 加入本机服务的 OLLAMA_ORIGINS 后重启服务`
    );
  }
  return msg || '未知错误';
}

/** 从 OpenAI 兼容响应中取出正文 */
function pickContent(data: unknown): string {
  const choices = (data as { choices?: unknown[] } | null)?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const msg = (choices[0] as { message?: { content?: unknown } }).message;
  const content = msg?.content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'object' && p ? String((p as { text?: string }).text ?? '') : String(p))).join('');
  }
  return typeof content === 'string' ? content : '';
}

export interface ServiceStatus {
  ok: boolean;
  /** 面向用户的简短结论 */
  detail: string;
  /** 服务返回的模型列表（便于用户核对模型名） */
  models: string[];
}

/** 探测本机服务是否可达、目标模型是否已就位 */
export async function checkVlmService(settings: VlmSettings): Promise<ServiceStatus> {
  const url = modelsUrl(settings.endpoint);
  try {
    const resp = await fetch(url, { signal: withTimeout(undefined, 8000) });
    if (!resp.ok) return { ok: false, detail: `服务返回 HTTP ${resp.status}`, models: [] };
    const data = (await resp.json()) as { data?: { id?: string }[]; models?: { name?: string }[] };
    // OpenAI 风格用 data[].id，Ollama 原生用 models[].name
    const models = (data.data ?? []).map((m) => m.id ?? '').concat((data.models ?? []).map((m) => m.name ?? '')).filter(Boolean);
    const want = settings.model.trim().toLowerCase();
    const hit = want ? models.some((m) => m.toLowerCase() === want || m.toLowerCase().startsWith(want.split(':')[0])) : false;
    if (models.length === 0) return { ok: true, detail: '服务可达，但尚无可用模型', models };
    if (want && !hit) {
      return { ok: true, detail: `服务可达，但未找到模型「${settings.model}」，请先 ollama pull`, models };
    }
    return { ok: true, detail: `服务就绪（${models.length} 个模型）`, models };
  } catch (e) {
    return { ok: false, detail: describeFetchError(e, settings.endpoint), models: [] };
  }
}

export interface VlmOcrOutcome {
  /** 整页 Markdown */
  text: string;
  /** 估算的行数（仅用于判断是否识别到内容） */
  lines: number;
}

/** 渲染页面的处理结果（裁剪+滤镜+擦除+旋转），长边限制到 2048 后转 PNG dataURL。识别与对话共用 */
export async function renderPageImage(page: Page): Promise<string> {
  const canvas = await renderFinal(page, MAX_EDGE);
  return canvas.toDataURL('image/png');
}

/** 对话历史保留的最大轮数（首问首答固定保留，其余超出部分从最早开始丢） */
export const MAX_HISTORY_TURNS = 12;
/** 对话单轮输出上限（问表格内容时需要比识别更长的回答） */
const CHAT_MAX_TOKENS = 2048;

type ChatPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
interface ApiMessage {
  role: 'user' | 'assistant';
  content: string | ChatPart[];
}

/** 统一的 chat/completions 调用（识别与对话共用），返回正文与结束原因 */
async function requestChat(
  payload: Record<string, unknown>,
  settings: VlmSettings,
  signal?: AbortSignal,
): Promise<{ content: string; finish?: string }> {
  let resp: Response;
  try {
    resp = await fetch(chatUrl(settings.endpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: withTimeout(signal, REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(describeFetchError(e, settings.endpoint));
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    if (resp.status === 404) throw new Error(`模型「${settings.model}」不存在，请先执行 ollama pull ${settings.model}`);
    if (resp.status === 400 && /context length/i.test(body)) throw new Error('超出模型上下文，请缩短问题或清空对话后重开');
    throw new Error(`推理服务返回 HTTP ${resp.status}：${body.slice(0, 200) || '无响应体'}`);
  }

  const data = (await resp.json().catch(() => null)) as unknown;
  const content = pickContent(data).trim();
  const finish = (data as { choices?: { finish_reason?: string }[] } | null)?.choices?.[0]?.finish_reason;
  return { content, finish };
}

/** 对话通用采样参数：与识别一致走贪心，避免 0.8B 模型自由发挥 */
function chatSampling(model: string, maxTokens: number) {
  return {
    model: model.trim(),
    temperature: 0,
    max_tokens: maxTokens,
    stream: false,
    top_p: 0.8,
    presence_penalty: 0,
    repetition_penalty: 1,
    // 关闭 thinking：上游对该 checkpoint 的对齐条件之一；vLLM 读取该字段，Ollama 忽略未知字段
    chat_template_kwargs: { enable_thinking: false },
  };
}

/** 识别一页：整页文档解析，返回 Markdown */
export async function recognizeWithVlm(page: Page, settings: VlmSettings, signal?: AbortSignal): Promise<VlmOcrOutcome> {
  const dataUrl = await renderPageImage(page);
  const { content, finish } = await requestChat(
    {
      ...chatSampling(settings.model, MAX_TOKENS),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: dataUrl } },
            { type: 'text', text: DOC_PROMPT },
          ],
        },
      ],
    },
    settings,
    signal,
  );
  if (!content) throw new Error('模型返回空结果，请确认图片包含可识别文字');
  if (finish === 'length') throw new Error('输出被截断（触达 max_tokens），建议降低页面复杂度后重试');
  // 上游 finalize_document：重复尾部清理 + 数学定界符归一化 + OTSL 表格转 HTML
  const text = finalizeDocument(content);
  return { text, lines: text.split('\n').filter((l) => l.trim()).length };
}

/**
 * 裁剪对话历史，控制上下文长度但不丢图片。
 * 首问（含图片）与首答固定保留 —— 图片只在首条消息里出现，丢掉它模型就看不到文档了。
 * 其余只保留最近的部分，并保证裁剪后仍以 user 开头、角色交替。
 */
export function trimChatHistory(turns: ChatTurn[], maxTurns = MAX_HISTORY_TURNS): ChatTurn[] {
  const keepTail = Math.max(1, maxTurns * 2 - 2);
  if (turns.length <= 2 + keepTail) return turns;
  const head = turns.slice(0, 2);
  let tail = turns.slice(-keepTail);
  // 丢掉的区间末尾可能是 assistant，导致 tail 以 assistant 开头 —— 它的提问者丢了，一并去掉
  while (tail.length > 0 && tail[0].role === 'assistant') tail = tail.slice(1);
  return [...head, ...tail];
}

/**
 * 构造请求消息。图片只注入首条 user 消息一次：实测后续轮次不带图仍能引用图中内容
 * （历史里的图片 token 持续有效），每轮仅增约 30~50 tokens。
 */
export function buildChatMessages(turns: ChatTurn[], imageDataUrl: string): ApiMessage[] {
  if (turns.length === 0) throw new Error('对话为空');
  if (turns[0].role !== 'user') throw new Error('对话必须以用户提问开始');
  const messages: ApiMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: imageDataUrl } },
        { type: 'text', text: turns[0].content },
      ],
    },
  ];
  for (const turn of turns.slice(1)) {
    messages.push({ role: turn.role, content: turn.content });
  }
  return messages;
}

export interface ChatParams {
  /** 完整历史，最后一条是待回答的用户提问 */
  turns: ChatTurn[];
  /** 当前页渲染图（dataURL），只在首条消息里使用 */
  imageDataUrl: string;
  settings: VlmSettings;
  signal?: AbortSignal;
}

/** 就当前页问答一轮，返回助手回答 */
export async function chatWithVlm({ turns, imageDataUrl, settings, signal }: ChatParams): Promise<string> {
  const messages = buildChatMessages(trimChatHistory(turns), imageDataUrl);
  const { content, finish } = await requestChat(
    { ...chatSampling(settings.model, CHAT_MAX_TOKENS), messages },
    settings,
    signal,
  );
  if (!content) throw new Error('模型没有返回内容，请换个问法或清空对话重试');
  // 对话回答不套用文档后处理，只标记截断
  return finish === 'length' ? `${content}\n\n（回答被截断，可继续追问剩余部分）` : content;
}
