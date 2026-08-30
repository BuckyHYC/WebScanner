/**
 * 生成 UUID。优先原生 crypto.randomUUID（仅在安全上下文可用）；
 * 非安全上下文（http://局域网IP 访问等）回退到随机数实现，
 * 避免 crypto.randomUUID 为 undefined 时抛 TypeError 导致导入/复制功能崩溃。
 */
export function uid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}