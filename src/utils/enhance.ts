import type { FilterState } from '../types';
import { createMatPool } from './opencvLoader';

/** 滤镜是否处于"全默认"状态（可跳过整条管线以提速） */
export function isFilterActive(f: FilterState): boolean {
  return (
    f.mode !== 'original' ||
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
 * 彩色去阴影：整图大核中值滤波估计光照背景（3 通道一次完成），
 * out = clip(src * 255 / bg) —— 各通道等比归一化，保留色相，仅去除光照不均。
 * strength 为与原图混合比例 0~100。
 */
function shadowRemoveColor(cv: any, rgba: any, strength: number, kSize: number): any {
  const bgr = new cv.Mat();
  const bg = new cv.Mat();
  const norm = new cv.Mat();
  const mixed = new cv.Mat();
  const out = new cv.Mat();
  try {
    cv.cvtColor(rgba, bgr, cv.COLOR_RGBA2BGR);
    cv.medianBlur(bgr, bg, oddify(kSize, 21, 99));
    // dst = src * 255 / bg：光照归一化（除法饱和到 8U）
    cv.divide(bgr, bg, norm, 255, -1);
    const a = strength / 100;
    cv.addWeighted(norm, a, bgr, 1 - a, 0, mixed);
    cv.cvtColor(mixed, out, cv.COLOR_BGR2RGBA);
    return out.clone();
  } finally {
    bgr.delete();
    bg.delete();
    norm.delete();
    mixed.delete();
    out.delete();
  }
}

/** 灰度去阴影（bw 模式用）：norm = clip(gray/bg*255) */
function shadowRemoveGray(cv: any, gray: any, strength: number, kSize: number): any {
  const bg = new cv.Mat();
  const norm = new cv.Mat();
  try {
    cv.medianBlur(gray, bg, oddify(kSize, 21, 99));
    cv.divide(gray, bg, norm, 255, -1);
    const a = strength / 100;
    const out = new cv.Mat();
    cv.addWeighted(norm, a, gray, 1 - a, 0, out);
    bg.delete();
    return out;
  } catch (e) {
    bg.delete();
    norm.delete();
    throw e;
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
 * 核心滤镜管线：输入 RGBA Mat，返回新的 RGBA Mat（调用方负责 delete 输入）。
 * 处理顺序：去阴影 → 模式特化 → 亮度/对比度 → 饱和度 → 锐化
 */
export function enhanceMat(cv: any, rgba: any, f: FilterState): any {
  if (!isFilterActive(f)) return rgba.clone();
  const pool = createMatPool();
  try {
    let work = pool.add(rgba.clone());
    const minDim = Math.min(rgba.cols, rgba.rows);
    const shadowK = Math.max(21, Math.round(minDim / 33));

    if (f.shadow > 0) {
      const fixed =
        f.mode === 'bw'
          ? undefined // bw 在灰度域处理
          : shadowRemoveColor(cv, work, f.shadow, shadowK);
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
        const fixed = shadowRemoveGray(cv, g, f.shadow, shadowK);
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
      // 自动增强：Lab 亮度通道 CLAHE 局部对比度增强
      const lab = pool.add(new cv.Mat());
      cv.cvtColor(work, lab, cv.COLOR_RGBA2Lab);
      const chans = pool.add(new cv.MatVector());
      cv.split(lab, chans);
      const clahe = cv.createCLAHE(2.0, new cv.Size(8, 8));
      const l = chans.get(0);
      const l2 = new cv.Mat();
      clahe.apply(l, l2);
      clahe.delete();
      l.delete();
      const merged = pool.add(new cv.MatVector());
      merged.push_back(l2);
      for (let i = 1; i < 3; i++) merged.push_back(chans.get(i));
      const lab2 = pool.add(new cv.Mat());
      cv.merge(merged, lab2);
      const out = pool.add(new cv.Mat());
      cv.cvtColor(lab2, out, cv.COLOR_Lab2RGBA);
      work.delete();
      work = pool.add(out.clone());
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
