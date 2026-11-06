/*
 * 打包成单文件 HTML：把 Tailwind 运行时和三个 js 全部内联。
 * 产物双击即可在任何浏览器打开，不需要起服务器、不需要联网。
 *
 * 用法：node build/build.js [tailwind.js 路径]
 */
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var DIST = path.join(ROOT, 'dist');
var TW = process.argv[2] || path.join(ROOT, 'assets/tailwind.js');

function read(p) { return fs.readFileSync(p, 'utf8'); }

var html = read(path.join(ROOT, 'index.html'));

// ---- 先在原始 HTML 上做外部依赖检查（内联后的第三方代码里会含自身 URL 字符串）----
var CDN_TAG = '<script src="assets/tailwind.js"></script>';
var externals = (html.match(/(?:src|href)="(?:https?:)?\/\/[^"]+"/g) || [])
  .filter(function (s) { return s.indexOf('cdn.tailwindcss.com') === -1; });
if (externals.length) throw new Error('index.html 含未预期的外部依赖: ' + externals.join(', '));
if (html.indexOf(CDN_TAG) === -1) throw new Error('未找到 Tailwind CDN 标签');

var LOCAL = ['js/period.js', 'js/storage.js', 'js/api.js', 'js/app.js'];
LOCAL.forEach(function (rel) {
  if (html.indexOf('<script src="' + rel + '"></script>') === -1) {
    throw new Error('未找到脚本标签: ' + rel);
  }
});

// ---- 内联 ----
// 必须用替换函数：压缩后的第三方代码里含 `$&` `$'` 等序列，
// 直接把它当替换字符串会被 String.replace 当成反向引用，把原标签重新注入产物。
function inline(target, tag, comment, code) {
  var idx = target.indexOf(tag);
  if (idx === -1) throw new Error('未找到标签: ' + tag);
  return target.slice(0, idx) +
    '<script>\n/* ' + comment + ' */\n' + code + '\n</script>' +
    target.slice(idx + tag.length);
}

// 背景图转 data URI，让单文件产物也有背景（file:// 下无法读同目录 svg）
var BG_REL = "assets/backdrop.svg";
var bgTag = "url('" + BG_REL + "')";
if (html.indexOf(bgTag) === -1) throw new Error('未找到背景图引用: ' + bgTag);
var bgSvg = read(path.join(ROOT, BG_REL));
var bgUri = "url(\"data:image/svg+xml;base64," + Buffer.from(bgSvg, 'utf8').toString('base64') + "\")";
html = html.split(bgTag).join(bgUri);

// PWA manifest 在单文件里没有意义：manifest 的 data: URI 会被浏览器拒绝，
// 而 file:// 也装不了 PWA。直接去掉标签，比留一个 404 引用干净。
// 要「添加到主屏幕」请用 http 方式访问 server 托管的版本。
var MANIFEST_TAG = '<link rel="manifest" href="manifest.webmanifest">';
if (html.indexOf(MANIFEST_TAG) === -1) throw new Error('未找到 manifest 标签');
html = html.replace(MANIFEST_TAG,
  '<!-- manifest 已在单文件产物中移除：file:// 无法安装 PWA -->');

html = inline(html, CDN_TAG, 'Tailwind CSS 运行时（内联，离线可用）', read(TW));

LOCAL.forEach(function (rel) {
  html = inline(html, '<script src="' + rel + '"></script>', rel, read(path.join(ROOT, rel)));
});

// ---- 内联后校验：先剥掉 script 内容再扫标签 ----
// （Tailwind 运行时的源码里含 "<script src=\"https://cdn.tailwindcss.com\">" 这样的
//   提示字符串，直接扫全文会误报，必须先把脚本正文去掉。）
var stripped = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, function (block) {
  var open = block.match(/^<script\b[^>]*>/i)[0];
  return open + '</script>';
});
var bad = (stripped.match(/<(?:script|link)\b[^>]*\b(?:src|href)="[^"]+"[^>]*>/gi) || [])
  .filter(function (t) { return !/href="#/.test(t); });
if (bad.length) throw new Error('仍有未内联的资源: ' + bad.join(', '));

if (!fs.existsSync(DIST)) fs.mkdirSync(DIST);
var out = path.join(DIST, 'nebula-rosette.html');
fs.writeFileSync(out, html);
console.log('已生成 ' + out + '（' + (Buffer.byteLength(html) / 1024).toFixed(0) + ' KB）');
