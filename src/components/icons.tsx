/**
 * 统一内联 SVG 图标库（1.7 描边、round 端点，替代 emoji 装饰）。
 * 尺寸由 className 控制，默认 w-4 h-4。
 */
import type { ReactNode } from 'react';

interface IconProps {
  className?: string;
}

function Svg({ className = 'w-4 h-4', children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const IconHome = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 11l8-7 8 7" />
    <path d="M6 9.5V20h12V9.5" />
  </Svg>
);

export const IconUndo = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 5L4 9l4 4" />
    <path d="M4 9h9a6 6 0 0 1 6 6v1" />
  </Svg>
);

export const IconRedo = (p: IconProps) => (
  <Svg {...p}>
    <path d="M16 5l4 4-4 4" />
    <path d="M20 9h-9a6 6 0 0 0-6 6v1" />
  </Svg>
);

export const IconScissors = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="6" cy="6.5" r="2.5" />
    <circle cx="6" cy="17.5" r="2.5" />
    <path d="M8.2 8L20 19M8.2 16L20 5" />
  </Svg>
);

export const IconSparkles = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4l1.7 4.3L18 10l-4.3 1.7L12 16l-1.7-4.3L6 10l4.3-1.7L12 4z" />
    <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z" />
  </Svg>
);

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const IconCamera = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7.5h3l1.6-2.3h6.8L17 7.5h3A1.5 1.5 0 0 1 21.5 9v9a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 18V9A1.5 1.5 0 0 1 4 7.5z" />
    <circle cx="12" cy="13" r="3.2" />
  </Svg>
);

export const IconImage = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <circle cx="9" cy="10" r="1.7" />
    <path d="M3.5 17.5l4.5-4.5 4 4 3-3 5.5 5.5" />
  </Svg>
);

export const IconEdit = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 19.5l.9-3.6L16.6 4.7a1.8 1.8 0 0 1 2.6 0l.1.1a1.8 1.8 0 0 1 0 2.6L8.1 18.6l-3.6.9z" />
    <path d="M14.5 6.8l2.7 2.7" />
  </Svg>
);

export const IconDownload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4v11" />
    <path d="M7 11l5 5 5-5" />
    <path d="M4 19.5h16" />
  </Svg>
);

export const IconDoc = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 3h8l5 5v13H6V3z" />
    <path d="M14 3v5h5" />
    <path d="M9 12h7M9 16h7" />
  </Svg>
);

export const IconEye = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="2.8" />
  </Svg>
);

export const IconEyeOff = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 4l16 16" />
    <path d="M9.9 5.9A9.8 9.8 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17.6 17.6 0 0 1-3.3 4.1M6.6 6.6A17 17 0 0 0 2.5 12S6 18.5 12 18.5a9.7 9.7 0 0 0 4.3-1" />
    <path d="M10 10a2.8 2.8 0 0 0 4 4" />
  </Svg>
);

export const IconSliders = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
    <circle cx="15" cy="7" r="2" />
    <circle cx="9" cy="17" r="2" />
  </Svg>
);

export const IconEraser = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 20l-5.5-5.5a1.5 1.5 0 0 1 0-2.1l8-8a1.5 1.5 0 0 1 2.1 0l5 5a1.5 1.5 0 0 1 0 2.1L11.5 20H9z" />
    <path d="M6 20h14" />
    <path d="M9.5 8.5l6 6" />
  </Svg>
);

export const IconBrush = (p: IconProps) => (
  <Svg {...p}>
    <path d="M19.5 4.5c-3 1-7.5 4.5-9.5 8l2.5 2.5c3.5-2 7-6.5 7-10.5z" />
    <path d="M9.5 13c-2 0-3.5 1.5-3.5 3.5 0 1.5-1 2.5-2.5 3 1.5 1 4 1 5.5-.5 1.2-1.2 1.5-2.5 1-4z" />
  </Svg>
);

export const IconTrash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13" />
    <path d="M10 11v5M14 11v5" />
  </Svg>
);

export const IconDetect = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
    <circle cx="12" cy="12" r="2.5" />
  </Svg>
);

export const IconReset = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 12a7.5 7.5 0 1 1 2.2 5.3" />
    <path d="M4.5 13.5V9h4.5" />
  </Svg>
);

export const IconRotateCw = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 12a8 8 0 1 1-2.3-5.6" />
    <path d="M20 4v4h-4" />
  </Svg>
);

export const IconFlipH = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3v18" strokeDasharray="2.5 2.5" />
    <path d="M4 8l4-4 4 4" transform="translate(-1 3)" />
    <path d="M20 16l-4 4-4-4" transform="translate(1 -3)" />
  </Svg>
);

export const IconFlipV = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 12h18" strokeDasharray="2.5 2.5" />
    <path d="M8 4l-4 4 4 4" transform="translate(3 -1)" />
    <path d="M16 20l4-4-4-4" transform="translate(-3 1)" />
  </Svg>
);

export const IconDeskew = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 19L19 5" />
    <path d="M5 5h4M5 5v4M19 19h-4M19 19v-4" />
    <path d="M8.5 8.5l7 7" strokeDasharray="2 2" />
  </Svg>
);

export const IconArrowRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 12h15" />
    <path d="M13.5 6.5L19 12l-5.5 5.5" />
  </Svg>
);

export const IconWand = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 19L15.5 8.5" />
    <path d="M14 6l1-2.5L16.5 6 19 7l-2.5 1L15.5 10.5 14.5 8 12 7l2-1z" transform="translate(1.5 -1.5) scale(0.9)" />
  </Svg>
);

export const IconDroplet = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5s6 6.2 6 10.5a6 6 0 0 1-12 0c0-4.3 6-10.5 6-10.5z" />
  </Svg>
);

export const IconContrast = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconGridDoc = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4.5" y="3.5" width="15" height="17" rx="1.5" />
    <path d="M8.5 8h7M8.5 12h7M8.5 16h4.5" />
  </Svg>
);

export const IconCopy = (p: IconProps) => (
  <Svg {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </Svg>
);

export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 12.5l5 5L20 6.5" />
  </Svg>
);

export const IconBack = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 5l-7 7 7 7" />
  </Svg>
);

export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 9l6 6 6-6" />
  </Svg>
);
