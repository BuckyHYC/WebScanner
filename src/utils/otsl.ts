/**
 * OTSL 表格标记 → HTML 表格（移植自上游 Xiaomi-OCR-0 postprocess/otsl.py）。
 *
 * 模型输出表格时用紧凑标记而不是 Markdown 表格：
 *   <fcel> 有文字的单元格   <ecel> 空单元格   <nl> 换行
 *   <lcel> 延续左侧单元格   <ucel> 延续上方单元格   <xcel> 两者都延续
 * 只有 <fcel>/<ecel> 开新单元格，延续标记自身无文字，用于生成 rowspan/colspan。
 */

const ROW_BREAK = '<nl>';
const CELL = '<fcel>';
const EMPTY = '<ecel>';
const LEFT = '<lcel>';
const UP = '<ucel>';
const BOTH = '<xcel>';

const ALL_TAGS = [CELL, EMPTY, LEFT, UP, BOTH, ROW_BREAK];
const TAG_AT = new RegExp(`^(${ALL_TAGS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`);
const TAG_GLOBAL = new RegExp(ALL_TAGS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
/** 判断整段 markdown 是否含 OTSL 标记 */
export const OTSL_TAG_RE = /<(?:fcel|ecel|nl|lcel|ucel|xcel)>/;

const ORIGIN_TAGS = new Set([CELL, EMPTY]);
const RIGHT_CONTINUATION = new Set([LEFT, BOTH]);
const DOWN_CONTINUATION = new Set([UP, BOTH]);

interface Cell {
  text: string;
  row: number;
  column: number;
  rowspan: number;
  colspan: number;
}

function tagOf(chunk: string): string {
  const m = TAG_AT.exec(chunk);
  return m ? m[0] : '';
}

/** 把一行切成若干片段，每片含一个标记及其后的文字 */
function splitChunks(line: string): string[] {
  const starts: number[] = [];
  TAG_GLOBAL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_GLOBAL.exec(line)) !== null) {
    starts.push(m.index);
    if (m.index === TAG_GLOBAL.lastIndex) TAG_GLOBAL.lastIndex++;
  }
  return starts.map((start, i) => line.slice(start, i + 1 < starts.length ? starts[i + 1] : line.length));
}

/** 保留最后一条有内容的单元格所需的最小宽度 */
function requiredWidth(chunks: string[]): number {
  let width = 0;
  chunks.forEach((chunk, i) => {
    if (tagOf(chunk) === CELL) width = i + 1;
  });
  return width;
}

/** 选一个所有行都要对齐到的宽度：不切断已有内容，且总截断/补齐代价最小 */
function targetWidth(rows: string[][]): number {
  const lower = Math.max(...rows.map(requiredWidth));
  const upper = Math.max(...rows.map((r) => r.length));
  let best = upper;
  let bestCost: number | null = null;
  for (let width = lower; width <= upper; width++) {
    const cost = rows.reduce((sum, row) => sum + Math.abs(row.length - width), 0);
    if (bestCost === null || cost < bestCost) {
      best = width;
      bestCost = cost;
    }
  }
  return best;
}

/** 把每行补成同样的单元格数，便于按网格索引 */
export function padRows(otsl: string): string {
  const text = otsl.trim();
  if (!text.includes(ROW_BREAK)) return text + ROW_BREAK;

  const rows = text
    .split(ROW_BREAK)
    .map((line) => splitChunks(line))
    .filter((chunks) => chunks.length > 0);
  if (rows.length === 0) return ROW_BREAK;

  const width = targetWidth(rows);
  const padded = rows.map((chunks) => {
    const fixed = chunks.slice(0, width);
    while (fixed.length < width) fixed.push(EMPTY);
    return fixed.join('');
  });
  return padded.join(ROW_BREAK) + ROW_BREAK;
}

