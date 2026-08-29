import type { FilterMode, FilterState, Page } from '../types';
import { defaultFilter, filterLabel, useStore } from '../store/useStore';

interface Props {
  page: Page;
  className?: string;
  onDone?: () => void;
}

interface SliderDef {
  key: keyof FilterState;
  label: string;
  min: number;
  max: number;
  step?: number;
  /** 自定义数值显示（如 0~100 → 0.0~1.0） */
  display?: (v: number) => string;
}

/** 各模式可见的滑块配置 */
function slidersFor(mode: FilterMode): SliderDef[] {
  const bc: SliderDef[] = [
    { key: 'brightness', label: '亮度', min: -100, max: 100 },
    { key: 'contrast', label: '对比度', min: -100, max: 100 },
  ];
  const sc: SliderDef[] = [
    { key: 'saturation', label: '饱和度', min: -100, max: 100 },
    { key: 'sharpen', label: '锐化', min: 0, max: 100 },
  ];
  switch (mode) {
    case 'magic':
      return [
        { key: 'strength', label: '增强强度', min: 0, max: 100, step: 5, display: (v) => (v / 100).toFixed(1) },
        ...bc,
        ...sc,
      ];
    case 'bw':
      return [
        { key: 'block', label: '阈值块大小', min: 3, max: 99, step: 2 },
        { key: 'cValue', label: '阈值强度 C', min: -10, max: 40 },
        { key: 'denoise', label: '降噪', min: 0, max: 100 },
        { key: 'shadow', label: '去阴影', min: 0, max: 100 },
        ...bc,
      ];
    case 'gray':
      return [...bc, { key: 'sharpen', label: '锐化', min: 0, max: 100 }, { key: 'shadow', label: '去阴影', min: 0, max: 100 }];
    case 'photo':
      return [...bc, ...sc, { key: 'denoise', label: '降噪', min: 0, max: 100 }];
    default:
      return [...bc, ...sc, { key: 'shadow', label: '去阴影', min: 0, max: 100 }, { key: 'cleanBg', label: '背景净化', min: 0, max: 100 }];
  }
}

const MODES: FilterMode[] = ['original', 'magic', 'color', 'gray', 'bw', 'photo'];
const MODE_ICONS: Record<FilterMode, string> = {
  original: '🖼️',
  magic: '✨',
  color: '🌈',
  gray: '🌗',
  bw: '📄',
  photo: '📷',
};

export default function FilterPanel({ page, className = '', onDone }: Props) {
  const f = page.filter;

  const patchFilter = (patch: Partial<FilterState>, history = false) =>
    useStore.getState().updateFilter(page.id, patch, history);

  const applyMode = (mode: FilterMode) => {
    const preset = defaultFilter(mode);
    patchFilter({ ...preset, block: f.block, cValue: f.cValue }, true);
    useStore.getState().updatePage(page.id, { filterName: filterLabel(mode) }, false);
  };

  return (
    <div className={className}>
      {onDone && (
        <div className="flex items-center justify-between">
          <span className="panel-title">增强滤镜</span>
          <button className="btn-ghost text-xs" onClick={onDone}>
            ✕
          </button>
        </div>
      )}
      {!onDone && <div className="panel-title pt-4">滤镜模式</div>}

      {/* 模式选择网格 */}
      <div className="grid grid-cols-3 gap-1.5">
        {MODES.map((m) => (
          <button
            key={m}
            className={`rounded-lg py-2.5 text-xs flex flex-col items-center gap-1 border transition-colors ${
              f.mode === m
                ? 'border-accent bg-accent/15 text-accent'
                : 'border-ink-600 bg-ink-800 text-slate-300 hover:border-ink-600 hover:bg-ink-700'
            }`}
            onClick={() => applyMode(m)}
          >
            <span className="text-lg leading-none">{MODE_ICONS[m]}</span>
            {filterLabel(m)}
          </button>
        ))}
      </div>

      <div className="panel-title pt-2">参数微调</div>
      <div className="flex flex-col gap-3">
        {slidersFor(f.mode).map((s) => (
          <label key={String(s.key)} className="flex flex-col gap-1">
            <span className="flex justify-between text-xs text-slate-400">
              <span>{s.label}</span>
              <span className="tabular-nums text-slate-300">
                {s.display ? s.display(Number(f[s.key])) : f[s.key]}
              </span>
            </span>
            <input
              type="range"
              min={s.min}
              max={s.max}
              step={s.step ?? 1}
              value={Number(f[s.key])}
              onPointerDown={() => useStore.getState().pushHistory()}
              onChange={(e) => patchFilter({ [s.key]: Number(e.target.value) } as Partial<FilterState>)}
              className="w-full"
            />
          </label>
        ))}
      </div>

      <div className="flex flex-col gap-2 pt-1 pb-4">
        <button
          className="btn-panel text-xs"
          onClick={() => {
            patchFilter(defaultFilter('original'), true);
            useStore.getState().updatePage(page.id, { filterName: '原图' }, false);
          }}
        >
          ♻️ 重置本页参数
        </button>
        <button
          className="btn-panel text-xs"
          onClick={() => {
            useStore.getState().applyFilterToAll();
            useStore.getState().toast('已将当前页滤镜设置同步到全部页面', 'success');
          }}
        >
          📚 应用当前设置到所有页面
        </button>
      </div>
    </div>
  );
}
