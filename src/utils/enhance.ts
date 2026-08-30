import type { FilterState } from '../types';
import { createMatPool } from './opencvLoader';

/** 滤镜是否处于"全默认"状态（可跳过整条管线以提速） */
export function isFilterActive(f: FilterState): boolean {
  return (
    f.mode !== 'original' ||
    f.strength !== 0 ||
    f.brightness !== 0 ||
    f.contrast !== 0 ||
    f.saturation !== 0 ||
    f.sharpen !== 0 ||
    f.shadow !== 0 ||
    f.cleanBg !== 0 ||
    f.denoise !== 0
  );
}

function oddify(v: number, min = 3, max = 199): number {
  return Math.min(max, Math.max(min, Math.round(v) | 1));
}

/** 亮度/对比度 LUT：out = (in-128)*contrastFactor + 128 + brightnessOffset */
function buildBCLut(brightness: number, contrast: number): Uint8Array {
  const lut = new Uint8Array(256);
  const cf = (contrast + 100) / 100; // -100~100 → 0~2
  const bo = brightness * 1.28;
  for (let i = 0; i < 256; i++) {
    lut[i] = Math.min(255, Math.max(0, Math.round((i - 128) * cf + 128 + bo)));
  }
  return lut;
}

/** 对单通道/多通道 8U Mat 应用 256 项 LUT */
export function applyLut(cv: any, src: any, lut: Uint8Array): any {
  const lutMat = new cv.matFromArray(256, 1, cv.CV_8U, Array.from(lut));
  const dst = new cv.Mat();
  try {
    cv.LUT(src, lutMat, dst);
  } finally {
    lutMat.delete();
  }
  return dst;
}

/**
 * 彩色去阴影：复用 illuminationNormalize 的低分辨率形态学闭 + 高斯背景估计
 * （逐通道除法归一化去光照不均、保留色相），替代原全分辨率 medianBlur 的 O(k²) 慢路径。
 * strength 为与原图混合比例 0~100。
 */
function shadowRemoveColor(cv: any, rgba: any, strength: number): any {
  const base = illuminationNormalize(cv, rgba); // BGR，已去阴影
  const baseRgba = new cv.Mat();
  const mixed = new cv.Mat();
  try {
    cv.cvtColor(base, baseRgba, cv.COLOR_BGR2RGBA);
    const a = strength / 100;
    cv.addWeighted(baseRgba, a, rgba, 1 - a, 0, mixed);
    return mixed.clone();
  } finally {
    base.delete();
    baseRgba.delete();
    mixed.delete();
  }
}

/**
 * 灰度去阴影（bw 模式用）：低分辨率形态学闭 + 高斯估计背景光照层，
 * norm = clip(gray/bg*255)，替代全分辨率 medianBlur 慢路径。
 */
function shadowRemoveGray(cv: any, gray: any, strength: number): any {
  const pool = createMatPool();
  try {
    const scale = Math.min(1, 384 / gray.cols);
    const sw = Math.max(32, Math.round(gray.cols * scale));
    const sh = Math.max(32, Math.round(gray.rows * scale));
    const small = pool.add(new cv.Mat());
    cv.resize(gray, small, new cv.Size(sw, sh), 0, 0, cv.INTER_AREA);
    const kern = oddify(Math.round(Math.min(sw, sh) / 6), 15, 121);
    const kernel = pool.add(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(kern, kern)));
    const closed = pool.add(new cv.Mat());
    cv.morphologyEx(small, closed, cv.MORPH_CLOSE, kernel);
    const bgSmall = pool.add(new cv.Mat());
    cv.GaussianBlur(closed, bgSmall, new cv.Size(0, 0), kern / 3, kern / 3, cv.BORDER_DEFAULT);
    const bg = pool.add(new cv.Mat());
    cv.resize(bgSmall, bg, new cv.Size(gray.cols, gray.rows), 0, 0, cv.INTER_LINEAR);
    const norm = pool.add(new cv.Mat());
    cv.divide(gray, bg, norm, 255, -1);
    const a = strength / 100;
    const out = new cv.Mat();
    cv.addWeighted(norm, a, gray, 1 - a, 0, out);
    return out.clone();
  } finally {
    pool.dispose();
  }
}

