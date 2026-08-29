/**
 * OpenCV.js 懒加载器
 * @techstark/opencv-js 在 import 后 Wasm 运行时异步初始化，
 * 以 cv.Mat 是否可用作为就绪标志轮询，全局单例。
 */
let instance: any = null;
let pending: Promise<any> | null = null;

export async function loadOpenCV(): Promise<any> {
  if (instance?.Mat) return instance;
  if (pending) return pending;
  pending = (async () => {
    // 动态 import：不阻塞首屏，且独立分包
    const mod: any = await import('@techstark/opencv-js');
    const m = mod?.default ?? mod;
    await new Promise<void>((resolve) => {
      if (m?.Mat) return resolve();
      const timer = setInterval(() => {
        if (m?.Mat) {
          clearInterval(timer);
          resolve();
        }
      }, 50);
    });
    instance = m;
    return m;
  })();
  return pending;
}

/** 获取已加载实例（未加载返回 null，调用方需先 loadOpenCV） */
export function getCv(): any {
  return instance?.Mat ? instance : null;
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
