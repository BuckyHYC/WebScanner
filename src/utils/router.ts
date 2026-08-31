/**
 * 轻量 hash 路由：#/ 首页、#/editor/<draftId> 编辑页。
 * 选 hash 而非 history 路由：与 base './' 相对路径部署及 PWA
 * navigateFallback 完全兼容，移动端系统返回键天然可用。
 */
export type Route = { view: 'home' } | { view: 'editor'; draftId: number };

export function parseRoute(): Route {
  const h = window.location.hash.replace(/^#/, '');
  const m = /^\/editor\/(\d+)/.exec(h);
  if (m) return { view: 'editor', draftId: Number(m[1]) };
  return { view: 'home' };
}

/** 记录本会话内是否发生过内部导航（决定返回用 history.back 还是 hash 赋值） */
let navigatedInternally = false;

export function navigate(to: string) {
  if (window.location.hash === to) return;
  navigatedInternally = true;
  window.location.hash = to;
}

export function goHome() {
  navigate('#/');
}

export function openEditorRoute(draftId: number) {
  navigate(`#/editor/${draftId}`);
}

/** 返回上一页：本会话内有内部导航时走 history.back（不残留历史栈），否则落到首页 */
export function goBack() {
  if (navigatedInternally && window.history.length > 1 && window.location.hash !== '#/' && window.location.hash !== '') {
    window.history.back();
  } else {
    navigatedInternally = true;
    window.location.hash = '#/';
  }
}

export function watchRoute(cb: (r: Route) => void): () => void {
  const on = () => cb(parseRoute());
  window.addEventListener('hashchange', on);
  return () => window.removeEventListener('hashchange', on);
}