/** 背景净化（白点校正）：按各通道高百分位白点拉伸，strength 为混合比例 */
function cleanBackground(cv: any, rgba: any, strength: number): any {
  const pool = createMatPool();
  try {
    const data = rgba.data;
    const step = 4 * 7; // 隔 7 像素采样提速
    const hists = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    let total = 0;
    for (let i = 0; i < data.length; i += step) {
      hists[0][data[i]]++;
      hists[1][data[i + 1]]++;
      hists[2][data[i + 2]]++;
      total++;
    }
    // 取 97.5% 分位作为白点
    const target = total * 0.975;
    const luts = hists.map((h) => {
      let acc = 0;
      let white = 255;
      for (let v = 255; v >= 0; v--) {
        acc += h[v];
        if (acc >= target) {
          white = Math.max(64, v);
          break;
        }
      }
      const lut = new Uint8Array(256);
      for (let v = 0; v < 256; v++) lut[v] = Math.min(255, Math.round((v * 255) / white));
      return lut;
    });
    const chans = pool.add(new cv.MatVector());
    cv.split(rgba, chans);
    const outChans = pool.add(new cv.MatVector());
    for (let c = 0; c < 3; c++) {
      const ch = chans.get(c);
      const stretched = applyLut(cv, ch, luts[c]);
      outChans.push_back(stretched);
      ch.delete();
      stretched.delete();
    }
    outChans.push_back(chans.get(3));
    const merged = pool.add(new cv.Mat());
    cv.merge(outChans, merged);
    const a = strength / 100;
    const out = new cv.Mat();
    cv.addWeighted(merged, a, rgba, 1 - a, 0, out);
    return out;
  } finally {
    pool.dispose();
  }
}

/**
 * 背景光照归一化：低分辨率上形态学闭 + 高斯平滑估计背景光照层，
 * 逐通道除法 norm = src*255/bg —— 阴影/光照不均被消除，背景自动映射到 ~255。
 * 输入 RGBA，返回新 BGR Mat（调用方负责释放）。
 */
function illuminationNormalize(cv: any, rgba: any): any {
  const pool = createMatPool();
  try {
    const bgr = pool.add(new cv.Mat());
    cv.cvtColor(rgba, bgr, cv.COLOR_RGBA2BGR);

    // 光照是低频成分：在低分辨率上估计背景（快且稳），再放大回原尺寸
    const scale = Math.min(1, 384 / bgr.cols);
    const sw = Math.max(32, Math.round(bgr.cols * scale));
    const sh = Math.max(32, Math.round(bgr.rows * scale));
    const small = pool.add(new cv.Mat());
    cv.resize(bgr, small, new cv.Size(sw, sh), 0, 0, cv.INTER_AREA);

    // 形态学闭操作：把暗色文字笔画从背景层中抹掉（核大小约为小图短边的 1/6）
    const kern = oddify(Math.round(Math.min(sw, sh) / 6), 15, 121);
    const kernel = pool.add(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(kern, kern)));
    const closed = pool.add(new cv.Mat());
    cv.morphologyEx(small, closed, cv.MORPH_CLOSE, kernel);

    // 高斯平滑光照层，避免放大后出现光晕
    const bgSmall = pool.add(new cv.Mat());
    cv.GaussianBlur(closed, bgSmall, new cv.Size(0, 0), kern / 3, kern / 3, cv.BORDER_DEFAULT);

    const bg = pool.add(new cv.Mat());
    cv.resize(bgSmall, bg, new cv.Size(bgr.cols, bgr.rows), 0, 0, cv.INTER_LINEAR);

    const base = pool.add(new cv.Mat());
    cv.divide(bgr, bg, base, 255, -1);
    return base.clone();
  } finally {
    pool.dispose();
  }
}

