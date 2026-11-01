import { describe, expect, it } from 'vitest';
import { MAX_HISTORY_TURNS, buildChatMessages, trimChatHistory } from './xiaomiOcr';
import type { ChatTurn } from '../types';

const IMG = 'data:image/png;base64,AAAA';

const turn = (role: ChatTurn['role'], content: string): ChatTurn => ({ role, content, at: 0 });

/** 造 n 轮问答（u1,a1,...,un,an） */
function pairs(n: number): ChatTurn[] {
  const out: ChatTurn[] = [];
  for (let i = 1; i <= n; i++) {
    out.push(turn('user', `Q${i}`));
    out.push(turn('assistant', `A${i}`));
  }
  return out;
}

describe('buildChatMessages', () => {
  it('图片只注入首条消息，后续为纯文本', () => {
    const msgs = buildChatMessages([turn('user', 'Q1'), turn('assistant', 'A1'), turn('user', 'Q2')], IMG);
    expect(msgs).toHaveLength(3);

    const first = msgs[0].content as { type: string; text?: string; image_url?: { url: string } }[];
    expect(Array.isArray(first)).toBe(true);
    expect(first.some((p) => p.type === 'image_url' && p.image_url?.url === IMG)).toBe(true);
    expect(first.some((p) => p.type === 'text' && p.text === 'Q1')).toBe(true);

    // 后续消息不再带图，否则每轮都会多烧约 1500 个图片 token
    expect(typeof msgs[1].content).toBe('string');
    expect(msgs[1].content).toBe('A1');
    expect(typeof msgs[2].content).toBe('string');
    expect(msgs[2].content).toBe('Q2');
  });

  it('角色严格按历史顺序交替', () => {
    const msgs = buildChatMessages(pairs(3), IMG);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
  });

  it('首条不是用户提问时抛错', () => {
    expect(() => buildChatMessages([turn('assistant', 'A')], IMG)).toThrow();
  });

  it('空历史抛错', () => {
    expect(() => buildChatMessages([], IMG)).toThrow();
  });
});

describe('trimChatHistory', () => {
  it('未超上限时原样返回（引用不变）', () => {
    const few = pairs(5);
    expect(trimChatHistory(few, MAX_HISTORY_TURNS)).toBe(few);
  });

  it('超上限时保留首问首答与最近若干轮', () => {
    const many = pairs(20);
    const out = trimChatHistory(many, 12);
    expect(out.length).toBeLessThan(many.length);
    expect(out[0].content).toBe('Q1'); // 首问固定保留，图片在它里面
    expect(out[1].content).toBe('A1');
    expect(out[out.length - 1].content).toBe('A20'); // 最近的尾巴保留
  });

  it('裁剪后仍以用户消息开头且角色交替', () => {
    const out = trimChatHistory(pairs(20), 12);
    expect(out[0].role).toBe('user');
    for (let i = 1; i < out.length; i++) {
      expect(out[i].role).not.toBe(out[i - 1].role);
    }
  });

  it('末尾是待回答的提问时不会丢', () => {
    const turns = pairs(20).slice(0, 39); // u1..u20（去掉最后的 a20）
    turns.push(turn('user', '最后一个问题'));
    const out = trimChatHistory(turns, 12);
    expect(out[0].content).toBe('Q1');
    expect(out[out.length - 1].content).toBe('最后一个问题');
  });

  it('截断点落在回答上时，把孤儿回答一并去掉', () => {
    // 41 条：20 轮问答 + 1 条待回答，保证 slice(-keepTail) 的首条是 assistant
    const turns = [...pairs(20), turn('user', '新的问题')];
    const out = trimChatHistory(turns, 12);
    expect(out[0].role).toBe('user');
    expect(out[1].role).toBe('assistant');
    expect(out[2].role).toBe('user');
    expect(out[out.length - 1].content).toBe('新的问题');
  });
});
