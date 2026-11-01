/** pdf.js worker 以 Vite 资源 URL 方式引入（`?url` 后缀不产生类型，这里补声明） */
declare module 'pdfjs-dist/build/pdf.worker.min.mjs?url' {
  const url: string;
  export default url;
}