/** 饱和度缩放：HSV 的 S 通道乘 factor。输入输出均为 RGBA */
function saturationScale(cv: any, rgba: any, factor: number): any {
  const pool = createMatPool();
  try {
    const rgb = pool.add(new cv.Mat());
    cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
    const hsv = pool.add(new cv.Mat());
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    const chans = pool.add(new cv.MatVector());
    cv.split(hsv, chans);
    const s = chans.get(1);
    const s2 = new cv.Mat();
    cv.convertScaleAbs(s, s2, factor, 0);
    s.delete();
    const merged = pool.add(new cv.MatVector());
    merged.push_back(chans.get(0));
    merged.push_back(s2);
    merged.push_back(chans.get(2));
    const hsv2 = pool.add(new cv.Mat());
    cv.merge(merged, hsv2);
    const rgb2 = pool.add(new cv.Mat());
    cv.cvtColor(hsv2, rgb2, cv.COLOR_HSV2RGB);
    const out = pool.add(new cv.Mat());
    cv.cvtColor(rgb2, out, cv.COLOR_RGB2RGBA);
    return out.clone();
  } finally {
    pool.dispose();
  }
}

/**
 * 彩色文档增强（color 模式）：去阴影/泛黄 + 白背景 + 保彩鲜。
 * 1) 光照归一化：低分辨率背景层逐通道除法（等比保留色相比），阴影/泛黄一次消除
 * 2) 灰度白点拉伸：背景推到纯白
 * 3) 饱和度补偿 ×1.3：把除法+拉伸淡化的前景色彩补回鲜艳
 * 4) 轻度非锐化掩模
 */
function colorEnhance(cv: any, rgba: any): any {
  const pool = createMatPool();
  try {
    // ---- 1) 光照归一化（逐通道除法，背景→~255，色相保留）----
    const base = pool.add(illuminationNormalize(cv, rgba)); // BGR
    const baseRgba = pool.add(new cv.Mat());
    cv.cvtColor(base, baseRgba, cv.COLOR_BGR2RGBA);

    // ---- 2) 灰度白点拉伸：背景推到纯白 ----
    const stretched = pool.add(whitePointStretch(cv, baseRgba, 0.96, 8));

    // ---- 3) 饱和度补偿 ×1.7 ----
    const composited = pool.add(saturationScale(cv, stretched, 1.7));

    // ---- 4) 轻度锐化 ----
    const blur = pool.add(new cv.Mat());
    cv.GaussianBlur(composited, blur, new cv.Size(0, 0), 1.2, 1.2, cv.BORDER_DEFAULT);
    const out = pool.add(new cv.Mat());
    cv.addWeighted(composited, 1.3, blur, -0.3, 0, out);
    return out.clone();
  } finally {
    pool.dispose();
  }
}

/**
 * 估计背景光照层（32F 灰度）：低分辨率形态学闭 + 高斯平滑后放大回原尺寸。
 * 输入 RGBA，返回单通道 CV_32F Mat（调用方负责释放）。
 */
function estimateBackgroundGray(cv: any, rgba: any): any {
  const pool = createMatPool();
  try {
    const gray = pool.add(new cv.Mat());
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    const scale = Math.min(1, 384 / gray.cols);
    const sw = Math.max(32, Math.round(gray.cols * scale));
    const sh = Math.max(32, Math.round(gray.rows * scale));
    const small = pool.add(new cv.Mat());
    cv.resize(gray, small, new cv.Size(sw, sh), 0, 0, cv.INTER_AREA);
    const kern = oddify(Math.round(Math.min(sw, sh) / 6), 15, 121);
    const kernel = pool.add(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(kern, kern)));
    const closed = pool.add(new cv.Mat());
    cv.morphologyEx(small, closed, cv.MORPH_CLOSE, kernel);
    const bgSmall = pool.add(new cv.Mat());
    cv.GaussianBlur(closed, bgSmall, new cv.Size(0, 0), kern / 3, kern / 3, cv.BORDER_DEFAULT);
    const bg = pool.add(new cv.Mat());
    cv.resize(bgSmall, bg, new cv.Size(gray.cols, gray.rows), 0, 0, cv.INTER_LINEAR);
    const bgF = new cv.Mat();
    bg.convertTo(bgF, cv.CV_32F, 1, 0);
    return bgF.clone(); // 必须克隆：pool.dispose 会释放未克隆的中间 Mat
  } finally {
    pool.dispose();
  }
}

