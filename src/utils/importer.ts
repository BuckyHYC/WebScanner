import type { Page } from '../types';
import { useStore, defaultFilter, fullQuad } from '../store/useStore';
import { decodeImageFiles, isSupportedImportFile } from './imageIO';
import type { DecodedImage } from './imageIO';
import { autoDetectPage } from './render';
import { uid } from './uid';
import { createDraft, DEFAULT_DRAFT_NAME } from './draftsDb';
import { resetSyncBaseline } from './draftSync';
import { openEditorRoute } from './router';

/** 构造 Page 对象 */
function toPage(base: DecodedImage, id: string, index: number, name?: string): Page {
  return {
    id,
    name: name ?? `扫描_${String(index + 1).padStart(3, '0')}`,
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
  const importable = files.filter(isSupportedImportFile);
  if (importable.length === 0) {
    useStore.getState().toast('没有可识别的文件（支持图片 / TIFF / HEIC / PDF）', 'error');
    return;
  }
  const pdfCount = importable.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name)).length;
  useStore.getState().toast(
    pdfCount > 0
      ? `正在导入 ${importable.length} 个文件${pdfCount === importable.length ? '（PDF 逐页解析中…）' : '…'}`
      : `正在导入 ${importable.length} 张图片…`,
  );
  const s = useStore.getState();
  const start = insertAt ?? s.pages.length;
  const newPages: Page[] = [];
  let seq = start;
  for (let i = 0; i < importable.length; i++) {
    const file = importable[i];
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    /** PDF 多页时用「文件名·页码」命名，便于区分来源文档 */
    const baseName = file.name.replace(/\.[^.]+$/, '').slice(0, 32);
    try {
      const bases = await decodeImageFiles(file, (done, total) => {
        if (total > 1) useStore.getState().toast(`PDF 解析中：${done}/${total} 页`);
      });
      for (let k = 0; k < bases.length; k++) {
        const name = isPdf && bases.length > 1 ? `${baseName} 第${k + 1}页` : undefined;
        newPages.push(toPage(bases[k], uid(), seq++, name));
      }
    } catch (e) {
      console.error(e);
      // 解码失败细分提示：大文件大概率超出浏览器 canvas/内存上限
      const sizeMB = file.size / (1024 * 1024);
      const hint = isPdf
        ? '（PDF 可能已加密或已损坏）'
        : sizeMB > 30
          ? '（图片可能过大，请压缩后重试）'
          : '（文件损坏或格式不支持）';
      useStore.getState().toast(`${file.name} 解码失败${hint}`, 'error');
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
