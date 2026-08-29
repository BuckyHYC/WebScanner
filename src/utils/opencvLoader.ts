/**
 * OpenCV.js 加载器（带可视化进度回调）
 *
 * 方案：opencv.js（约 10MB，wasm 内联的 UMD 单文件）放在 public/opencv/，
 * 通过 XHR 下载（真实进度）→ 内联 <script> 执行（挂载 window.cv）→ 轮询等待 wasm 运行时就绪。
 * 好处：主线程只在下载完成后短暂解析一次，全程进度可见；不参与 Vite 预打包/构建。
 */
type CvStatus = 'idle' | 'downloading' | 'initializing' | 'ready' | 'error';

export interface CvLoadState {
  status: CvStatus;
  /** 下载进度 0~100（initializing 时为 100） */
  progress: number;
  error?: string;
}

let state: CvLoadState = { status: 'idle', progress: 0 };
const listeners = new Set<(s: CvLoadState) => void>();

/** 订阅加载状态（立即回放当前状态），返回取消订阅函数 */
export function onCvLoadState(cb: (s: CvLoadState) => void): () => void {
  listeners.add(cb);
  cb(state);
  return () => listeners.delete(cb);
}

function setState(patch: Partial<CvLoadState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l(state));
}

let instance: any = null;
let pending: Promise<any> | null = null;

export async function loadOpenCV(): Promise<any> {
  if (instance?.Mat) return instance;
  if (pending) return pending;
  pending = (async () => {
    const url = `${import.meta.env.BASE_URL}opencv/opencv.js`;
    try {
      setState({ status: 'downloading', progress: 0, error: undefined });
      const code = await downloadText(url, (p) => {
        if (state.status === 'downloading') setState({ progress: p });
      });

      setState({ status: 'initializing', progress: 100 });
      // 让浏览器先把 100% 进度画出来，再进入同步解析
      await new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 30)));

      if (!(window as any).cv?.Mat) {
        const script = document.createElement('script');
        script.textContent = code;
        document.head.appendChild(script);
        script.remove();
      }
      const m = (window as any).cv;
      if (!m) throw new Error('opencv.js 执行失败（未挂载 window.cv）');

      // 关键修复：emscripten 给 Module 挂的 then 使 cv 成为 thenable，
      // 任何 await cv 的代码都会触发「then 同步回调 → 无限微任务循环」冻死主线程。
      // 删除 then（纯便利特性，无功能影响），彻底杜绝该类死循环。
      try {
        delete m.then;
      } catch {
        /* 某些实现不可配置时忽略 */
      }

      // 等待 wasm 运行时初始化完成（Mat 可用即就绪）
      await new Promise<void>((resolve) => {
        if (m.Mat) return resolve();
        const timer = setInterval(() => {
          if (m.Mat) {
            clearInterval(timer);
            resolve();
          }
        }, 60);
      });

      instance = m;
      setState({ status: 'ready' });
      return m;
    } catch (e: any) {
      pending = null; // 允许重试
      setState({ status: 'error', error: e?.message ?? '加载失败' });
      throw e;
    }
  })();
  return pending;
}

/** 获取已加载实例（未加载返回 null，调用方需先 loadOpenCV） */
export function getCv(): any {
  return instance?.Mat ? instance : null;
}

/** XHR 下载文本，带百分比进度（total 未知时按 10.4MB 估算） */
function downloadText(url: string, onProgress: (pct: number) => void): Promise<string> {
  const ESTIMATED = 10.4 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.onprogress = (e: ProgressEvent) => {
      if (xhr.status !== 200 && xhr.status !== 304) return;
      const total = e.total > 0 ? e.total : ESTIMATED;
      onProgress(Math.min(99, Math.round((e.loaded / total) * 100)));
    };
    xhr.onload = () => {
      if (xhr.status === 200 || xhr.status === 304) resolve(xhr.responseText);
      else reject(new Error(`opencv.js 下载失败（HTTP ${xhr.status}）`));
    };
    xhr.onerror = () => reject(new Error('opencv.js 网络错误'));
    xhr.send();
  });
}

/** 便捷工具：创建并登记 Mat，统一释放，防内存泄漏 */
export function createMatPool() {
  const mats: any[] = [];
  return {
    add<T>(m: T): T {
      mats.push(m);
      return m;
    },
    dispose() {
      for (const m of mats) {
        try {
          m.delete();
        } catch {
          /* 忽略重复释放 */
        }
      }
      mats.length = 0;
    },
  };
}