/**
 * 智能增强（类 CamScanner「智能增强」），k = 增强强度 0~1：
 * 1) 阴影/光照去除：低分辨率上形态学闭 + 高斯平滑估计背景光照层，逐通道除法归一化（背景→纯白）
 * 2) 自适应局部对比度：CLAHE 作用在亮度通道（clipLimit 随强度提升）
 * 3) 白点拉伸：把背景灰度映射到 255，黑色文字保持纯黑
 * 4) 非锐化掩模：文字边缘锐化
 * 5) 最终与光照归一化底图按 k 混合（k=0 仅干净底图，k=1 全部增强）
 */
function magicSmartEnhance(cv: any, rgba: any, k: number): any {
  const pool = createMatPool();
  try {
    // ---- 1) 背景光照层估计与除法归一化 ----
    const base = pool.add(illuminationNormalize(cv, rgba)); // BGR
    const baseRgba = pool.add(new cv.Mat());
    cv.cvtColor(base, baseRgba, cv.COLOR_BGR2RGBA);

    // ---- 2) CLAHE 自适应局部对比度（亮度通道）----
    // 该构建没有 Lab 转换，用灰度作为亮度层：CLAHE 增强后的灰度与原灰度的比值
    // 按比例乘回 RGB —— 提升局部对比度的同时保留色相。
    const grayOld = pool.add(new cv.Mat());
    cv.cvtColor(baseRgba, grayOld, cv.COLOR_RGBA2GRAY);
    const grayNew = pool.add(new cv.Mat());
    const clahe = new cv.CLAHE(1.0 + 2.5 * k, new cv.Size(8, 8));
    clahe.apply(grayOld, grayNew);
    clahe.delete?.();

    // ratio = newGray / oldGray（32F 精确除法，避免 8U 截断），再乘回各通道
    const ratioF = pool.add(new cv.Mat());
    const grayOldF = pool.add(new cv.Mat());
    const grayNewF = pool.add(new cv.Mat());
    grayOld.convertTo(grayOldF, cv.CV_32F, 1 / 255, 1e-3); // 加小常数防除零
    grayNew.convertTo(grayNewF, cv.CV_32F, 1 / 255, 0);
    cv.divide(grayNewF, grayOldF, ratioF);
    grayOldF.delete();
    grayNewF.delete();

    // ratio 扩成 3 通道，与 BGR 逐像素相乘（混合精度/通道数不匹配会触发 emscripten 断言）
    const ratio3 = pool.add(new cv.Mat());
    const ratioMv = pool.add(new cv.MatVector());
    ratioMv.push_back(ratioF);
    ratioMv.push_back(ratioF);
    ratioMv.push_back(ratioF);
    cv.merge(ratioMv, ratio3);

    const bgrF = pool.add(new cv.Mat());
    base.convertTo(bgrF, cv.CV_32F, 1, 0);
    const boosted3 = pool.add(new cv.Mat());
    cv.multiply(bgrF, ratio3, boosted3, 1, cv.CV_32F);
    const boosted = pool.add(new cv.Mat());
    boosted3.convertTo(boosted, cv.CV_8U, 1, 0);
    const boostedRgba = pool.add(new cv.Mat());
    cv.cvtColor(boosted, boostedRgba, cv.COLOR_BGR2RGBA);

    // ---- 3) 白点拉伸：把背景映射到纯白（255），文字保持纯黑 ----
    const stretch = pool.add(whitePointStretch(cv, boostedRgba, 0.96, 8));

    // ---- 4) 非锐化掩模：文字边缘锐化 ----
    const blur = pool.add(new cv.Mat());
    cv.GaussianBlur(stretch, blur, new cv.Size(0, 0), 1.5, 1.5, cv.BORDER_DEFAULT);
    const amt = 0.3 + 0.5 * k;
    const sharp = pool.add(new cv.Mat());
    cv.addWeighted(stretch, 1 + amt, blur, -amt, 0, sharp);

    // ---- 5) 与光照归一化底图按强度混合 ----
    const out = pool.add(new cv.Mat());
    cv.addWeighted(sharp, k, baseRgba, 1 - k, 0, out);
    return out.clone();
  } finally {
    pool.dispose();
  }
}

/**
 * 白点拉伸（灰度直方图百分位 → 线性 LUT）：
 * out = clip((in - black) * 255 / (white - black))，背景→纯白，文字保持纯黑。
 */
