import { describe, expect, it } from 'vitest';
import { convertOtslToHtml } from './otsl';
import { cleanTruncatedRepeats, finalizeDocument, postprocessMathDelimiters, postprocessOtslTables } from './document';

describe('OTSL → HTML 表格', () => {
  it('规则表格逐行转 td', () => {
    const otsl = '<fcel>项目<fcel>数值<fcel>备注<nl><fcel>识别引擎<fcel>Xiaomi-OCR-0<fcel>本机运行<nl>';
    expect(convertOtslToHtml(otsl)).toBe(
      '<table><tr><td>项目</td><td>数值</td><td>备注</td></tr>' +
        '<tr><td>识别引擎</td><td>Xiaomi-OCR-0</td><td>本机运行</td></tr></table>',
    );
  });

  it('lcel 生成 colspan', () => {
    const html = convertOtslToHtml('<fcel>A<lcel><nl><fcel>B<fcel>C<nl>');
    expect(html).toContain('<td colspan="2">A</td>');
    expect(html).toContain('<td>B</td><td>C</td>');
  });

  it('ucel 生成 rowspan', () => {
    const html = convertOtslToHtml('<fcel>A<fcel>B<nl><ucel><fcel>C<nl>');
    expect(html).toContain('<td rowspan="2">A</td>');
    expect(html).toContain('<td>B</td>');
  });

  it('空单元格与行宽对齐', () => {
    const html = convertOtslToHtml('<fcel>A<ecel><nl><fcel>B<fcel>C<nl>');
    expect(html).toContain('<td>A</td><td></td>');
  });

  it('无换行标记时按单行处理', () => {
    expect(convertOtslToHtml('<fcel>只有一格')).toBe('<table><tr><td>只有一格</td></tr></table>');
  });

  it('空输入返回空串', () => {
    expect(convertOtslToHtml('')).toBe('');
  });
});

describe('整页 Markdown 后处理', () => {
  it('LaTeX 方括号定界符归一化为 $$', () => {
    expect(postprocessMathDelimiters('前文 \\[ x^2 \\] 后文')).toContain('$$ x^2 $$');
  });

  it('LaTeX 圆括号定界符归一化为 $', () => {
    expect(postprocessMathDelimiters('前文 \\( a+b \\) 后文')).toContain('$ a+b $');
  });

  it('代码围栏内的 OTSL 标记不转换', () => {
    // 围栏在第一个块开启、第二个块仍在围栏内（与上游 postprocess 的 in_fence 语义一致）
    const src = '```\n<fcel>A<nl>\n\n<fcel>B<nl>';
    expect(postprocessOtslTables(src)).toBe(src);
  });

  it('普通块中的 OTSL 转成 HTML 表格', () => {
    const out = postprocessOtslTables('<fcel>A<fcel>B<nl>');
    expect(out).toContain('<table>');
    expect(out).toContain('<td>A</td>');
  });

  it('无 OTSL 标记时原样返回', () => {
    const md = '# 标题\n\n普通段落';
    expect(postprocessOtslTables(md)).toBe(md);
  });

  it('尾部整周期重复被截断到保留一个周期', () => {
    const unit = 'abcdef';
    const text = 'X'.repeat(60) + unit.repeat(20);
    expect(cleanTruncatedRepeats(text, { minTextLen: 10, minRepeatTimes: 5, minRepeatChars: 20 })).toBe('X'.repeat(60) + unit);
  });

  it('短文本不做重复截断', () => {
    const text = 'abc'.repeat(10);
    expect(cleanTruncatedRepeats(text)).toBe(text);
  });

  it('finalizeDocument 串起三步处理', () => {
    const out = finalizeDocument('正文 \\[ E=mc^2 \\]\n\n<fcel>A<fcel>B<nl>');
    expect(out).toContain('$$ E=mc^2 $$');
    expect(out).toContain('<table>');
  });
});
