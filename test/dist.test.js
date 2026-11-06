/*
 * dist 产物校验：确认单文件 HTML 自洽、无外部依赖，
 * 且内联进去的 app 代码在 DOM stub 下仍能正常初始化。
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.join(__dirname, '..');
var DIST = path.join(ROOT, 'dist/nebula-rosette.html');

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name); console.log('       ' + (e && e.message)); }
}

if (!fs.existsSync(DIST)) {
  console.log('  跳过：dist 未生成，先运行 node build/build.js');
  process.exit(0);
}

var dist = fs.readFileSync(DIST, 'utf8');

/** 剥掉 script 正文，避免第三方代码里的字符串干扰标签检查 */
function stripScripts(h) {
  return h.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, function (block) {
    return block.match(/^<script\b[^>]*>/i)[0] + '</script>';
  });
}

console.log('\n[单文件产物]');

test('产物无任何外部 script/link 引用（离线可用）', function () {
  var tags = stripScripts(dist).match(/<(?:script|link)\b[^>]*\b(?:src|href)="[^"]+"[^>]*>/gi) || [];
  var bad = tags.filter(function (t) { return !/href="#/.test(t); });
  assert.deepStrictEqual(bad, [], '外部引用: ' + bad.join(', '));
});

test('产物无任何 http(s) 外链资源', function () {
  // 剥掉 script 正文后再看剩余标记里有没有网络资源
  var s = stripScripts(dist);
  var urls = (s.match(/(?:src|href)="https?:\/\/[^"]+"/gi) || []);
  assert.deepStrictEqual(urls, [], '外链: ' + urls.join(', '));
  // CSS 里的 url() 也要检查
  var cssUrls = (s.match(/url\((['"]?)https?:\/\/[^)]+\)/gi) || []);
  assert.deepStrictEqual(cssUrls, [], 'CSS 外链: ' + cssUrls.join(', '));
});

test('产物不含 cdn.tailwindcss.com 的 script 标签', function () {
  assert.ok(stripScripts(dist).indexOf('src="https://cdn.tailwindcss.com"') === -1,
    'CDN 标签仍在（替换字符串里的 $& 会导致原标签被重新注入）');
});

test('Tailwind 运行时与业务脚本都已内联', function () {
  assert.ok(dist.indexOf('global.PeriodCore = API') > -1, 'period.js 未内联');
  assert.ok(dist.indexOf('global.Storage =') > -1, 'storage.js 未内联');
  assert.ok(dist.indexOf('global.Api =') > -1, 'api.js 未内联');
  assert.ok(dist.indexOf('function buildCycleSummary') > -1, 'app.js 未内联');
  assert.ok(dist.length > 300 * 1024, 'Tailwind 运行时似乎没进去，产物过小');
});

test('script 标签开闭数量一致', function () {
  var open = (dist.match(/<script\b/gi) || []).length;
  var close = (dist.match(/<\/script>/gi) || []).length;
  assert.strictEqual(open, close, open + ' 个 <script> vs ' + close + ' 个 </script>');
});

test('产物保留全部四个视图与导航', function () {
  ['view-calendar', 'view-history', 'view-ai', 'view-settings'].forEach(function (id) {
    assert.ok(dist.indexOf('id="' + id + '"') > -1, '缺少 ' + id);
  });
  assert.strictEqual((dist.match(/data-goto=/g) || []).length >= 5, true);
});

test('产物保留日历样式与环形进度所需的定义', function () {
  ['.seg', '.seg-start', '.seg-end', '.pred', '.pred-core', '.fertile', '.is-today', '.dots']
    .forEach(function (sel) {
      // 样式可能写成 `.x {`、`.x::before`、`.x,` 等形式，用词边界匹配
      var re = new RegExp('\\' + sel + '(?![\\w-])');
      assert.ok(re.test(dist), '缺少样式 ' + sel);
    });
  assert.ok(dist.indexOf('id="ringGrad"') > -1, '缺少环形渐变定义');
  assert.ok(dist.indexOf('id="ring-bar"') > -1, '缺少环形进度条');
});

test('产物包含 AI 两种连接方式的配置项', function () {
  ['mode-server', 'mode-direct', 'set-base-url', 'set-model', 'set-api-key', 'btn-test-ai']
    .forEach(function (id) {
      assert.ok(dist.indexOf('id="' + id + '"') > -1, '缺少 ' + id);
    });
  assert.ok(/id="set-api-key"[^>]*type="password"/.test(dist), 'key 输入框应为 password');
});

test('产物包含账号登录界面', function () {
  ['acct-server-url', 'acct-username', 'acct-password', 'btn-login', 'btn-register',
   'btn-logout', 'btn-sync-now', 'acct-logged-in', 'acct-logged-out']
    .forEach(function (id) {
      assert.ok(dist.indexOf('id="' + id + '"') > -1, '缺少 ' + id);
    });
  assert.ok(/id="acct-password"[^>]*type="password"/.test(dist), '密码框应为 password');
});

test('产物包含账号自存 Key 的表单，且 Key 输入框是 password', function () {
  ['acct-ai-box', 'srv-base-url', 'srv-model', 'srv-api-key',
   'btn-save-ai-config', 'btn-del-ai-config', 'acct-ai-status']
    .forEach(function (id) {
      assert.ok(dist.indexOf('id="' + id + '"') > -1, '缺少 ' + id);
    });
  assert.ok(/id="srv-api-key"[^>]*type="password"/.test(dist), 'srv-api-key 应为 password');
});

test('背景图已转成 data URI，产物不再引用 assets 目录', function () {
  assert.ok(dist.indexOf('data:image/svg+xml;base64') > -1, '背景图未内联');
  assert.ok(dist.indexOf("url('assets/backdrop.svg')") === -1, '仍引用外部 svg');
  assert.ok(dist.indexOf('id="set-cal-bg"') > -1, '缺少背景图开关');
  assert.ok(/\.cal-card::before[\s\S]*?pointer-events:\s*none/.test(dist),
    '背景层必须 pointer-events:none');
});

test('产物不含任何密钥字面量', function () {
  assert.ok(!/sk-[A-Za-z0-9]{16,}/.test(dist));
  assert.ok(!/Bearer\s+[A-Za-z0-9._-]{20,}/.test(dist));
});

test('单文件产物移除 manifest 引用（file:// 装不了 PWA，留着只是 404）', function () {
  assert.ok(dist.indexOf('href="manifest.webmanifest"') === -1, '仍引用 manifest');
  assert.ok(dist.indexOf('manifest 已在单文件产物中移除') > -1, '缺少移除说明的注释');
});

test('产物保留深色模式所需的变量与开关', function () {
  assert.ok(/body\.dark\s*\{/.test(dist), '缺少 body.dark 变量组');
  ['theme-auto', 'theme-light', 'theme-dark'].forEach(function (id) {
    assert.ok(dist.indexOf('id="' + id + '"') > -1, '缺少 ' + id);
  });
  assert.ok(dist.indexOf('id="meta-theme-color"') > -1, '缺少可切换的 theme-color');
  assert.ok(/body\.dark input/.test(dist), '深色下输入框需要单独覆盖，否则一片白底');
});

test('产物保留提醒横幅与趋势区块', function () {
  ['reminder', 'reminder-title', 'reminder-detail', 'reminder-close',
   'trend-chart', 'trend-insight'].forEach(function (id) {
    assert.ok(dist.indexOf('id="' + id + '"') > -1, '缺少 ' + id);
  });
  ['.banner-soon', '.banner-warn', '.banner-ongoing', '.bar-track'].forEach(function (sel) {
    assert.ok(new RegExp('\\' + sel + '(?![\\w-])').test(dist), '缺少样式 ' + sel);
  });
});

test('产物保留改密码与昵称表单，密码框都是 password', function () {
  ['prof-nickname', 'btn-save-profile', 'pwd-old', 'pwd-new', 'pwd-new2',
   'btn-change-pwd', 'pwd-logout-others'].forEach(function (id) {
    assert.ok(dist.indexOf('id="' + id + '"') > -1, '缺少 ' + id);
  });
  ['pwd-old', 'pwd-new', 'pwd-new2'].forEach(function (id) {
    assert.ok(new RegExp('id="' + id + '"[^>]*type="password"').test(dist),
      id + ' 应为 password');
  });
});

test('产物里的预测经期缎带样式存在', function () {
  ['.pred-bleed', '.pred-bleed-start', '.pred-bleed-end'].forEach(function (sel) {
    assert.ok(new RegExp('\\' + sel + '(?![\\w-])').test(dist), '缺少样式 ' + sel);
  });
});

console.log('\n[产物运行时冒烟]');

/** 从产物中抽出业务脚本（跳过 Tailwind 运行时），在 stub 里执行 */
function extractBusinessScripts(h) {
  var out = [];
  var re = /<script>\n\/\* (js\/[a-z.]+) \*\/\n([\s\S]*?)\n<\/script>/g, m;
  while ((m = re.exec(h))) out.push({ name: m[1], code: m[2] });
  return out;
}

var scripts = extractBusinessScripts(dist);

test('能从产物中抽回四个业务脚本', function () {
  assert.deepStrictEqual(scripts.map(function (s) { return s.name; }),
    ['js/period.js', 'js/storage.js', 'js/api.js', 'js/app.js']);
});

var htmlIds = {};
var initiallyHidden = {};
dist.replace(/<[a-zA-Z][^>]*>/g, function (tag) {
  var m = tag.match(/\sid="([^"]+)"/);
  if (!m) return tag;
  htmlIds[m[1]] = true;
  if (/\shidden(?=[\s>/])/.test(tag)) initiallyHidden[m[1]] = true;
  return tag;
});

function makeEl(id) {
  var el = {
    id: id, hidden: !!initiallyHidden[id], checked: false, value: '', textContent: '',
    _html: '', files: null, style: {}, _listeners: {},
    classList: {
      _s: {}, add: function (c) { this._s[c] = true; }, remove: function (c) { delete this._s[c]; },
      toggle: function (c, on) { if (on) this._s[c] = true; else delete this._s[c]; },
      contains: function (c) { return !!this._s[c]; }
    },
    setAttribute: function (k, v) { this['attr_' + k] = v; },
    removeAttribute: function (k) { delete this['attr_' + k]; },
    getAttribute: function (k) { return this['attr_' + k] === undefined ? null : this['attr_' + k]; },
    addEventListener: function (ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
    dispatch: function (ev, arg) {
      var e = arg || {};
      if (!e.preventDefault) e.preventDefault = function () {};
      if (!e.target) e.target = { closest: function () { return null; } };
      (this._listeners[ev] || []).forEach(function (fn) { fn(e); });
    },
    focus: function () {}, click: function () { this.dispatch('click'); },
    closest: function () { return null; }, querySelectorAll: function () { return []; },
    scrollTop: 0, scrollHeight: 0
  };
  Object.defineProperty(el, 'innerHTML', {
    get: function () { return el._html; },
    set: function (v) {
      if (/undefined|NaN/.test(String(v))) throw new Error('渲染含 undefined/NaN (#' + id + ')');
      el._html = String(v);
    }
  });
  return el;
}

var env = null, bootErr = null;
try {
  var els = {};
  Object.keys(htmlIds).forEach(function (id) { els[id] = makeEl(id); });
  // body 需要 classList：applyCalBg 会在上面切 no-cal-bg
  els.__body = { style: {}, classList: { _s: {},
    add: function (c) { this._s[c] = true; },
    remove: function (c) { delete this._s[c]; },
    toggle: function (c, on) { if (on) this._s[c] = true; else delete this._s[c]; },
    contains: function (c) { return !!this._s[c]; } } };
  var store = {};
  function tabs(prefix) {
    return ['calendar', 'history', 'ai', 'settings'].map(function (n) {
      var e = makeEl(prefix + n); e.setAttribute('data-goto', n); return e;
    });
  }
  var sandbox = {
    console: { error: function () {}, log: function () {} },
    document: {
      readyState: 'complete', activeElement: null, body: els.__body,
      getElementById: function (id) { return els[id] || null; },
      querySelectorAll: function (sel) {
        if (sel === '.tab') return (els.__t = els.__t || tabs('tab-'));
        if (sel === '[data-goto]') return (els.__g = els.__g || tabs('goto-'));
        return [];
      },
      createElement: function () { return makeEl('tmp'); },
      addEventListener: function () {}
    },
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    Promise: Promise, Date: Date, Math: Math, JSON: JSON, Object: Object, Array: Array,
    Number: Number, String: String, Boolean: Boolean, Error: Error, RegExp: RegExp,
    Blob: function () {}, FileReader: function () { this.readAsText = function () {}; },
    URL: { createObjectURL: function () { return 'blob:x'; }, revokeObjectURL: function () {} },
    AbortController: function () { this.signal = {}; this.abort = function () {}; },
    fetch: function () { return Promise.resolve({ ok: true, status: 200,
      text: function () { return Promise.resolve('{}'); },
      json: function () { return Promise.resolve({ answer: 'x' }); } }); },
    localStorage: {
      getItem: function (k) { return store[k] === undefined ? null : store[k]; },
      setItem: function (k, v) { store[k] = v; },
      removeItem: function (k) { delete store[k]; }
    },
    indexedDB: null,
    _els: els, _store: store
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.confirm = function () { return true; };
  sandbox.window.scrollTo = function () {};
  var ctx = vm.createContext(sandbox);
  scripts.forEach(function (s) { vm.runInContext(s.code, ctx, { filename: 'dist:' + s.name }); });
  env = sandbox;
} catch (e) {
  bootErr = e;
}

setTimeout(function () {
  test('产物里的脚本能完成初始化', function () {
    assert.strictEqual(bootErr, null, bootErr && bootErr.stack);
    assert.ok(env.PeriodCore && env.Storage);
  });

  test('产物首屏渲染正常', function () {
    assert.strictEqual(env._els['status-headline'].textContent, '开始记录吧');
    var cells = (env._els['cal-grid'].innerHTML.match(/data-day="/g) || []).length;
    var now = new Date();
    assert.strictEqual(cells, new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate());
  });

  test('产物中记录按钮可用并写入存储', function () {
    env._els['btn-quick'].dispatch('click');
    return null;
  });

  setTimeout(function () {
    test('产物点击后数据已持久化', function () {
      var raw = env._store['nebula-rosette:periods'];
      assert.ok(raw, '未写入');
      assert.strictEqual(JSON.parse(raw).length, 1);
    });

    test('产物里背景图默认开启（body 无 no-cal-bg）', function () {
      assert.strictEqual(env._els.__body.classList.contains('no-cal-bg'), false);
      assert.strictEqual(env._els['set-cal-bg'].checked, true);
    });

    console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
    process.exit(failed ? 1 : 0);
  }, 60);
}, 60);