function whitePointStretch(cv: any, rgba: any, percentile: number, blackPoint: number): any {
  const gray = new cv.Mat();
  const hist = new cv.Mat();
  const planes = new cv.MatVector();
  const mask = new cv.Mat();
  try {
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    // calcHist 需要以 MatVector 传入图像
    planes.push_back(gray);
    // 256 桶灰度直方图
    cv.calcHist(planes, [0], mask, hist, [256], [0, 256]);
    const total = gray.rows * gray.cols;
    const target = total * percentile;
    const h = hist.data32F;
    let acc = 0;
    let white = 255;
    for (let v = 0; v < 256; v++) {
      acc += h[v];
      if (acc >= target) {
        white = v;
        break;
      }
    }
    white = Math.max(96, Math.min(255, white)); // 防异常直方图
    const b = Math.max(0, Math.min(blackPoint, white - 32));
    const lut = new Uint8Array(256);
    const denom = white - b;
    for (let v = 0; v < 256; v++) {
      lut[v] = Math.min(255, Math.max(0, Math.round(((v - b) * 255) / denom)));
    }
    // 仅作用于 RGB 三通道
    const chans = new cv.MatVector();
    const outChans = new cv.MatVector();
    const merged = new cv.Mat();
    try {
      cv.split(rgba, chans);
      for (let c = 0; c < 4; c++) {
        const ch = chans.get(c);
        const luted = c < 3 ? applyLut(cv, ch, lut) : ch.clone();
        outChans.push_back(luted);
        ch.delete();
        luted.delete();
      }
      cv.merge(outChans, merged);
      return merged.clone();
    } finally {
      chans.delete();
      outChans.delete();
      merged.delete();
    }
  } finally {
    planes.delete();
    mask.delete();
    hist.delete();
    gray.delete();
  }
}

/**
 * 核心滤镜管线：输入 RGBA Mat，返回新的 RGBA Mat（调用方负责 delete 输入）。
 * 处理顺序：去阴影 → 模式特化 → 亮度/对比度 → 饱和度 → 锐化
 */
