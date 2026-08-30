import { describe, it, expect } from 'vitest';
import { isFilterActive } from './enhance';
import { defaultFilter } from '../store/useStore';

describe('enhance.isFilterActive', () => {
  it('原图默认参数不触发滤镜管线', () => {
    expect(isFilterActive(defaultFilter('original'))).toBe(false);
  });

  it('magic 模式默认即活跃（strength=80）', () => {
    expect(isFilterActive(defaultFilter('magic'))).toBe(true);
  });

  it('任意滑块非默认值即活跃', () => {
    const f = defaultFilter('original');
    f.brightness = 10;
    expect(isFilterActive(f)).toBe(true);
  });
});