/** 解析成并行的「标记网格」与「文字网格」 */
function parseGrid(otsl: string): { tagRows: string[][]; textRows: string[][] } {
  const tagRows: string[][] = [];
  const textRows: string[][] = [];

  for (const line of otsl.split(ROW_BREAK)) {
    const chunks = splitChunks(line);
    if (chunks.length === 0) continue;
    const tags: string[] = [];
    const texts: string[] = [];
    for (const chunk of chunks) {
      const tag = tagOf(chunk);
      tags.push(tag);
      texts.push(tag === CELL ? chunk.slice(tag.length) : '');
    }
    tagRows.push(tags);
    textRows.push(texts);
  }

  const width = tagRows.reduce((max, row) => Math.max(max, row.length), 0);
  tagRows.forEach((tags, i) => {
    while (tags.length < width) tags.push(EMPTY);
    while (textRows[i].length < width) textRows[i].push('');
  });
  return { tagRows, textRows };
}

/** 按延续标记计算跨行跨列 */
function resolveCells(tagRows: string[][], textRows: string[][]): Cell[] {
  const height = tagRows.length;
  const cells: Cell[] = [];

  tagRows.forEach((tags, rowIndex) => {
    tags.forEach((tag, column) => {
      if (!ORIGIN_TAGS.has(tag)) return;

      let colspan = 1;
      while (column + colspan < tags.length && RIGHT_CONTINUATION.has(tags[column + colspan])) colspan++;

      let rowspan = 1;
      while (
        rowIndex + rowspan < height &&
        column < tagRows[rowIndex + rowspan].length &&
        DOWN_CONTINUATION.has(tagRows[rowIndex + rowspan][column])
      ) {
        rowspan++;
      }

      cells.push({
        text: tag === CELL ? (textRows[rowIndex][column] ?? '').trim() : '',
        row: rowIndex,
        column,
        rowspan,
        colspan,
      });
    });
  });
  return cells;
}

/** 逐列遍历生成表格：任何一行都与网格同宽，span 不会抢占别人占用的位置 */
function renderHtml(cells: Cell[], numRows: number, numCols: number): string {
  if (cells.length === 0) return '';

  const grid: (Cell | null)[][] = Array.from({ length: numRows }, () => new Array<Cell | null>(numCols).fill(null));
  for (const cell of cells) {
    for (let row = cell.row; row < Math.min(cell.row + cell.rowspan, numRows); row++) {
      for (let column = cell.column; column < Math.min(cell.column + cell.colspan, numCols); column++) {
        if (row >= 0 && column >= 0) grid[row][column] = cell;
      }
    }
  }

  const coveredUntil = new Map<number, number>();
  const parts: string[] = [];
  for (let row = 0; row < numRows; row++) {
    parts.push('<tr>');
    let column = 0;
    while (column < numCols) {
      if ((coveredUntil.get(column) ?? 0) > row) {
        column++;
        continue;
      }
      const cell = grid[row][column];
      if (!cell || cell.row !== row || cell.column !== column) {
        // 没有源单元格的延续标记：保留列位，保证整行仍覆盖网格宽度
        parts.push('<td></td>');
        column++;
        continue;
      }

      let colspan = 1;
      while (column + colspan < numCols && grid[row][column + colspan] === cell) colspan++;

      let rowspan = 1;
      while (
        row + rowspan < numRows &&
        Array.from({ length: colspan }, (_, k) => column + k).every((offset) => grid[row + rowspan][offset] === cell)
      ) {
        rowspan++;
      }

      const attrs = (rowspan > 1 ? ` rowspan="${rowspan}"` : '') + (colspan > 1 ? ` colspan="${colspan}"` : '');
      parts.push(`<td${attrs}>${cell.text}</td>`);

      for (let offset = column; offset < column + colspan; offset++) {
        coveredUntil.set(offset, Math.max(coveredUntil.get(offset) ?? 0, row + rowspan));
      }
      column += colspan;
    }
    parts.push('</tr>');
  }
  return '<table>' + parts.join('') + '</table>';
}

/** 把一段 OTSL 表格转成 HTML table */
export function convertOtslToHtml(otsl: string): string {
  const { tagRows, textRows } = parseGrid(padRows(otsl));
  const cells = resolveCells(tagRows, textRows);
  const numRows = tagRows.length;
  const numCols = tagRows.reduce((max, row) => Math.max(max, row.length), 0);
  return renderHtml(cells, numRows, numCols);
}
