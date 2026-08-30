import { describe, it, expect } from 'vitest';
import { dist, orderQuad, targetSizeFromQuad, clampQuad, quadShift } from './geometry';

describe('geometry', () => {
  it('orderQuad 按左上/右上/右下/左下排序', () => {
    const pts = [
      { x: 1, y: 1 }, // 右下
      { x: 0, y: 1 }, // 左下
      { x: 1, y: 0 }, // 右上
      { x: 0, y: 0 }, // 左上
    ];
    expect(orderQuad(pts)).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ]);
  });

  it('targetSizeFromQuad 以最长边估算目标尺寸', () => {
    // 宽 400 高 300 的矩形
    const px = [0, 0, 400, 0, 400, 300, 0, 300];
    expect(targetSizeFromQuad(px)).toEqual({ w: 400, h: 300 });
    // 最小 8px 保护
    expect(targetSizeFromQuad([0, 0, 1, 0, 1, 1, 0, 1])).toEqual({ w: 8, h: 8 });
  });

  it('clampQuad 把角点夹取到 [0,1]', () => {
    expect(clampQuad([{ x: -0.1, y: 1.6 }, { x: 0.5, y: -2 }])).toEqual([
      { x: 0, y: 1 },
      { x: 0.5, y: 0 },
    ]);
  });

  it('dist 计算欧氏距离', () => {
    expect(dist({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it('quadShift 返回平均角点位移', () => {
    const a = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    const b = [
      { x: 1, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    // 仅左上角移动 1，平均 = 1/4
    expect(quadShift(a, b)).toBeCloseTo(0.25);
  });
});