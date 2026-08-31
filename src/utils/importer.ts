import type { Page } from '../types';
import { useStore, defaultFilter, fullQuad } from '../store/useStore';
import { decodeImageFiles } from './imageIO';
import type { DecodedImage } from './imageIO';
import { autoDetectPage } from './render';
import { uid } from './uid';
import { createDraft, DEFAULT_DRAFT_NAME } from './draftsDb';
import { resetSyncBaseline } from './draftSync';
import { openEditorRoute } from './router';

/** 构造 Page 对象 */
function toPage(base: DecodedImage, id: string, index: number): Page {
  return {
    id,
    name: `扫描_${String(index + 1).padStart(3, '0')}`,
    blob: base.blob,
    preview: base.preview,
    thumb: base.thumb,
    width: base.width,
    height: base.height,
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
  let seq = start;
  for (let i = 0; i < imageFiles.length; i++) {
    try {
      const bases = await decodeImageFiles(imageFiles[i]);
      for (const base of bases) {
        newPages.push(toPage(base, uid(), seq++));
      }
    } catch (e) {
      console.error(e);
      // 解码失败细分提示：大文件大概率超出浏览器 canvas/内存上限
      const sizeMB = imageFiles[i].size / (1024 * 1024);
      const hint = sizeMB > 30 ? '（图片可能过大，请压缩后重试）' : '（文件损坏或格式不支持）';
      useStore.getState().toast(`${imageFiles[i].name} 解码失败${hint}`, 'error');
    }
  }
  if (newPages.length === 0) return;
  if (insertAt === undefined) {
    const st = useStore.getState();
    if (st.draftId === null) {
      // 首页导入（选择图片/粘贴/拖拽/拍照首张）：新建草稿并进入编辑页
      const id = await createDraft();
      useStore.setState({ draftId: id, draftName: DEFAULT_DRAFT_NAME });
      resetSyncBaseline([]);
      openEditorRoute(id);
    }
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
      const outcome = await autoDetectPage(p);
      if (outcome) useStore.getState().updatePage(p.id, { corners: outcome.quad }, false);
    } catch (e) {
      console.warn('自动检测失败', e);
    }
  }
}
