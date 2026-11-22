import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { target: 'es2020', assetsInlineLimit: 200 * 1024 }, // 开始界面背景图要内联进单文件版
});
