import { describe, it, expect } from 'vitest';
import { maxEdgeByQuality, pageFileName } from './exporter';

describe('exporter', () => {
  it('maxEdgeByQuality 渲染边长映射', () => {
    expect(maxEdgeByQuality('high')).toBe(6000);
    expect(maxEdgeByQuality('mid')).toBe(2400);
    expect(maxEdgeByQuality('low')).toBe(1600);
  });

  it('pageFileName 生成三位序号文件名', () => {
    expect(pageFileName('Scan', 0)).toBe('Scan_001.jpg');
    expect(pageFileName('Scan', 9)).toBe('Scan_010.jpg');
    expect(pageFileName('Scan', 99)).toBe('Scan_100.jpg');
  });
});