export function enhanceMat(cv: any, rgba: any, f: FilterState): any {
  if (!isFilterActive(f)) return rgba.clone();
  const pool = createMatPool();
  try {
    let work = pool.add(rgba.clone());

    if (f.shadow > 0) {
      const fixed =
        f.mode === 'bw'
          ? undefined // bw 在灰度域处理
          : shadowRemoveColor(cv, work, f.shadow);
      if (fixed) {
        work.delete();
        work = pool.add(fixed);
      }
    }

    if (f.cleanBg > 0 && f.mode !== 'bw') {
      const cleaned = cleanBackground(cv, work, f.cleanBg);
      work.delete();
      work = pool.add(cleaned);
    }

    if (f.mode === 'bw') {
      // ===== 黑白：灰度域去阴影 → 亮度对比度 → 降噪 → 自适应阈值 =====
      const gray = pool.add(new cv.Mat());
      cv.cvtColor(work, gray, cv.COLOR_RGBA2GRAY);
      work.delete();
      let g: any = gray;
      if (f.shadow > 0) {
        const fixed = shadowRemoveGray(cv, g, f.shadow);
        g.delete();
        g = fixed;
      }
      if (f.brightness !== 0 || f.contrast !== 0) {
        const luted = applyLut(cv, g, buildBCLut(f.brightness, f.contrast));
        g.delete();
        g = luted;
      }
      if (f.denoise > 0) {
        const k = oddify(3 + 2 * Math.floor(f.denoise / 25), 3, 11);
        const den = new cv.Mat();
        cv.medianBlur(g, den, k);
        g.delete();
        g = den;
      }
      const bin = new cv.Mat();
      // 自适应阈值：按局部邻域高斯加权均值 - C 计算黑白分界，抗光照不均
      cv.adaptiveThreshold(
        g,
        bin,
        255,
        cv.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv.THRESH_BINARY,
        oddify(f.block),
        f.cValue,
      );
      g.delete();
      const out = pool.add(new cv.Mat());
      cv.cvtColor(bin, out, cv.COLOR_GRAY2RGBA);
      bin.delete();
      const ret = out.clone();
      return ret;
    }

    // ===== 模式特化（彩色域）=====
    if (f.mode === 'magic') {
      // 智能增强：光照归一化 + CLAHE 局部对比度 + 白点拉伸 + 锐化，强度 k 控制
      const k = Math.min(1, Math.max(0, (Number(f.strength) || 0) / 100));
      const enhanced = magicSmartEnhance(cv, work, k);
      work.delete();
      work = pool.add(enhanced);
    } else if (f.mode === 'color') {
      // 彩色文档：去阴影/泛黄 + 自动白平衡 + 提饱和 + 轻锐化（保留彩色）
      const enhanced = colorEnhance(cv, work);
      work.delete();
      work = pool.add(enhanced);
    } else if (f.mode === 'gray') {
      const g = pool.add(new cv.Mat());
      const out = pool.add(new cv.Mat());
      cv.cvtColor(work, g, cv.COLOR_RGBA2GRAY);
      cv.cvtColor(g, out, cv.COLOR_GRAY2RGBA);
      work.delete();
      work = pool.add(out.clone());
    } else if (f.mode === 'photo' && f.denoise > 0) {
      // 照片模式：轻度降噪保留连续色调
      const den = pool.add(new cv.Mat());
      cv.medianBlur(work, den, 3);
      const a = Math.min(0.8, f.denoise / 100);
      const out = pool.add(new cv.Mat());
      cv.addWeighted(den, a, work, 1 - a, 0, out);
      work.delete();
      work = pool.add(out.clone());
    }

    // ===== 通用滑块 =====
    if (f.brightness !== 0 || f.contrast !== 0) {
      const pool2 = createMatPool();
      try {
        const chans = pool2.add(new cv.MatVector());
        cv.split(work, chans);
        const lut = buildBCLut(f.brightness, f.contrast);
        const outChans = pool2.add(new cv.MatVector());
        for (let c = 0; c < 4; c++) {
          const ch = chans.get(c);
          const luted = c < 3 ? applyLut(cv, ch, lut) : ch.clone();
          outChans.push_back(luted);
          ch.delete();
          luted.delete();
        }
        const merged = pool2.add(new cv.Mat());
        cv.merge(outChans, merged);
        work.delete();
        work = pool.add(merged.clone());
      } finally {
        pool2.dispose();
      }
    }

    // 饱和度：HSV 的 S 通道缩放（灰度/黑白无意义，跳过）
    if (f.saturation !== 0 && (f.mode === 'color' || f.mode === 'magic' || f.mode === 'photo' || f.mode === 'original')) {
      const pool3 = createMatPool();
      try {
        const hsv = pool3.add(new cv.Mat());
        cv.cvtColor(work, hsv, cv.COLOR_RGBA2RGB);
        const rgb2 = pool3.add(new cv.Mat());
        cv.cvtColor(hsv, rgb2, cv.COLOR_RGB2HSV);
        const chans = pool3.add(new cv.MatVector());
        cv.split(rgb2, chans);
        const s = chans.get(1);
        const s2 = new cv.Mat();
        cv.convertScaleAbs(s, s2, 1 + f.saturation / 100, 0);
        s.delete();
        const merged = pool3.add(new cv.MatVector());
        merged.push_back(chans.get(0));
        merged.push_back(s2);
        merged.push_back(chans.get(2));
        const hsv2 = pool3.add(new cv.Mat());
        cv.merge(merged, hsv2);
        const rgb3 = pool3.add(new cv.Mat());
        cv.cvtColor(hsv2, rgb3, cv.COLOR_HSV2RGB);
        const out = pool3.add(new cv.Mat());
        cv.cvtColor(rgb3, out, cv.COLOR_RGB2RGBA);
        work.delete();
        work = pool.add(out.clone());
      } finally {
        pool3.dispose();
      }
    }

    // 锐化：非锐化掩模 out = src*(1+a) + blur*(-a)
    if (f.sharpen > 0) {
      const blur = pool.add(new cv.Mat());
      cv.GaussianBlur(work, blur, new cv.Size(0, 0), 1.5, 1.5, cv.BORDER_DEFAULT);
      const a = (f.sharpen / 100) * 0.8;
      const out = pool.add(new cv.Mat());
      cv.addWeighted(work, 1 + a, blur, -a, 0, out);
      work.delete();
      work = pool.add(out.clone());
    }

    return work.clone();
  } finally {
    pool.dispose();
  }
}
