import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' 使构建产物可部署在任意子路径
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    host: true, // 允许局域网访问（手机测试 UI；摄像头需 https，见 README）
    port: 5173,
  },
  build: {
    // opencv-js wasm 体积大，放宽分块警告
    chunkSizeWarningLimit: 15000,
    rollupOptions: {
      output: {
        manualChunks: {
          opencv: ['@techstark/opencv-js'],
          vendor: ['react', 'react-dom', 'zustand'],
          exporter: ['pdf-lib', 'jszip'],
        },
      },
    },
  },
});
