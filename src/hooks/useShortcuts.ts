import { useEffect } from 'react';
import { useStore } from '../store/useStore';

/** 键盘快捷键：Delete 删页 / Ctrl+Z 撤销 / Ctrl+Y 重做 / ←→ 切页 */
export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      const s = useStore.getState();
      if (s.view !== 'editor') return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        s.redo();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (s.pages.length > 0) {
          e.preventDefault();
          s.removePage(s.current);
        }
      } else if (e.key === 'ArrowLeft') {
        s.setCurrent(Math.max(0, s.current - 1));
      } else if (e.key === 'ArrowRight') {
        s.setCurrent(Math.min(s.pages.length - 1, s.current + 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
