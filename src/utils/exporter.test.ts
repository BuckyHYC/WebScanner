import { describe, it, expect } from 'vitest';
import { maxEdgeByQuality, pageFileName, imageExt } from './exporter';
import type { ExportOptions } from '../types';

describe('exporter', () => {
  it('maxEdgeByQuality 渲染边长映射', () => {
    expect(maxEdgeByQuality('high')).toBe(6000);
    expect(maxEdgeByQuality('mid')).toBe(2400);
    expect(maxEdgeByQuality('low')).toBe(1600);
  });

  it('pageFileName 生成三位序号文件名（JPG/PNG 扩展名）', () => {
    expect(pageFileName('Scan', 0)).toBe('Scan_001.jpg');
    expect(pageFileName('Scan', 9)).toBe('Scan_010.jpg');
    expect(pageFileName('Scan', 99)).toBe('Scan_100.jpg');
    expect(pageFileName('Scan', 0, 'png')).toBe('Scan_001.png');
  });

  it('imageExt 按导出格式返回扩展名', () => {
    expect(imageExt({ format: 'png' } as ExportOptions)).toBe('png');
    expect(imageExt({ format: 'jpg' } as ExportOptions)).toBe('jpg');
    expect(imageExt({ format: 'pdf' } as ExportOptions)).toBe('jpg');
  });
});