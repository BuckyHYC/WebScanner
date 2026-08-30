import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { loadOpenCV } from '../utils/opencvLoader';
import { detectQuadInCanvas } from '../utils/detect';
import { quadShift } from '../utils/geometry';
import { importFiles } from '../utils/importer';
import type { Point } from '../types';

/**
 * 摄像头扫描：getUserMedia 取流 → 低清帧实时边缘检测 → 叠加取景框；
 * 支持"边缘稳定后自动快门"与手动快门，拍完自动进入矫正流程，可连续拍摄。
 */
export default function CameraView() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const runningRef = useRef(true);
  const lastQuadRef = useRef<Point[] | null>(null);
  const stableRef = useRef(0);
  const coolRef = useRef(0);
  const [error, setError] = useState('');
  const [auto, setAuto] = useState(false);
  const [facing, setFacing] = useState<'environment' | 'user'>('environment');
  const [detecting, setDetecting] = useState(false);
  const pages = useStore((s) => s.pages);
  const setCameraOpen = useStore((s) => s.setCameraOpen);

  // 开流
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 预热 OpenCV（叠加框依赖）
        void loadOpenCV().then(() => !cancelled && setDetecting(true));
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1440 } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
      } catch (e: any) {
        console.error(e);
        setError(
          e?.name === 'NotAllowedError'
            ? '摄像头权限被拒绝，请在浏览器设置中允许后重试'
            : '无法打开摄像头（仅 localhost / HTTPS 可用）',
        );
      }
    })();
    return () => {
      cancelled = true;
      runningRef.current = false;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [facing]);

  // 实时检测循环（节流 ~160ms，低清帧保证主线程流畅）
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      const video = videoRef.current;
      const overlay = overlayRef.current;
      if (video && overlay && video.videoWidth > 0) {
        // 匹配覆盖层尺寸
        if (overlay.width !== overlay.clientWidth || overlay.height !== overlay.clientHeight) {
          overlay.width = overlay.clientWidth;
          overlay.height = overlay.clientHeight;
        }
        try {
          const cv = await loadOpenCV();
          // 低清检测帧
          if (!frameRef.current) frameRef.current = document.createElement('canvas');
          const frame = frameRef.current;
          const fs = 240 / video.videoWidth;
          frame.width = 240;
          frame.height = Math.round(video.videoHeight * fs);
          frame.getContext('2d', { willReadFrequently: true })!.drawImage(video, 0, 0, frame.width, frame.height);
          const outcome = detectQuadInCanvas(cv, frame);
          const quad = outcome?.quad ?? null;

          // 计算视频在容器中的显示区域（object-contain）
          const cw = overlay.clientWidth;
          const ch = overlay.clientHeight;
          const vr = video.videoWidth / video.videoHeight;
          const cr = cw / ch;
          let dw = cw;
          let dh = ch;
          if (vr > cr) dh = cw / vr;
          else dw = ch * vr;
          const dx = (cw - dw) / 2;
          const dy = (ch - dh) / 2;

          const ctx = overlay.getContext('2d')!;
          ctx.clearRect(0, 0, cw, ch);
          if (quad) {
            ctx.strokeStyle = quadShiftSafe(quad, lastQuadRef.current) < 0.02 ? '#34d399' : '#2f81f7';
            ctx.lineWidth = 3;
            ctx.beginPath();
            quad.forEach((p, i) => (i === 0 ? ctx.moveTo(dx + p.x * dw, dy + p.y * dh) : ctx.lineTo(dx + p.x * dw, dy + p.y * dh)));
            ctx.closePath();
            ctx.stroke();
            ctx.fillStyle = 'rgba(47,129,247,0.10)';
            ctx.fill();

            // 稳定判定：连续多帧角点几乎不动
            const shift = quadShiftSafe(quad, lastQuadRef.current);
            stableRef.current = shift < 0.012 ? stableRef.current + 1 : 0;
            if (auto && stableRef.current >= 4 && Date.now() > coolRef.current && video.readyState >= 2) {
              coolRef.current = Date.now() + 1800;
              stableRef.current = 0;
              capture();
            }
          }
          lastQuadRef.current = quad;
        } catch {
          /* OpenCV 未就绪时跳过本帧 */
        }
      }
      if (!cancelled) setTimeout(tick, 160);
    };
    void tick();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, facing, detecting]);

  /** 拍照：全分辨率帧 → JPEG → 走导入管线 */
  const capture = () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;
    const c = document.createElement('canvas');
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext('2d')!.drawImage(video, 0, 0);
    c.toBlob((blob) => {
      if (!blob) return;
      const file = new File([blob], `拍照_${Date.now()}.jpg`, { type: 'image/jpeg' });
      void importFiles([file]);
      useStore.getState().toast('已拍摄 1 页', 'success');
    }, 'image/jpeg', 0.95);
  };

  const close = () => setCameraOpen(false);

  return (
    <div className="fixed inset-0 z-[70] bg-black flex flex-col">
      {/* 顶栏 */}
      <div className="flex items-center justify-between px-3 h-12 shrink-0 bg-black/60 z-10">
        <button className="btn-ghost" onClick={close}>
          ✕ 关闭
        </button>
        <span className="text-sm text-slate-300">已拍 {pages.length} 页</span>
        <button className="btn-ghost" onClick={() => setFacing((f) => (f === 'environment' ? 'user' : 'environment'))}>
          🔄 翻转
        </button>
      </div>

      {/* 取景区 */}
      <div className="relative flex-1 min-h-0">
        {error ? (
          <div className="h-full flex flex-col items-center justify-center gap-3 px-8 text-center">
            <span className="text-4xl">📷</span>
            <p className="text-slate-300 text-sm">{error}</p>
            <button className="btn-panel" onClick={close}>
              返回
            </button>
          </div>
        ) : (
          <>
            <video ref={videoRef} playsInline muted className="absolute inset-0 w-full h-full object-contain" />
            <canvas ref={overlayRef} className="absolute inset-0 w-full h-full pointer-events-none" />
            {!detecting && !error && (
              <div className="absolute bottom-3 left-1/2 -translate-x-1/2 text-xs text-slate-400 bg-black/60 rounded-full px-3 py-1">
                边缘检测算法加载中…
              </div>
            )}
          </>
        )}
      </div>

      {/* 底栏控制 */}
      {!error && (
        <div className="shrink-0 safe-bottom">
          <div className="flex items-center justify-center gap-8 py-4 bg-black/60">
            <label className="flex flex-col items-center gap-1 text-xs text-slate-300">
              <input
                type="checkbox"
                checked={auto}
                onChange={(e) => {
                  setAuto(e.target.checked);
                  stableRef.current = 0;
                }}
                className="w-5 h-5 accent-[#2f81f7]"
              />
              自动快门
            </label>
            <button
              className="w-18 h-18 rounded-full border-4 border-white bg-white/20 active:bg-white/40 transition-colors"
              style={{ width: 68, height: 68 }}
              onClick={capture}
              title="拍摄"
            >
              <span className="block w-[52px] h-[52px] mx-auto rounded-full bg-white" />
            </button>
            <div className="flex flex-col items-center gap-1 text-xs text-slate-300 w-12">
              <span className="text-lg">📄</span>
              连拍
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function quadShiftSafe(a: Point[] | null, b: Point[] | null): number {
  if (!a || !b) return 1;
  return quadShift(a, b);
}
