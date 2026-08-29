import type { Page } from '../types';
import { useStore, defaultFilter, fullQuad } from '../store/useStore';
import { makePageBase } from './imageIO';
import { autoDetectPage } from './render';

/** 构造 Page 对象 */
function toPage(base: Awaited<ReturnType<typeof makePageBase>>, id: string): Page {
  return {
    id,
    ...base,
    corners: fullQuad(),
    polygon: null,
    rotation: 0,
    flipH: false,
    flipV: false,
    fineRotate: 0,
    filter: defaultFilter('original'),
    filterName: '原图',
  };
}

/** 导入文件（多选/粘贴/拖拽共用）：解码 → 建页 → 后台自动边缘检测 */
export async function importFiles(files: File[], insertAt?: number) {
  const imageFiles = files.filter(
    (f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|bmp|gif|tiff?|hei[cf])$/i.test(f.name),
  );
  if (imageFiles.length === 0) {
    useStore.getState().toast('没有可识别的图片文件', 'error');
    return;
  }
  useStore.getState().toast(`正在导入 ${imageFiles.length} 张图片…`);
  const s = useStore.getState();
  const start = insertAt ?? s.pages.length;
  const newPages: Page[] = [];
  for (let i = 0; i < imageFiles.length; i++) {
    try {
      const base = await makePageBase(imageFiles[i], start + i);
      newPages.push(toPage(base, crypto.randomUUID()));
    } catch (e) {
      console.error(e);
      useStore.getState().toast(`${imageFiles[i].name} 解码失败`, 'error');
    }
  }
  if (newPages.length === 0) return;
  if (insertAt === undefined) {
    useStore.getState().addPages(newPages);
  } else {
    // 指定位置插入：逐个 splice
    const st = useStore.getState();
    st.pushHistory();
    useStore.setState((prev) => {
      const pages = [...prev.pages];
      newPages.forEach((p, i) => pages.splice(start + i, 0, p));
      return { pages };
    });
  }
  useStore.getState().toast(`已导入 ${newPages.length} 页`, 'success');
  void backgroundDetect(newPages);
}

/** 后台逐页自动检测文档边缘（不写入撤销历史） */
export async function backgroundDetect(pages: Page[]) {
  for (const p of pages) {
    // 页面可能已被删除
    if (!useStore.getState().pages.some((x) => x.id === p.id)) continue;
    try {
      const quad = await autoDetectPage(p);
      if (quad) useStore.getState().updatePage(p.id, { corners: quad }, false);
    } catch (e) {
      console.warn('自动检测失败', e);
    }
  }
}
