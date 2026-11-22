// 把 vite 打包结果合成一个单文件网页（JS 内联）：dist/single.html，并复制到 docs/index.html 给 GitHub Pages 用
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

let html = readFileSync('dist/index.html', 'utf8');
html = html.replace(/<script type="module" crossorigin src="\.\/(assets\/[^"]+\.js)"><\/script>/, (_, f) => {
  const js = readFileSync('dist/' + f, 'utf8').replace(/<\/script/gi, '<\\/script');
  return '<script type="module">' + js + '</script>';
});
if (/src="\.\/assets/.test(html)) throw new Error('还有没内联的资源');
if (/assets\/[\w-]+\.(webp|png|jpg|svg)/.test(html)) throw new Error('脚本里还引用了没内联的图片');
writeFileSync('dist/single.html', html);
// GitHub Pages 从 docs/ 目录发布，别人打开链接就能玩
mkdirSync('docs', { recursive: true });
writeFileSync('docs/index.html', html);
writeFileSync('docs/.nojekyll', '');
console.log('dist/single.html + docs/index.html', (html.length / 1024).toFixed(1), 'KB');
