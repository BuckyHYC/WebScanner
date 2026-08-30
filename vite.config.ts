/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// base './' 使构建产物可部署在任意子路径
export default defineConfig({
  plugins: [
    react(),
    // PWA 仅在构建时启用；vitest 环境跳过（避免插件在测试中生成 SW 干扰）
    ...(!process.env.VITEST
      ? [
          VitePWA({
            registerType: 'autoUpdate',
            injectRegister: 'auto',
            manifest: {
              name: '智能扫描 · Web Scanner',
              short_name: '智能扫描',
              description: '纯前端智能扫描工具：边缘检测、透视矫正、滤镜增强、PDF 导出，全程本地处理',
              theme_color: '#0b0f14',
              background_color: '#0b0f14',
              display: 'standalone',
            },
            workbox: {
              // precache 全部静态资源（含 opencv.js 约 10MB，须调大单文件上限）
              globPatterns: ['**/*.{js,css,html,woff2}'],
              maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
              navigateFallback: 'index.html',
            },
          }),
        ]
      : []),
  ],
  base: './',
  server: {
    host: true, // 允许局域网访问（手机测试 UI；摄像头需 https，见 README）
    port: 5173,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  build: {
    // heic2any 等大依赖动态分包
    chunkSizeWarningLimit: 15000,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'zustand'],
          exporter: ['pdf-lib', 'jszip'],
        },
      },
    },
  },
});
