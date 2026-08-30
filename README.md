# 智能扫描 · Web Scanner

纯前端智能扫描工具（类扫描全能王，无 OCR）。所有图像算法、滤镜、PDF 生成均在浏览器本地完成，**图片不上传服务器**，兼顾隐私与速度。响应式适配 PC 与手机。

## 快速开始

```bash
npm install
npm run dev      # 开发预览（默认 http://localhost:5173）
npm run build    # 打包静态站点（dist/）
npm run preview  # 本地预览构建产物
```

## 功能总览

### 导入
- 多选本地文件 / 拖入窗口 / Ctrl+V 粘贴
- 格式：JPG / PNG / WebP / BMP / GIF / TIFF（UTIF 解码）/ **HEIC·HEIF**（heic2any 懒加载解码）
- 摄像头拍照扫描（连续拍摄）

### 摄像头扫描
- `getUserMedia` 取流，前后摄像头可切换
- **实时边缘检测**：低清帧 Canny + 轮廓查找，取景框实时叠加（稳定时变绿）
- **自动快门**：取景框连续多帧稳定后自动拍摄（可开关）；手动快门随时可用

### 多页管理
- 缩略图列表（PC 左栏 / 移动底部横滑），拖拽或 ↑↓ 排序
- 删除 / 复制 / 任意位置插入新页
- 批量操作：全部自动裁剪、全部自动增强、统一滤镜

### 裁剪矫正（第①步）
- **自动边缘检测（多策略融合）**：四路候选并行——多组 Canny 阈值+轮廓、
  Otsu 亮度/低饱和显著图（含凸包外框）、霍夫直线交点、Harris 角点象限拼合；
  候选按面积占比/长宽比/内角/边缘支撑度加权评分，分数接近时取平均融合，
  最优解再做 Harris 角点吸附；相邻页候选自动合并外框（书本跨页）
- **三级兜底**：分块边缘点拼合 → 内缩 4% 参考框 + 引导提示，绝不只报错
- 检测前先做阴影/光照校正；480px 低清图上单次检测 ~200ms
- 4 角点 + 4 边中点自由拖拽（不规则四边形），带三分网格辅助线
- 旋转 90° / 水平镜像 / 垂直翻转 / ±15° 自由微调
- **自动摆正（Deskew）**：HoughLinesP 直线角度中位数检测倾斜
- 实时透视矫正小预览（拖角点即时反馈）
- PC：滚轮缩放 + 拖拽平移；移动：双指捏合缩放 + 单指平移

### 增强滤镜（第②步）
- 六种模式：原图 / **智能增强**（光照归一化+CLAHE+白点拉伸+锐化，强度可调）/ 彩色（去阴影泛黄+自动白平衡+提饱和）/ 灰度 / **黑白（自适应阈值）** / 照片
- **黑白模式**：局部高斯自适应阈值，有效去阴影、去光照不均、去纸张泛黄；阈值块大小 / 强度 C / 降噪可调
- 通用滑块：亮度、对比度、饱和度、锐化（非锐化掩模）、去阴影（背景光照归一化）、背景净化（白点校正）
- **任意多边形裁剪（套索）**：去除书籍曲页、缺角
- 几何结果缓存：调滑块只跑滤镜，不重跑透视

### 去污擦除（第③步）
- 画笔/橡皮直接涂抹（PC 鼠标、移动端手指），红色蒙版实时预览，笔径 5–100px
- **Telea 图像修复**：填充色自动取自涂抹区周围背景（白/米黄/淡蓝均可，不硬编码纯白）
- 逐笔撤销（Ctrl+Z/按钮）、重置擦除；擦除结果在导出 PDF/JPG 全分辨率生效

### 导出
- **PDF**：A4 适配 / 原始尺寸 / 适应宽度；高·中·低质量档；自定义标题、作者元数据
- **JPG**：单张下载；多页自动 JSZip 打包；质量 1–100 滑块
- 文件名前缀 + 自动序号（`Scan_001.jpg`）
- 导出前全屏逐页预览
- 导出用**原始分辨率**渲染（编辑时用低清预览保证流畅）

### 其他
- 撤销 / 重做（Ctrl+Z / Ctrl+Y，覆盖角点、滤镜、增删页）
- 快捷键：Delete 删页、←→ 切页
- IndexedDB 本地草稿：自动暂存，刷新后自动恢复
- 界面默认简体中文

## 技术栈

| 层 | 选型 |
|---|---|
| 框架 | React 18 + TypeScript + Vite |
| 样式 | Tailwind CSS |
| 图像算法 | OpenCV.js（WASM，动态加载，独立分包） |
| 状态 | Zustand（含撤销/重做历史栈） |
| PDF | pdf-lib |
| ZIP | JSZip |
| HEIC | heic2any（动态 import） |
| TIFF | UTIF（动态 import） |
| 草稿 | IndexedDB |

## 目录结构

```
src/
├── App.tsx                 # 路由（首页/工作台）、粘贴/拖拽导入、草稿、Toast
├── types.ts                # Page / FilterState / ExportOptions 类型
├── store/useStore.ts       # Zustand：页面列表、当前页、撤销重做
├── utils/
│   ├── opencvLoader.ts     # OpenCV 懒加载单例 + Mat 内存池
│   ├── detect.ts           # 四边形检测 / Deskew 角度
│   ├── geometry.ts         # 角点排序 / 目标尺寸 / 位移
│   ├── enhance.ts          # 滤镜管线（自适应阈值/去阴影/CLAHE…）
│   ├── render.ts           # 几何渲染（透视变换）+ 滤镜应用
│   ├── imageIO.ts          # 多格式解码（含 HEIC/TIFF）+ 预览生成
│   ├── importer.ts         # 导入流程 + 后台自动检测
│   ├── exporter.ts         # PDF / JPG / ZIP 导出
│   └── idb.ts              # IndexedDB 草稿
├── hooks/useShortcuts.ts   # 键盘快捷键
└── components/
    ├── Home.tsx            # 首页
    ├── Workspace.tsx       # 工作台框架（PC 三栏 / 移动底栏）
    ├── ThumbList.tsx       # 缩略图管理
    ├── CropStage.tsx       # 裁剪矫正台（角点/手势/实时预览）
    ├── EnhanceStage.tsx    # 增强台（滤镜预览 + 套索）
    ├── FilterPanel.tsx     # 滤镜参数面板
    ├── CameraView.tsx      # 摄像头扫描
    └── ExportDialog.tsx    # 导出设置 + 全屏预览
```

## 注意事项

- **摄像头**：`getUserMedia` 仅在 `localhost` 或 HTTPS 下可用。手机经局域网 IP（http）访问时浏览器会拒绝摄像头，需要 HTTPS 部署或 Chrome `chrome://flags/#unsafely-treat-insecure-origin-as-secure` 临时放行；PC 上 `npm run dev` 后用 `http://localhost:5173` 不受影响。
- **首次使用**算法功能时 OpenCV.js（约 10MB，本地 node_modules 提供，不走外网 CDN）会异步加载片刻，加载完成后缓存。
- 导出 PDF 高质量档按 300 DPI、中 200、低 150 换算页面尺寸。
