/** 归一化坐标点（0~1，相对图像宽高） */
export interface Point {
  x: number;
  y: number;
}

/** 滤镜模式 */
export type FilterMode = 'original' | 'magic' | 'color' | 'gray' | 'bw' | 'photo';

/** 每页滤镜/增强参数（全部可手动微调） */
export interface FilterState {
  mode: FilterMode;
  /** 智能增强强度 0~100（对应 0.0~1.0，仅 magic 模式） */
  strength: number;
  brightness: number; // -100~100
  contrast: number;   // -100~100
  saturation: number; // -100~100
  sharpen: number;    // 0~100（非锐化掩模强度）
  shadow: number;     // 0~100 去阴影强度
  cleanBg: number;    // 0~100 背景净化（白点校正）
  denoise: number;    // 0~100 降噪（bw 模式为中值滤波核）
  block: number;      // bw 自适应阈值邻域大小（奇数 3~99）
  cValue: number;     // bw 自适应阈值常数 C（-10~40）
}

/** 一页文档 */
export interface Page {
  id: string;
  /** 页面名称（导出与列表展示用） */
  name: string;
  /** 原始图像 Blob（HEIC 导入时已转为 JPEG；导出时用全分辨率） */
  blob: Blob;
  /** 编辑用低清预览 dataURL（长边 ≤1600） */
  preview: string;
  /** 缩略图 dataURL（长边 ≤320） */
  thumb: string;
  width: number;
  height: number;
  /** 文档四角（归一化，顺序 [左上,右上,右下,左下]），位于 rotation/flip 之后坐标系 */
  corners: Point[];
  /** 不规则多边形选区（归一化，位于透视矫正之后坐标系；null=不启用） */
  polygon: Point[] | null;
  rotation: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
  /** 自由微调角度（度，-15~15） */
  fineRotate: number;
  filter: FilterState;
  filterName: string;
  /** 涂抹擦除蒙版（归一化 PNG dataURL，白色=擦除区；null=无）。作用于滤镜处理后的图像 */
  eraseMask?: string | null;
}

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'success' | 'error';
  /** 可选操作按钮（如撤销删除） */
  action?: { label: string; run: () => void };
}

/** PDF 导出页面尺寸策略 */
export type PdfSize = 'a4' | 'fit' | 'fitWidth';

/** JPG 导出质量档 */
export type Quality = 'high' | 'mid' | 'low';

export interface ExportOptions {
  format: 'pdf' | 'jpg' | 'png';
  pageIds: string[] | 'all';
  pdfSize: PdfSize;
  quality: Quality;
  jpgQuality: number; // 1~100
  prefix: string;
  title: string;
  author: string;
}
