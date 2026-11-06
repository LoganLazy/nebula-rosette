/*
 * app.js / index.html 一致性 + 运行时冒烟测试
 *
 * 环境无可用浏览器（Playwright 不支持 debian11-x64，且无 npm 装 jsdom），
 * 因此用最小 DOM stub 在 Node 里真实执行 app.js 的启动与交互路径。
 * 覆盖：id 拼写、初始渲染、事件回调、持久化、降级路径。
 * 不覆盖：真实布局与视觉效果 —— 那部分需要在浏览器里人工确认。
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.join(__dirname, '..');
var html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
var appSrc = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
var storageSrc = fs.readFileSync(path.join(ROOT, 'js/storage.js'), 'utf8');
var periodSrc = fs.readFileSync(path.join(ROOT, 'js/period.js'), 'utf8');
var apiSrc = fs.readFileSync(path.join(ROOT, 'js/api.js'), 'utf8');

var passed = 0, failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (e) {
    failed++;
    console.log('  FAIL ' + name);
    console.log('       ' + (e && e.message ? e.message.split('\n').join('\n       ') : e));
  }
}

function section(t) { console.log('\n[' + t + ']'); }

// ---------- 解析 HTML 里的 id 与初始 hidden 状态 ----------

var htmlIds = {};
var initiallyHidden = {};
html.replace(/<[a-zA-Z][^>]*>/g, function (tag) {
  var m = tag.match(/\sid="([^"]+)"/);
  if (!m) return tag;
  htmlIds[m[1]] = true;
  if (/\shidden(?=[\s>/])/.test(tag)) initiallyHidden[m[1]] = true;
  return tag;
});

// ---------- 最小 DOM stub ----------

function makeEl(id) {
  var el = {
    id: id,
    hidden: !!initiallyHidden[id],
    checked: false,
    value: '',
    textContent: '',
    _html: '',
    files: null,
    style: {},
    _listeners: {},
    classList: {
      _s: {},
      add: function (c) { this._s[c] = true; },
      remove: function (c) { delete this._s[c]; },
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
    focus: function () {},
    click: function () { this.dispatch('click'); },
    closest: function () { return null; },
    // 只支持 [data-xxx] 形式的选择器：从自己的 innerHTML 里解析出带该属性的
    // 标签，生成可读写 aria-pressed 的轻量子元素并缓存。
    // 这是为了能真实测到症状 chips 的多选逻辑，而不是让它退化成空数组。
    querySelectorAll: function (sel) {
      var m = /^\[([a-z-]+)\]$/.exec(sel || '');
      if (!m) return [];
      var attr = m[1];
      this._kids = this._kids || {};
      var cache = this._kids[attr];
      var re = new RegExp('<button[^>]*\\s' + attr + '="([^"]+)"[^>]*>', 'g');
      var keys = [];
      var hit;
      while ((hit = re.exec(this._html))) keys.push(hit[1]);
      if (!cache || cache._keys.join() !== keys.join()) {
        cache = keys.map(function (k) {
          var kid = makeEl('kid-' + attr + '-' + k);
          kid.setAttribute(attr, k);
          kid.setAttribute('aria-pressed', 'false');
          return kid;
        });
        cache._keys = keys;
        this._kids[attr] = cache;
      }
      return cache;
    },
    scrollTop: 0,
    scrollHeight: 0
  };
  Object.defineProperty(el, 'innerHTML', {
    get: function () { return el._html; },
    set: function (v) {
      if (v === undefined) throw new Error('innerHTML 被赋值为 undefined (#' + id + ')');
      if (/undefined|NaN/.test(String(v))) {
        throw new Error('渲染结果含 undefined/NaN (#' + id + '): ' + String(v).slice(0, 200));
      }
      el._html = String(v);
    }
  });
  return el;
}

/**
 * seed: 预置的 localStorage 内容（键不含前缀）
 * responder: (url, opts) => 响应体；可带 __status 模拟错误码
 * opts.systemDark: 模拟系统深色偏好；未传则不提供 matchMedia（模拟老浏览器）
 * opts.protocol: 'http:' | 'file:'，用于验证 SW 在 file:// 下不注册
 */
function buildEnv(seed, responder, opts) {
  opts = opts || {};
  var els = {};
  Object.keys(htmlIds).forEach(function (id) { els[id] = makeEl(id); });
  els.__body = { style: {}, classList: { _s: {},
    add: function (c) { this._s[c] = true; },
    remove: function (c) { delete this._s[c]; },
    toggle: function (c, on) { if (on) this._s[c] = true; else delete this._s[c]; },
    contains: function (c) { return !!this._s[c]; } } };

  var store = {};
  Object.keys(seed || {}).forEach(function (k) {
    store['nebula-rosette:' + k] = JSON.stringify(seed[k]);
  });

  function fakeTabs(prefix) {
    return ['calendar', 'history', 'ai', 'settings'].map(function (n) {
      var e = makeEl(prefix + n);
      e.setAttribute('data-goto', n);
      return e;
    });
  }

  var docListeners = {};
  // 导出下载的记录。Blob 内容要能取回来，否则「CSV 里有没有防注入前缀」
  // 这类断言只能靠猜。
  var downloads = [];
  var blobText = {};
  var blobSeq = 0;
  var document = {
    readyState: 'complete',
    activeElement: null,
    body: els.__body,
    getElementById: function (id) { return els[id] || null; },
    querySelectorAll: function (sel) {
      if (sel === '.tab') return (els.__tabs = els.__tabs || fakeTabs('tab-'));
      if (sel === '[data-goto]') return (els.__gotos = els.__gotos || fakeTabs('goto-'));
      return [];
    },
    createElement: function (tag) {
      var el = makeEl('tmp-' + tag);
      // 导出走的是「建 <a>、设 download、click()」这条路，之前 click 是
      // 空实现所以完全测不到导出内容。这里把它记下来。
      el.click = function () {
        downloads.push({ name: el.download, href: el.href, text: blobText[el.href] || '' });
      };
      return el;
    },
    // document 级监听要真的记下来：键盘快捷键（Esc 关弹层、方向键换月）
    // 全挂在这里，之前的空实现让这条路径完全测不到。
    addEventListener: function (ev, fn) { (docListeners[ev] = docListeners[ev] || []).push(fn); },
    dispatch: function (ev, arg) {
      var e = arg || {};
      if (!e.preventDefault) e.preventDefault = function () {};
      (docListeners[ev] || []).forEach(function (fn) { fn(e); });
    }
  };

  var fetchCalls = [];
  var sandbox = {
    console: { error: function () {}, log: function () {} },
    document: document,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    Promise: Promise, Date: Date, Math: Math, JSON: JSON,
    Object: Object, Array: Array, Number: Number, String: String, Boolean: Boolean,
    Error: Error, RegExp: RegExp, isNaN: isNaN, parseInt: parseInt,
    Blob: function (parts) { this._text = (parts || []).join(''); },
    FileReader: function () { this.readAsText = function () {}; },
    URL: {
      createObjectURL: function (b) {
        var u = 'blob:' + (++blobSeq);
        blobText[u] = (b && b._text) || '';
        return u;
      },
      revokeObjectURL: function () {}
    },
    AbortController: function () { this.signal = {}; this.abort = function () {}; },
    fetch: function (url, opts) {
      fetchCalls.push({
        url: url,
        method: (opts && opts.method) || 'GET',
        body: opts && opts.body,
        headers: (opts && opts.headers) || {}
      });
      var reply = (fetchResponder && fetchResponder(url, opts)) || { answer: '这是回复' };
      return Promise.resolve(reply).then(function (reply) { return {
        ok: reply.__status === undefined || reply.__status < 400,
        status: reply.__status || 200,
        text: function () { return Promise.resolve(JSON.stringify(reply)); },
        json: function () { return Promise.resolve(reply); }
      }; });
    },
    localStorage: {
      getItem: function (k) { return store[k] === undefined ? null : store[k]; },
      setItem: function (k, v) { store[k] = v; },
      removeItem: function (k) { delete store[k]; }
    },
    indexedDB: null,  // 强制走 localStorage 降级路径
    _els: els,
    _doc: document,
    _store: store,
    _fetchCalls: fetchCalls,
    _downloads: downloads,
    _setResponder: function (fn) { fetchResponder = fn; }
  };

  // matchMedia 与 location / serviceWorker：主题跟随系统和 SW 注册都要用
  var mediaListeners = [];
  if (opts.systemDark !== undefined) {
    sandbox.matchMedia = function (q) {
      var mq = {
        media: q,
        addEventListener: function (ev, fn) { if (ev === 'change') mediaListeners.push(fn); },
        removeEventListener: function () {}
      };
      // matches 必须是 getter：真实的 MediaQueryList 会随系统设置变化，
      // 固定成布尔值就测不出「跟随系统实时生效」。
      Object.defineProperty(mq, 'matches', {
        get: function () { return /dark/.test(q) ? !!opts.systemDark : false; }
      });
      return mq;
    };
  }
  sandbox.location = { protocol: opts.protocol || 'http:', href: 'http://localhost:8000/' };
  var swRegistrations = [];
  var copied = [];
  sandbox.navigator = {
    serviceWorker: opts.noServiceWorker ? undefined : {
      register: function (u) { swRegistrations.push(u); return Promise.resolve({}); }
    },
    clipboard: opts.noClipboard ? undefined : {
      writeText: function (t) { copied.push(t); return Promise.resolve(); }
    }
  };
  sandbox._swRegistrations = swRegistrations;
  sandbox._copied = copied;
  sandbox._fireSystemThemeChange = function (dark) {
    opts.systemDark = dark;
    mediaListeners.forEach(function (fn) { fn({ matches: dark }); });
  };
  var fetchResponder = responder || null;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  // confirm 默认放行，但要能被单个测试改成「用户点了取消」——
  // 不可逆操作的取消路径本身就是需要断言的行为。
  sandbox._confirms = [];
  sandbox._confirmResult = true;
  sandbox.window.confirm = function (msg) {
    sandbox._confirms.push(msg);
    return sandbox._confirmResult;
  };
  sandbox.window.scrollTo = function () {};

  var ctx = vm.createContext(sandbox);
  vm.runInContext(periodSrc, ctx, { filename: 'period.js' });
  vm.runInContext(storageSrc, ctx, { filename: 'storage.js' });
  vm.runInContext(apiSrc, ctx, { filename: 'api.js' });
  vm.runInContext(appSrc, ctx, { filename: 'app.js' });
  return sandbox;
}

function flush(ms) {
  return new Promise(function (r) { setTimeout(r, ms || 60); });
}

/**
 * 从日历 HTML 中抽出某一天完整的 <button> 元素。
 * class 属性在 data-day 之前，所以必须从 <button 起始匹配，
 * 否则拿不到样式类。
 */
function cellOf(html, dayKey) {
  var m = html.match(new RegExp('<button[^>]*data-day="' + dayKey + '"[\\s\\S]*?</button>'));
  return m ? m[0] : null;
}

// ---------- 主流程 ----------

(async function () {

  section('HTML / JS 一致性');

  await test("app.js 里 $('id') 引用的元素都存在于 index.html", function () {
    var missing = [];
    var re = /\$\('([^']+)'\)/g, m;
    while ((m = re.exec(appSrc))) if (!htmlIds[m[1]]) missing.push(m[1]);
    assert.deepStrictEqual(missing, [], '缺失 id: ' + missing.join(', '));
  });

  await test('data-goto 目标都有对应的 view-* 容器', function () {
    var targets = {};
    html.replace(/data-goto="([^"]+)"/g, function (_, t) { targets[t] = true; return _; });
    var names = Object.keys(targets);
    assert.ok(names.length >= 4);
    names.forEach(function (n) { assert.ok(htmlIds['view-' + n], '缺少容器 view-' + n); });
  });

  await test('goto() 的视图列表与 HTML 中的 view-* 完全一致', function () {
    assert.ok(/\['calendar', 'history', 'ai', 'settings'\]/.test(appSrc), 'goto 视图列表未找到');
    var inHtml = Object.keys(htmlIds).filter(function (id) { return id.indexOf('view-') === 0; })
      .map(function (id) { return id.slice(5); }).sort();
    assert.deepStrictEqual(inHtml, ['ai', 'calendar', 'history', 'settings']);
  });

  await test('脚本按依赖顺序加载（app.js 最后）', function () {
    var iP = html.indexOf('js/period.js'), iS = html.indexOf('js/storage.js'), iA = html.indexOf('js/app.js');
    assert.ok(iP > -1 && iS > -1 && iA > -1);
    assert.ok(iP < iA && iS < iA);
  });

  await test('viewport 与 theme-color 已设置（移动端适配前提）', function () {
    assert.ok(/name="viewport"/.test(html));
    assert.ok(/name="theme-color"/.test(html));
    assert.ok(/env\(safe-area-inset-bottom\)/.test(html), '应处理 iPhone 底部安全区');
  });

  await test('日历背景图已挂在 cal-card 上，且不遮挡内容', function () {
    assert.ok(/class="[^"]*cal-card[^"]*"/.test(html), '日历卡片应带 cal-card 类');
    assert.ok(html.indexOf("--cal-bg: url('assets/backdrop.svg')") > -1, '缺少背景图变量');
    assert.ok(/\.cal-card::before[\s\S]*?pointer-events:\s*none/.test(html),
      '背景层必须 pointer-events:none，否则挡住日期点击');
    assert.ok(/\.cal-card > \*\s*{\s*position:\s*relative;\s*z-index:\s*1/.test(html),
      '内容需要抬到背景层之上');
    assert.ok(/body\.no-cal-bg .cal-card::before/.test(html), '缺少关闭背景的开关样式');
  });

  await test('背景 SVG 无外部引用且尺寸受控', function () {
    var svg = fs.readFileSync(path.join(ROOT, 'assets/backdrop.svg'), 'utf8');
    assert.ok(!/https?:\/\//.test(svg.replace(/xmlns="[^"]*"/g, '')), 'SVG 不应引用外部资源');
    assert.ok(!/<image\b/.test(svg), '不应嵌入位图');
    assert.ok(svg.length < 20000, 'SVG 过大: ' + svg.length);
  });

  section('隐私与安全');

  await test('前端源码中不含任何 API Key 或密钥字面量', function () {
    var all = appSrc + storageSrc + html;
    [/sk-[A-Za-z0-9]{16,}/, /api[_-]?key\s*[:=]\s*['"][A-Za-z0-9]{12,}/i, /Bearer\s+[A-Za-z0-9._-]{20,}/]
      .forEach(function (re) { assert.ok(!re.test(all), '疑似密钥: ' + re); });
  });

  await test('直连模式的 key 输入框是 password 类型且默认值为空', function () {
    assert.ok(/id="set-api-key"[^>]*type="password"/.test(html),
      'key 输入框应为 password 类型');
    assert.ok(!/id="set-api-key"[^>]*value="[^"]+"/.test(html), '不应有预填值');
    assert.strictEqual(require(path.join(ROOT, 'js/storage.js')).DEFAULT_SETTINGS.apiKey, '');
  });

  await test('直连模式在 UI 上有明确的 key 风险提示', function () {
    assert.ok(html.indexOf('不要把配好 key 的页面发给别人') > -1, '缺少直连风险提示');
  });

  await test('源码中没有硬编码的第三方大模型域名（不预置任何服务商）', function () {
    var all = appSrc + storageSrc;
    [/dashscope\.aliyuncs\.com/, /api\.openai\.com/, /api\.deepseek\.com/]
      .forEach(function (re) { assert.ok(!re.test(all), '不应硬编码: ' + re); });
  });

  await test('AI 请求只上报周期摘要，不含原始记录或备注正文', function () {
    var m = appSrc.match(/function buildCycleSummary\(\)[\s\S]*?\n  \}/);
    assert.ok(m, 'buildCycleSummary 未找到');
    var body = m[0];
    assert.ok(body.indexOf('state.periods.length') > -1, '应只上报记录条数');
    assert.ok(!/notes/.test(body), '摘要不应触及 notes');
    assert.ok(!/\.text\b/.test(body), '摘要不应包含备注正文');
  });

  await test('导出数据不含 AI 配置与密钥', function () {
    var m = storageSrc.match(/function exportAll[\s\S]*?\n  \}/);
    assert.ok(m);
    ['aiEndpoint', 'apiKey', 'baseUrl'].forEach(function (k) {
      assert.ok(m[0].indexOf(k) === -1, '导出不应带 ' + k);
    });
  });

  section('运行时冒烟 —— 空数据首启');

  var env = buildEnv();
  var el = function (id) { return env._els[id]; };
  await flush();

  await test('三脚本在无 indexedDB 环境下加载并完成初始化', function () {
    assert.ok(env.PeriodCore && env.Storage);
  });

  await test('空数据首屏显示引导文案', function () {
    assert.strictEqual(el('status-headline').textContent, '开始记录吧');
    assert.strictEqual(el('btn-quick').textContent, '今天来了');
    assert.ok(el('predict-body').innerHTML.indexOf('标记一次经期开始') > -1);
    assert.ok(el('stability-body').innerHTML.indexOf('3 次') > -1);
    assert.strictEqual(el('btn-undo').hidden, true, '无操作时不应显示撤销');
  });

  await test('日历渲染当月全部格子且包含今天', function () {
    var h = el('cal-grid').innerHTML;
    var count = (h.match(/data-day="/g) || []).length;
    var now = new Date();
    assert.strictEqual(count, new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate());
    assert.ok(h.indexOf(env.PeriodCore.todayKey()) > -1);
  });

  await test('日历格子带 aria-label（无障碍）', function () {
    assert.ok(/aria-label="[^"]*日[^"]*"/.test(el('cal-grid').innerHTML));
    assert.ok(/role="gridcell"/.test(el('cal-grid').innerHTML));
  });

  await test('默认停留日历页，其余三页隐藏', function () {
    assert.strictEqual(el('view-calendar').hidden, false);
    assert.strictEqual(el('view-history').hidden, true);
    assert.strictEqual(el('view-ai').hidden, true);
    assert.strictEqual(el('view-settings').hidden, true);
  });

  await test('AI 默认关闭：显示未开启提示且未发出任何请求', function () {
    assert.strictEqual(env.Storage.DEFAULT_SETTINGS.aiEnabled, false);
    assert.strictEqual(el('ai-disabled').hidden, false);
    assert.strictEqual(el('ai-panel').hidden, true);
    assert.strictEqual(env._fetchCalls.length, 0);
  });

  await test('存储降级到 localStorage 时设置页正确提示', function () {
    assert.ok(el('storage-info').textContent.indexOf('localStorage') > -1,
      '实际: ' + el('storage-info').textContent);
  });

  await test('背景图默认开启，body 不带 no-cal-bg', function () {
    assert.strictEqual(env.Storage.DEFAULT_SETTINGS.calBg, true);
    assert.strictEqual(el('set-cal-bg').checked, true);
    assert.strictEqual(env._els.__body.classList.contains('no-cal-bg'), false);
  });

  await test('关闭背景图会加上 no-cal-bg 并持久化', async function () {
    el('set-cal-bg').checked = false;
    el('set-cal-bg').dispatch('change');
    await flush();
    assert.strictEqual(env._els.__body.classList.contains('no-cal-bg'), true);
    assert.strictEqual(JSON.parse(env._store['nebula-rosette:settings']).calBg, false);
    // 复原，避免影响后续用例
    el('set-cal-bg').checked = true;
    el('set-cal-bg').dispatch('change');
    await flush();
    assert.strictEqual(env._els.__body.classList.contains('no-cal-bg'), false);
  });

  await test('背景图设置能从存储恢复', async function () {
    var envBg = buildEnv({ settings: { calBg: false } });
    await flush();
    assert.strictEqual(envBg._els['set-cal-bg'].checked, false);
    assert.strictEqual(envBg._els.__body.classList.contains('no-cal-bg'), true);
  });

  section('运行时冒烟 —— 记录交互');

  await test('点击「今天来了」→ 经期第 1 天，按钮反转，撤销出现', async function () {
    el('btn-quick').dispatch('click');
    await flush();
    assert.ok(/经期第 1 天/.test(el('status-headline').textContent),
      '实际: ' + el('status-headline').textContent);
    assert.strictEqual(el('btn-quick').textContent, '今天结束了');
    assert.strictEqual(el('btn-undo').hidden, false);
  });

  await test('记录已持久化', function () {
    var arr = JSON.parse(env._store['nebula-rosette:periods']);
    assert.strictEqual(arr.length, 1);
    assert.strictEqual(arr[0].start, env.PeriodCore.todayKey());
    assert.strictEqual(arr[0].end, null);
  });

  await test('今天已标记后日历显示为经期段', function () {
    var h = el('cal-grid').innerHTML;
    var cell = cellOf(h, env.PeriodCore.todayKey());
    assert.ok(cell, '未找到今天的格子');
    assert.ok(/\bseg\b/.test(cell), '应带经期段样式: ' + cell);
    assert.ok(/seg-ongoing/.test(cell), '未记结束应标 ongoing');
    assert.ok(/经期第 1 天/.test(cell), 'aria-label 应说明第几天');
  });

  await test('再次点击 → 标记结束，不产生重复记录', async function () {
    el('btn-quick').dispatch('click');
    await flush();
    var arr = JSON.parse(env._store['nebula-rosette:periods']);
    assert.strictEqual(arr.length, 1);
    assert.strictEqual(arr[0].end, env.PeriodCore.todayKey());
  });

  await test('撤销结束标记可恢复为进行中', async function () {
    el('btn-undo').dispatch('click');
    await flush();
    var arr = JSON.parse(env._store['nebula-rosette:periods']);
    assert.strictEqual(arr[0].end, null);
    assert.strictEqual(el('btn-undo').hidden, true, '撤销后按钮应收起');
  });

  await test('切换月份不抛错且标题往返一致', function () {
    var before = el('cal-title').textContent;
    el('btn-prev-month').dispatch('click');
    assert.notStrictEqual(el('cal-title').textContent, before);
    el('btn-next-month').dispatch('click');
    assert.strictEqual(el('cal-title').textContent, before);
  });

  // ---------- 换月手势与键盘 ----------

  function swipe(e, dx, dy, ms) {
    e._els['cal-grid'].dispatch('touchstart', {
      touches: [{ clientX: 200, clientY: 300 }]
    });
    var done = function () {
      e._els['cal-grid'].dispatch('touchend', {
        changedTouches: [{ clientX: 200 + dx, clientY: 300 + dy }]
      });
    };
    if (ms) return new Promise(function (r) { setTimeout(function () { done(); r(); }, ms); });
    done();
    return Promise.resolve();
  }

  await test('往左滑一段 → 下个月', async function () {
    var before = el('cal-title').textContent;
    await swipe(env, -80, 5);
    assert.notStrictEqual(el('cal-title').textContent, before, '应换月');
    await swipe(env, 80, 5);
    assert.strictEqual(el('cal-title').textContent, before, '往右滑应回来');
  });

  await test('位移太小不换月（避免把点击当成滑动）', async function () {
    var before = el('cal-title').textContent;
    await swipe(env, -20, 3);
    assert.strictEqual(el('cal-title').textContent, before);
  });

  await test('纵向为主的手势不换月（否则滚页面会乱翻）', async function () {
    var before = el('cal-title').textContent;
    await swipe(env, -50, 120);
    assert.strictEqual(el('cal-title').textContent, before);
  });

  await test('双指手势不换月', async function () {
    var before = el('cal-title').textContent;
    el('cal-grid').dispatch('touchstart', {
      touches: [{ clientX: 200, clientY: 300 }, { clientX: 260, clientY: 300 }]
    });
    el('cal-grid').dispatch('touchend', {
      changedTouches: [{ clientX: 100, clientY: 305 }]
    });
    await flush(30);
    assert.strictEqual(el('cal-title').textContent, before);
  });

  await test('慢速拖动不换月（更可能是想选中文字）', async function () {
    var before = el('cal-title').textContent;
    await swipe(env, -90, 5, 760);
    assert.strictEqual(el('cal-title').textContent, before);
  });

  await test('滑动后紧跟的那次 click 不会误开记录弹层', async function () {
    await swipe(env, -80, 5);
    el('cal-grid').dispatch('click', {
      target: { closest: function () { return { getAttribute: function () { return '2026-03-05'; } }; } }
    });
    await flush(30);
    assert.strictEqual(el('sheet').hidden, true, '滑动后不该弹出弹层');
    await swipe(env, 80, 5);   // 滑回来，别影响后面的用例
  });

  await test('方向键在日历页换月', async function () {
    var before = el('cal-title').textContent;
    env._doc.dispatch('keydown', { key: 'ArrowRight' });
    assert.notStrictEqual(el('cal-title').textContent, before, '→ 应换月');
    env._doc.dispatch('keydown', { key: 'ArrowLeft' });
    assert.strictEqual(el('cal-title').textContent, before, '← 应回来');
  });

  await test('焦点在输入框里时方向键不换月', function () {
    var before = el('cal-title').textContent;
    env._doc.activeElement = { tagName: 'INPUT' };
    env._doc.dispatch('keydown', { key: 'ArrowRight' });
    env._doc.activeElement = null;
    assert.strictEqual(el('cal-title').textContent, before, '不该抢走光标移动');
  });

  await test('不在日历页时方向键不换月', function () {
    var before = el('cal-title').textContent;
    el('view-calendar').hidden = true;
    env._doc.dispatch('keydown', { key: 'ArrowRight' });
    el('view-calendar').hidden = false;
    assert.strictEqual(el('cal-title').textContent, before);
  });

  await test('清空数据后回到空态且不抛错', async function () {
    el('btn-clear').dispatch('click');
    await flush();
    assert.strictEqual(JSON.parse(env._store['nebula-rosette:periods']).length, 0);
    assert.strictEqual(el('status-headline').textContent, '开始记录吧');
  });

  section('运行时冒烟 —— 有历史数据');

  var P = require(path.join(ROOT, 'js/period.js'));
  var t = P.todayKey();
  var env2 = buildEnv({
    periods: [
      { start: P.addDays(t, -84), end: P.addDays(t, -80) },
      { start: P.addDays(t, -56), end: P.addDays(t, -52) },
      { start: P.addDays(t, -28), end: P.addDays(t, -24) }
    ],
    notes: { [t]: { flow: 'medium', pain: 3, text: '有点累' } }
  });
  var el2 = function (id) { return env2._els[id]; };
  await flush();

  await test('预测卡渲染出日期、区间与置信度', function () {
    var pb = el2('predict-body').innerHTML;
    assert.ok(pb.indexOf('置信度') > -1, '实际: ' + pb.slice(0, 200));
    assert.ok(pb.indexOf('可能区间') > -1);
    assert.ok(pb.indexOf('中位数 28 天') > -1, '实际: ' + pb.slice(0, 200));
  });

  await test('状态卡显示距下次天数', function () {
    assert.ok(/预计还有 \d+ 天|预计就是今天|已推迟/.test(el2('status-headline').textContent),
      '实际: ' + el2('status-headline').textContent);
  });

  await test('稳定性卡判为非常规律并显示三项指标', function () {
    var sb = el2('stability-body').innerHTML;
    assert.ok(sb.indexOf('非常规律') > -1, '实际: ' + sb.slice(0, 160));
    assert.ok(sb.indexOf('中位数(天)') > -1 && sb.indexOf('波动度') > -1);
  });

  await test('历史页概览、条形图、列表均渲染', function () {
    assert.ok(el2('history-summary').innerHTML.indexOf('记录次数') > -1);
    assert.ok(el2('history-chart').innerHTML.indexOf('28天') > -1,
      '实际: ' + el2('history-chart').innerHTML.slice(0, 200));
    assert.ok(el2('history-list').innerHTML.indexOf('28 天周期') > -1);
  });

  await test('有备注的日子在日历上显示标记点', function () {
    var h = el2('cal-grid').innerHTML;
    var cell = cellOf(h, t);
    assert.ok(cell, '未找到今天的格子');
    assert.ok(/class="dots"/.test(cell), '今天有备注但没渲染标记点: ' + cell);
    assert.ok(/有记录/.test(cell), 'aria-label 应说明有记录');
  });

  await test('没有备注的日子不显示标记点', function () {
    var h = el2('cal-grid').innerHTML;
    var other = P.addDays(t, P.parseKey(t).getDate() > 15 ? -5 : 5);
    var cell = cellOf(h, other);
    if (!cell) return; // 落到别的月份就跳过
    assert.ok(!/class="dots"/.test(cell), '无备注却有标记点: ' + cell);
  });

  await test('痛感 >= 3 时额外渲染一个标记点', function () {
    var cell = cellOf(el2('cal-grid').innerHTML, t);
    var dots = (cell.match(/class="dot"/g) || []).length;
    assert.strictEqual(dots, 2, '流量点 + 痛感点，实际 ' + dots);
  });

  await test('经期连续段两端带圆角类，中间不带', function () {
    // 上月有一段 5 天的经期
    el2('btn-prev-month').dispatch('click');
    var h = el2('cal-grid').innerHTML;
    var startKey = P.addDays(t, -28);
    var midKey = P.addDays(t, -26);
    var endKey = P.addDays(t, -24);
    var s = cellOf(h, startKey) || '', mid = cellOf(h, midKey) || '', e = cellOf(h, endKey) || '';
    if (!s || !mid || !e) { el2('btn-next-month').dispatch('click'); return; }
    assert.ok(/seg-start/.test(s), '段首应有 seg-start');
    assert.ok(!/seg-start|seg-end/.test(mid), '段中不应有圆角类: ' + mid);
    assert.ok(/seg-end/.test(e), '段尾应有 seg-end');
    assert.ok(/\bseg\b/.test(mid), '段中应有 seg');
    el2('btn-next-month').dispatch('click');
  });

  await test('环形进度已按当前周期天数更新', function () {
    var day = el2('ring-day').textContent;
    assert.ok(/^\d+$/.test(day), 'ring-day 应是数字，实际: ' + day);
    assert.ok(/\/ \d+ 天/.test(el2('ring-unit').textContent),
      '实际: ' + el2('ring-unit').textContent);
    var off = Number(el2('ring-bar').getAttribute('stroke-dashoffset'));
    var circ = 2 * Math.PI * 44;
    assert.ok(off >= 0 && off <= circ, 'dashoffset 越界: ' + off);
    assert.ok(off < circ, '有数据时进度环不应为空');
  });

  await test('小贴士带免责声明', function () {
    assert.ok(el2('tip-body').textContent.indexOf('仅供参考') > -1);
  });

  section('账号与同步');

  var SERVER = 'http://localhost:8000';

  /** 模拟后端：注册/登录/拉取/推送/改密码/AI。数据接口与真实后端一样做逐条合并。 */
  function serverResponder(remoteData) {
    var stored = remoteData || { periods: [], notes: {} };
    var noteTimes = {};
    // 模拟服务端保存的 AI 配置：只回遮掩后的 key，跟真实后端一致
    var aiCfg = { base_url: null, model: null, api_key_masked: '', has_key: false,
      updated_at: null, server_fallback: false };
    var profile = { username: 'alice', nickname: null };
    // 恢复码：存归一化后的串，模拟服务端「只认哈希」的匹配方式
    var recovery = [];
    var recoveryUsed = 0;
    var sessions = [
      { id: 'aaaaaaaaaaaa', device: 'Windows · Chrome', createdAt: '2026-08-30 10:00:00',
        lastSeen: '2026-08-30 10:00:00', expiresAt: '2027-01-01 00:00:00', current: true },
      { id: 'bbbbbbbbbbbb', device: 'iPhone · Safari', createdAt: '2026-08-20 10:00:00',
        lastSeen: '2026-08-25 10:00:00', expiresAt: '2027-01-01 00:00:00', current: false }
    ];

    /** 与 server/db.py merge_periods 同规则：按 start 并集，已标结束胜过未标 */
    function mergePeriods(incoming) {
      var byStart = {};
      stored.periods.forEach(function (p) { byStart[p.start] = p.end || null; });
      (incoming || []).forEach(function (p) {
        var cur = byStart[p.start];
        if (cur === undefined) byStart[p.start] = p.end || null;
        else if (p.end && (cur === null || p.end > cur)) byStart[p.start] = p.end;
      });
      stored.periods = Object.keys(byStart).sort().map(function (s) {
        return { start: s, end: byStart[s] };
      });
    }

    /** 与 merge_notes 同规则：新增直接写，已存在则要客户端时间戳更新才覆盖 */
    function mergeNotes(incoming, times) {
      Object.keys(incoming || {}).forEach(function (d) {
        var ct = (times || {})[d];
        if (!(d in stored.notes)) {
          stored.notes[d] = incoming[d];
          noteTimes[d] = ct || '2026-01-01 00:00:00';
        } else if (ct && ct > (noteTimes[d] || '')) {
          stored.notes[d] = incoming[d];
          noteTimes[d] = ct;
        }
      });
    }

    return function (url, opts) {
      var body = opts && opts.body ? JSON.parse(opts.body) : {};
      var method = (opts && opts.method) || 'GET';
      if (/\/api\/auth\/(register|login)$/.test(url)) {
        profile = { username: body.username, nickname: body.nickname || null };
        return { token: 'tok-123', expires_at: '2027-01-01 00:00:00',
          username: profile.username, nickname: profile.nickname };
      }
      if (/\/api\/auth\/me$/.test(url)) return profile;
      if (/\/api\/auth\/logout$/.test(url)) return { ok: true };
      if (/\/api\/auth\/change-password$/.test(url)) {
        if (body.old_password !== 'password123') {
          return { __status: 401, detail: '当前密码不对。' };
        }
        return { ok: true, logged_out_devices: body.logout_others === false ? 0 : 2 };
      }
      if (/\/api\/auth\/delete-account$/.test(url)) {
        if (body.password !== 'password123') {
          return { __status: 401, detail: '密码不对。' };
        }
        if (body.confirm_username !== profile.username) {
          return { __status: 400, detail: '确认用的用户名不匹配。' };
        }
        var stats = { periods: stored.periods.length,
          notes: Object.keys(stored.notes).length };
        stored = { periods: [], notes: {} };
        recovery = [];
        sessions = [];
        return { ok: true, deleted: stats };
      }
      if (/\/api\/auth\/profile$/.test(url)) {
        profile.nickname = body.nickname || null;
        return { username: profile.username, nickname: profile.nickname };
      }
      if (/\/api\/auth\/sessions\/[^/]+$/.test(url) && method === 'DELETE') {
        var sid = url.split('/').pop();
        var before = sessions.length;
        sessions = sessions.filter(function (s) { return s.id !== sid; });
        if (sessions.length === before) return { __status: 404, detail: '没有这个会话' };
        return { ok: true, revoked: 1 };
      }
      if (/\/api\/auth\/sessions$/.test(url)) return { sessions: sessions };
      if (/\/api\/auth\/recovery\/reset$/.test(url)) {
        var norm = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (body.username !== profile.username || recovery.indexOf(norm) === -1) {
          return { __status: 401, detail: '用户名或恢复码不对。' };
        }
        recovery = [];      // 用掉一个后其余全部作废
        recoveryUsed += 1;
        return { token: 'tok-reset', expires_at: '2027-01-01 00:00:00',
          username: profile.username, nickname: profile.nickname };
      }
      if (/\/api\/auth\/recovery$/.test(url)) {
        if (method === 'POST') {
          if (body.password !== 'password123') {
            return { __status: 401, detail: '密码不对。' };
          }
          recovery = ['ABCD-EFGH-JKMN', 'PQRS-TUVW-XYZ2', 'MNPQ-3456-789A']
            .map(function (c) { return c.replace(/-/g, ''); });
          recoveryUsed = 0;
          return { codes: ['ABCD-EFGH-JKMN', 'PQRS-TUVW-XYZ2', 'MNPQ-3456-789A'], count: 3 };
        }
        return { total: recovery.length + recoveryUsed,
          unused: recovery.length, used: recoveryUsed };
      }
      if (/\/api\/health$/.test(url)) {
        return { ok: true, model: 'qwen-turbo', ai_configured: true,
          registration_open: true, users: 1 };
      }
      if (/\/api\/ai-config$/.test(url)) {
        if (method === 'PUT') {
          aiCfg = {
            base_url: body.base_url || null,
            model: body.model || aiCfg.model,
            api_key_masked: body.api_key ? 'sk-…' + body.api_key.slice(-4) : aiCfg.api_key_masked,
            has_key: body.api_key ? true : aiCfg.has_key,
            updated_at: '2026-08-30 00:00:00',
            server_fallback: false
          };
        } else if (method === 'DELETE') {
          aiCfg = { base_url: null, model: null, api_key_masked: '', has_key: false,
            updated_at: null, server_fallback: false };
        }
        return aiCfg;
      }
      if (/\/api\/data\/replace$/.test(url)) {
        stored = { periods: body.periods || [], notes: body.notes || {} };
        noteTimes = {};
        return { ok: true, replaced: true, snapshot: stored };
      }
      if (/\/api\/data$/.test(url) && method === 'GET') {
        return { periods: stored.periods, notes: stored.notes, noteTimes: noteTimes };
      }
      if (/\/api\/data$/.test(url)) {
        (body.deletedPeriods || []).forEach(function (s) {
          stored.periods = stored.periods.filter(function (p) { return p.start !== s; });
        });
        (body.deletedNotes || []).forEach(function (d) {
          delete stored.notes[d];
          delete noteTimes[d];
        });
        mergePeriods(body.periods);
        mergeNotes(body.notes, body.noteTimes);
        return { ok: true, snapshot: stored, periods: stored.periods.length,
          notes: Object.keys(stored.notes).length };
      }
      if (/\/api\/chat$/.test(url)) return { answer: '这是服务端回复', source: 'server' };
      return {};
    };
  }

  var envA = buildEnv({}, serverResponder());
  var elA = function (id) { return envA._els[id]; };
  await flush();

  await test('未登录时顶栏显示「仅存本机」，账号区显示登录表单', function () {
    assert.ok(elA('mode-badge').textContent.indexOf('仅存本机') > -1,
      '实际: ' + elA('mode-badge').textContent);
    assert.strictEqual(elA('acct-logged-out').hidden, false);
    assert.strictEqual(elA('acct-logged-in').hidden, true);
  });

  await test('未填服务器地址时点登录只给提示，不发请求', async function () {
    elA('btn-login').dispatch('click');
    await flush();
    assert.ok(elA('acct-msg').textContent.indexOf('服务器地址') > -1);
    assert.strictEqual(envA._fetchCalls.length, 0);
  });

  await test('缺用户名或密码时不发请求', async function () {
    elA('acct-server-url').value = SERVER;
    elA('btn-login').dispatch('click');
    await flush();
    assert.ok(elA('acct-msg').textContent.indexOf('用户名和密码') > -1);
    assert.strictEqual(envA._fetchCalls.length, 0);
  });

  await test('检测服务器会报告 AI 是否已配置', async function () {
    elA('btn-check-server').dispatch('click');
    await flush();
    assert.strictEqual(envA._fetchCalls[0].url, SERVER + '/api/health');
    assert.ok(elA('acct-msg').textContent.indexOf('AI 已配置') > -1,
      '实际: ' + elA('acct-msg').textContent);
  });

  await test('注册会 POST 到 /api/auth/register 并带昵称', async function () {
    elA('acct-username').value = 'alice';
    elA('acct-password').value = 'password123';
    elA('acct-nickname').value = '小爱';
    elA('btn-register').dispatch('click');
    await flush(120);
    var call = envA._fetchCalls.filter(function (c) { return /register/.test(c.url); })[0];
    assert.ok(call, '未发出注册请求');
    var body = JSON.parse(call.body);
    assert.strictEqual(body.username, 'alice');
    assert.strictEqual(body.password, 'password123');
    assert.strictEqual(body.nickname, '小爱');
  });

  await test('登录成功后顶栏切换为已登录，token 落本地', function () {
    assert.ok(elA('mode-badge').textContent.indexOf('已登录') > -1,
      '实际: ' + elA('mode-badge').textContent);
    assert.strictEqual(elA('acct-logged-in').hidden, false);
    assert.strictEqual(elA('acct-logged-out').hidden, true);
    assert.strictEqual(elA('acct-name').textContent, '小爱');
    var saved = JSON.parse(envA._store['nebula-rosette:settings']);
    assert.strictEqual(saved.token, 'tok-123');
    assert.strictEqual(saved.username, 'alice');
  });

  await test('登录后密码框被清空（不留在 DOM 里）', function () {
    assert.strictEqual(elA('acct-password').value, '');
  });

  await test('登录后的请求都带 Bearer token', function () {
    var authed = envA._fetchCalls.filter(function (c) { return /\/api\/data/.test(c.url); });
    assert.ok(authed.length > 0, '登录后应拉取数据');
    assert.strictEqual(authed[0].headers.Authorization, 'Bearer tok-123');
  });

  await test('账号为空而本机有数据时，上传本机数据而不是被清空', async function () {
    var envB = buildEnv({
      periods: [{ start: P.addDays(t, -28), end: P.addDays(t, -24) },
                { start: P.addDays(t, -1) }],
      settings: { serverUrl: SERVER, token: 'tok-x', username: 'bob' }
    }, serverResponder({ periods: [], notes: {} }));
    await flush(150);
    var puts = envB._fetchCalls.filter(function (c) { return c.method === 'PUT'; });
    assert.ok(puts.length > 0, '应把本机数据上传');
    assert.strictEqual(JSON.parse(puts[0].body).periods.length, 2);
    assert.strictEqual(envB._els['status-headline'].textContent.indexOf('开始记录吧'), -1,
      '本机数据不应被清空');
  });

  await test('两边记录合并，服务端独有的会拉到本地', async function () {
    var remote = {
      periods: [{ start: '2026-05-01', end: '2026-05-05' },
                { start: '2026-05-29', end: '2026-06-02' },
                { start: '2026-06-26', end: '2026-06-30' }],
      notes: { '2026-05-02': { flow: 'medium', pain: 2, text: '记录' } }
    };
    var envC = buildEnv({
      periods: [{ start: '2026-06-26', end: '2026-06-30' }],
      settings: { serverUrl: SERVER, token: 'tok-y', username: 'carol' }
    }, serverResponder(remote));
    await flush(150);
    var saved = await envC.Storage.getPeriods();
    assert.strictEqual(saved.length, 3, '应拿到合并后的 3 条');
    assert.ok(envC._els['sync-status'].textContent.indexOf('已同步') > -1,
      '实际: ' + envC._els['sync-status'].textContent);
  });

  await test('本机独有的记录不会被服务端抹掉，而是并进去', async function () {
    var envD2 = buildEnv({
      periods: [{ start: '2026-01-01', end: '2026-01-05' },
                { start: '2026-01-29', end: '2026-02-02' },
                { start: '2026-02-26', end: '2026-03-02' }],
      settings: { serverUrl: SERVER, token: 'tok-z', username: 'dana' }
    }, serverResponder({ periods: [{ start: '2026-04-01', end: '2026-04-05' }], notes: {} }));
    await flush(150);
    var saved = await envD2.Storage.getPeriods();
    // 本机 3 条 + 服务端独有 1 条 = 4，任何一边都没被覆盖
    assert.strictEqual(saved.length, 4, '应为并集，实际 ' + saved.length);
    var puts = envD2._fetchCalls.filter(function (c) { return c.method === 'PUT'; });
    assert.ok(puts.length > 0, '应把本机数据上传');
  });

  await test('记录改动后会自动推送到服务端（带防抖）', async function () {
    var envE = buildEnv({
      settings: { serverUrl: SERVER, token: 'tok-p', username: 'eve' }
    }, serverResponder());
    await flush(150);
    var before = envE._fetchCalls.filter(function (c) { return c.method === 'PUT'; }).length;
    envE._els['btn-quick'].dispatch('click');
    await flush(1500);
    var after = envE._fetchCalls.filter(function (c) { return c.method === 'PUT'; }).length;
    assert.ok(after > before, '改动后应推送');
    var last = envE._fetchCalls.filter(function (c) { return c.method === 'PUT'; }).pop();
    assert.strictEqual(JSON.parse(last.body).periods.length, 1);
  });

  await test('服务端不可达时本地记录照样成功，只提示同步失败', async function () {
    var envF2 = buildEnv({
      settings: { serverUrl: SERVER, token: 'tok-f', username: 'fay' }
    }, function (url) {
      if (/\/api\/auth\/me$/.test(url)) return { username: 'fay', nickname: null };
      if (/\/api\/data$/.test(url)) return { __status: 500, detail: '服务器炸了' };
      return {};
    });
    await flush(150);
    assert.ok(envF2._els['sync-status'].textContent.indexOf('同步失败') > -1,
      '实际: ' + envF2._els['sync-status'].textContent);
    envF2._els['btn-quick'].dispatch('click');
    await flush(120);
    assert.strictEqual((await envF2.Storage.getPeriods()).length, 1,
      '网络失败不应影响本地写入');
    assert.ok(/经期第 1 天/.test(envF2._els['status-headline'].textContent));
  });

  await test('token 过期（401）时清空本地 token 并提示重新登录', async function () {
    var envG = buildEnv({
      settings: { serverUrl: SERVER, token: 'expired', username: 'gina' }
    }, function (url) {
      if (/\/api\/auth\/me$/.test(url)) return { __status: 401, detail: '登录已过期' };
      return {};
    });
    await flush(200);
    var saved = JSON.parse(envG._store['nebula-rosette:settings']);
    assert.strictEqual(saved.token, '', 'token 应被清空');
    assert.ok(envG._els['sync-status'].textContent.indexOf('重新登录') > -1,
      '实际: ' + envG._els['sync-status'].textContent);
  });

  await test('登出会清 token 但保留本机数据', async function () {
    var envH = buildEnv({
      periods: [{ start: P.addDays(t, -3) }],
      settings: { serverUrl: SERVER, token: 'tok-h', username: 'hana' }
    }, serverResponder({ periods: [{ start: P.addDays(t, -3) }], notes: {} }));
    await flush(150);
    envH._els['btn-logout'].dispatch('click');
    await flush(120);
    var saved = JSON.parse(envH._store['nebula-rosette:settings']);
    assert.strictEqual(saved.token, '');
    assert.strictEqual(JSON.parse(envH._store['nebula-rosette:periods']).length, 1,
      '登出不应删除本机数据');
    assert.strictEqual(envH._els['acct-logged-out'].hidden, false);
    assert.ok(envH._els['mode-badge'].textContent.indexOf('仅存本机') > -1);
  });

  section('运行时冒烟 —— AI 服务端模式');

  var env3 = buildEnv({
    periods: [{ start: P.addDays(t, -28), end: P.addDays(t, -24) }, { start: P.addDays(t, -1) }],
    settings: { aiEnabled: true, aiMode: 'server', serverUrl: SERVER, token: 'tok-ai', username: 'ivy' }
  }, serverResponder({ periods: [{ start: P.addDays(t, -28), end: P.addDays(t, -24) },
    { start: P.addDays(t, -1) }], notes: {} }));
  var el3 = function (id) { return env3._els[id]; };
  await flush(150);

  await test('已登录 + 服务端模式：对话面板可用', function () {
    env3._els.__gotos.filter(function (e) { return e.getAttribute('data-goto') === 'ai'; })[0].dispatch('click');
    assert.strictEqual(el3('ai-panel').hidden, false);
    assert.strictEqual(el3('ai-disabled').hidden, true);
    assert.ok(el3('ai-quick').innerHTML.indexOf('痛经') > -1);
    assert.ok(el3('ai-log').innerHTML.indexOf('不做诊断') > -1, '开场白应声明不做诊断');
  });

  await test('提问会 POST 到 /api/chat 并带 token，只含摘要字段', async function () {
    el3('ai-share-cycle').checked = true;
    el3('ai-input').value = '痛经怎么缓解';
    el3('ai-form').dispatch('submit');
    await flush(120);
    var call = env3._fetchCalls.filter(function (c) { return /\/api\/chat$/.test(c.url); })[0];
    assert.ok(call, '未发出 AI 请求');
    assert.strictEqual(call.url, SERVER + '/api/chat');
    assert.strictEqual(call.headers.Authorization, 'Bearer tok-ai');
    var body = JSON.parse(call.body);
    assert.strictEqual(body.question, '痛经怎么缓解');
    assert.deepStrictEqual(Object.keys(body).sort(), ['cycle', 'question']);
    assert.deepStrictEqual(Object.keys(body.cycle).sort(),
      ['cv', 'dayOfCycle', 'daysUntilNext', 'medianCycleLength', 'phase', 'recordCount', 'stability']);
    assert.ok(!JSON.stringify(body).match(/\d{4}-\d{2}-\d{2}/), '不应上报任何具体日期');
  });

  await test('服务端回复渲染到对话区', async function () {
    await flush();
    assert.ok(el3('ai-log').innerHTML.indexOf('这是服务端回复') > -1,
      '实际: ' + el3('ai-log').innerHTML.slice(-200));
    assert.ok(el3('ai-log').innerHTML.indexOf('痛经怎么缓解') > -1);
  });

  await test('服务端默认不附带摘要且不发送聊天历史', async function () {
    assert.strictEqual(el3('ai-share-cycle').checked, false);
    el3('ai-input').value = '经期能运动吗';
    el3('ai-form').dispatch('submit');
    await flush(120);
    var calls = env3._fetchCalls.filter(function (c) { return /\/api\/chat$/.test(c.url); });
    var body = JSON.parse(calls[calls.length - 1].body);
    assert.strictEqual(body.cycle, null);
    assert.deepStrictEqual(Object.keys(body).sort(), ['cycle', 'question']);
  });

  await test('服务端模式未登录时不可用，并说明原因', async function () {
    var envI = buildEnv({ settings: { aiEnabled: true, aiMode: 'server' } }, serverResponder());
    await flush();
    envI._els.__gotos.filter(function (e) { return e.getAttribute('data-goto') === 'ai'; })[0].dispatch('click');
    assert.strictEqual(envI._els['ai-panel'].hidden, true);
    assert.ok(envI._els['ai-reason'].textContent.indexOf('登录') > -1,
      '实际: ' + envI._els['ai-reason'].textContent);
    envI._els['ai-input'].value = '测试';
    envI._els['ai-form'].dispatch('submit');
    await flush();
    assert.strictEqual(envI._fetchCalls.length, 0, '未登录不应发 AI 请求');
  });

  section('AI 直连模式');

  var envD = buildEnv({
    periods: [{ start: P.addDays(t, -28), end: P.addDays(t, -24) }, { start: P.addDays(t, -1) }],
    settings: {
      aiEnabled: true, aiMode: 'direct',
      baseUrl: 'https://api.deepseek.com/v1/', model: 'deepseek-chat', apiKey: 'sk-test-direct'
    }
  });
  var elD = function (id) { return envD._els[id]; };
  await flush();

  await test('直连模式配置完整时对话面板可用', function () {
    envD._els.__gotos.filter(function (e) { return e.getAttribute('data-goto') === 'ai'; })[0].dispatch('click');
    assert.strictEqual(elD('ai-panel').hidden, false);
    assert.strictEqual(elD('ai-disabled').hidden, true);
  });

  await test('直连模式设置页显示直连表单、隐藏服务端说明', function () {
    assert.strictEqual(elD('cfg-direct').hidden, false);
    assert.strictEqual(elD('cfg-server').hidden, true);
    assert.strictEqual(elD('set-base-url').value, 'https://api.deepseek.com/v1/');
    assert.strictEqual(elD('set-model').value, 'deepseek-chat');
  });

  await test('直连请求打到 {baseUrl}/chat/completions 且 baseUrl 末尾斜杠被规整', async function () {
    elD('ai-input').value = '经期能运动吗';
    elD('ai-form').dispatch('submit');
    await flush();
    assert.strictEqual(envD._fetchCalls.length, 1);
    assert.strictEqual(envD._fetchCalls[0].url, 'https://api.deepseek.com/v1/chat/completions');
  });

  await test('直连请求带 Bearer 认证头与正确模型名', function () {
    var call = envD._fetchCalls[0];
    assert.strictEqual(call.headers.Authorization, 'Bearer sk-test-direct');
    var body = JSON.parse(call.body);
    assert.strictEqual(body.model, 'deepseek-chat');
    assert.strictEqual(body.messages.length, 2);
    assert.strictEqual(body.messages[0].role, 'system');
    assert.strictEqual(body.messages[1].content, '经期能运动吗');
  });

  await test('直连的 system prompt 含全部安全约束', function () {
    var sys = JSON.parse(envD._fetchCalls[0].body).messages[0].content;
    ['诊断疾病', '推荐具体药物', '避孕或受孕', '安全期', '仅供参考'].forEach(function (kw) {
      assert.ok(sys.indexOf(kw) > -1, '缺少约束: ' + kw);
    });
  });

  await test('直连默认不发送周期摘要', function () {
    var sys = JSON.parse(envD._fetchCalls[0].body).messages[0].content;
    assert.ok(sys.indexOf('未提供周期摘要') > -1);
    assert.ok(sys.indexOf('周期第') === -1);
  });

  await test('直连主动勾选才发送摘要且每次复位', async function () {
    elD('ai-share-cycle').checked = true;
    elD('ai-input').value = '解释我的周期';
    elD('ai-form').dispatch('submit');
    await flush();
    var sys = JSON.parse(envD._fetchCalls[1].body).messages[0].content;
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(sys), 'prompt 不应含具体日期');
    assert.ok(sys.indexOf('周期第') > -1, '应含周期天数摘要');
    assert.ok(sys.indexOf('次记录') > -1);
    assert.strictEqual(elD('ai-share-cycle').checked, false);
  });

  await test('直连缺少 key 时不发请求、面板保持未开启', async function () {
    var envN = buildEnv({
      periods: [{ start: P.addDays(t, -28), end: P.addDays(t, -24) }],
      settings: { aiEnabled: true, aiMode: 'direct', baseUrl: 'https://x.example.com/v1', model: 'm' }
    });
    await flush();
    envN._els.__gotos.filter(function (e) { return e.getAttribute('data-goto') === 'ai'; })[0].dispatch('click');
    assert.strictEqual(envN._els['ai-panel'].hidden, true);
    assert.strictEqual(envN._els['ai-disabled'].hidden, false);
    envN._els['ai-input'].value = '测试';
    envN._els['ai-form'].dispatch('submit');
    await flush();
    assert.strictEqual(envN._fetchCalls.length, 0, '配置不全不应发请求');
  });

  await test('切换连接方式会持久化并切换表单', async function () {
    var envM = buildEnv({ settings: { aiEnabled: true, aiMode: 'server' } }, serverResponder());
    await flush();
    assert.strictEqual(envM._els['cfg-direct'].hidden, true);
    envM._els['mode-direct'].dispatch('click');
    await flush();
    assert.strictEqual(envM._els['cfg-direct'].hidden, false);
    assert.strictEqual(envM._els['cfg-server'].hidden, true);
    var saved = JSON.parse(envM._store['nebula-rosette:settings']);
    assert.strictEqual(saved.aiMode, 'direct');
  });

  await test('导出的备份不含 apiKey', async function () {
    var data = await envD.Storage.exportAll();
    var json = JSON.stringify(data);
    assert.ok(json.indexOf('sk-test-direct') === -1, '备份泄露了 key');
    assert.ok(json.indexOf('apiKey') === -1);
    assert.ok(json.indexOf('baseUrl') === -1);
  });

  await test('直连模式对模型回复同样做安全过滤', async function () {
    var envF = buildEnv({
      periods: [{ start: P.addDays(t, -28), end: P.addDays(t, -24) }],
      settings: { aiEnabled: true, aiMode: 'direct', baseUrl: 'https://x.example.com/v1', model: 'm', apiKey: 'k' }
    });
    // 让 fetch 返回一个越界回答
    envF.fetch = function () {
      return Promise.resolve({
        ok: true,
        json: function () {
          return Promise.resolve({ choices: [{ message: { content: '建议吃布洛芬止痛。' } }] });
        }
      });
    };
    await flush();
    envF._els.__gotos.filter(function (e) { return e.getAttribute('data-goto') === 'ai'; })[0].dispatch('click');
    envF._els['ai-input'].value = '痛经吃什么';
    envF._els['ai-form'].dispatch('submit');
    await flush(120);
    var log = envF._els['ai-log'].innerHTML;
    assert.ok(log.indexOf('布洛芬') === -1, '药名应被拦截: ' + log.slice(-200));
    assert.ok(log.indexOf('咨询医生') > -1);
  });

  section('账号自存的 API Key');

  /** 建一个已登录、server 模式的环境 */
  async function loggedInEnv() {
    var env = buildEnv({ settings: { aiEnabled: true, aiMode: 'server' } }, serverResponder());
    await flush();
    env._els['acct-server-url'].value = SERVER;
    env._els['acct-username'].value = 'alice';
    env._els['acct-password'].value = 'password123';
    env._els['btn-login'].dispatch('click');
    await flush(150);
    return env;
  }

  var envK = await loggedInEnv();

  await test('登录后设置页出现「这个账号的 API Key」区块', function () {
    assert.strictEqual(envK._els['acct-ai-box'].hidden, false);
  });

  await test('未保存 Key 时状态提示可以填一个', function () {
    var txt = envK._els['acct-ai-status'].textContent;
    assert.ok(txt.indexOf('还没有可用的 Key') > -1, '实际: ' + txt);
    assert.strictEqual(envK._els['btn-del-ai-config'].hidden, true);
  });

  await test('第一次保存缺 Key 时不发请求', async function () {
    var before = envK._fetchCalls.length;
    envK._els['srv-model'].value = 'deepseek-chat';
    envK._els['btn-save-ai-config'].dispatch('click');
    await flush();
    assert.ok(envK._els['acct-ai-msg'].textContent.indexOf('必须填 API Key') > -1,
      '实际: ' + envK._els['acct-ai-msg'].textContent);
    assert.strictEqual(envK._fetchCalls.length, before, '不该发请求');
  });

  await test('缺模型名时不发请求', async function () {
    var before = envK._fetchCalls.length;
    envK._els['srv-model'].value = '';
    envK._els['srv-api-key'].value = 'sk-account-1234';
    envK._els['btn-save-ai-config'].dispatch('click');
    await flush();
    assert.ok(envK._els['acct-ai-msg'].textContent.indexOf('模型名') > -1,
      '实际: ' + envK._els['acct-ai-msg'].textContent);
    assert.strictEqual(envK._fetchCalls.length, before, '不该发请求');
  });

  await test('保存 Key 会 PUT 到 /api/ai-config 且带 Bearer token', async function () {
    envK._els['srv-base-url'].value = 'https://api.deepseek.com/v1';
    envK._els['srv-model'].value = 'deepseek-chat';
    envK._els['srv-api-key'].value = 'sk-account-1234';
    envK._els['btn-save-ai-config'].dispatch('click');
    await flush(150);
    var call = envK._fetchCalls.filter(function (c) {
      return /ai-config/.test(c.url) && c.method === 'PUT';
    }).pop();
    assert.ok(call, '未发出 PUT 请求');
    var body = JSON.parse(call.body);
    assert.strictEqual(body.api_key, 'sk-account-1234');
    assert.strictEqual(body.model, 'deepseek-chat');
    assert.strictEqual(body.base_url, 'https://api.deepseek.com/v1');
    assert.strictEqual(call.headers.Authorization, 'Bearer tok-123');
  });

  await test('保存后输入框清空，只显示遮掩后的 Key', function () {
    assert.strictEqual(envK._els['srv-api-key'].value, '', 'Key 不该留在输入框');
    var txt = envK._els['acct-ai-status'].textContent;
    assert.ok(txt.indexOf('sk-…1234') > -1, '实际: ' + txt);
    assert.ok(txt.indexOf('sk-account-1234') === -1, '不该显示完整 Key');
    assert.strictEqual(envK._els['btn-del-ai-config'].hidden, false);
  });

  await test('账号 Key 不写进本地设置，也不进导出备份', async function () {
    var saved = envK._store['nebula-rosette:settings'];
    assert.ok(saved.indexOf('sk-account-1234') === -1, '本地设置泄露了账号 Key');
    var json = JSON.stringify(await envK.Storage.exportAll());
    assert.ok(json.indexOf('sk-account-1234') === -1, '备份泄露了账号 Key');
  });

  await test('已存 Key 后可以只改模型名，不重传 Key', async function () {
    envK._els['srv-model'].value = 'deepseek-reasoner';
    envK._els['srv-api-key'].value = '';
    envK._els['btn-save-ai-config'].dispatch('click');
    await flush(150);
    var call = envK._fetchCalls.filter(function (c) {
      return /ai-config/.test(c.url) && c.method === 'PUT';
    }).pop();
    var body = JSON.parse(call.body);
    assert.strictEqual(body.model, 'deepseek-reasoner');
    assert.ok(!('api_key' in body), '不该重传 Key');
    assert.ok(envK._els['acct-ai-status'].textContent.indexOf('sk-…1234') > -1, 'Key 应保留');
  });

  await test('删除会 DELETE 到 /api/ai-config 并清空状态', async function () {
    envK._els['btn-del-ai-config'].dispatch('click');
    await flush(150);
    var call = envK._fetchCalls.filter(function (c) {
      return /ai-config/.test(c.url) && c.method === 'DELETE';
    }).pop();
    assert.ok(call, '未发出 DELETE 请求');
    assert.strictEqual(envK._els['srv-model'].value, '');
    assert.strictEqual(envK._els['btn-del-ai-config'].hidden, true);
  });

  await test('未登录时不显示账号 Key 区块，也不请求配置', async function () {
    var envO = buildEnv({ settings: { aiEnabled: true, aiMode: 'server' } }, serverResponder());
    await flush();
    assert.strictEqual(envO._els['acct-ai-box'].hidden, true);
    var calls = envO._fetchCalls.filter(function (c) { return /ai-config/.test(c.url); });
    assert.strictEqual(calls.length, 0, '未登录不该请求 ai-config');
  });

  // ---------- 主题 ----------
  section('深色模式');

  await test('默认跟随系统：系统浅色时不加 dark', async function () {
    var e = buildEnv({}, serverResponder(), { systemDark: false });
    await flush();
    assert.strictEqual(e._els.__body.classList.contains('dark'), false);
    assert.strictEqual(e._els['theme-auto'].getAttribute('aria-pressed'), 'true');
  });

  await test('默认跟随系统：系统深色时自动加 dark', async function () {
    var e = buildEnv({}, serverResponder(), { systemDark: true });
    await flush();
    assert.strictEqual(e._els.__body.classList.contains('dark'), true);
  });

  await test('手动选深色后即便系统是浅色也生效，并写入设置', async function () {
    var e = buildEnv({}, serverResponder(), { systemDark: false });
    await flush();
    e._els['theme-dark'].dispatch('click');
    await flush();
    assert.strictEqual(e._els.__body.classList.contains('dark'), true);
    assert.strictEqual(JSON.parse(e._store['nebula-rosette:settings']).themeMode, 'dark');
  });

  await test('手动选浅色后即便系统是深色也保持浅色', async function () {
    var e = buildEnv({}, serverResponder(), { systemDark: true });
    await flush();
    e._els['theme-light'].dispatch('click');
    await flush();
    assert.strictEqual(e._els.__body.classList.contains('dark'), false);
  });

  await test('themeMode 存的是意图而不是当前颜色', async function () {
    // 存 dark/light 会让「跟随系统」永久失效，所以 auto 必须原样存 auto
    var e = buildEnv({}, serverResponder(), { systemDark: true });
    await flush();
    e._els['theme-auto'].dispatch('click');
    await flush();
    assert.strictEqual(JSON.parse(e._store['nebula-rosette:settings']).themeMode, 'auto');
  });

  await test('跟随系统时，系统切到深色会实时生效', async function () {
    var e = buildEnv({}, serverResponder(), { systemDark: false });
    await flush();
    assert.strictEqual(e._els.__body.classList.contains('dark'), false);
    e._fireSystemThemeChange(true);
    assert.strictEqual(e._els.__body.classList.contains('dark'), true);
  });

  await test('已手动指定浅色时，系统切换不该改动界面', async function () {
    var e = buildEnv({ settings: { themeMode: 'light' } }, serverResponder(), { systemDark: false });
    await flush();
    e._fireSystemThemeChange(true);
    assert.strictEqual(e._els.__body.classList.contains('dark'), false);
  });

  await test('深色时同步更新 theme-color，避免顶部留亮边', async function () {
    var e = buildEnv({ settings: { themeMode: 'dark' } }, serverResponder(), { systemDark: false });
    await flush();
    assert.strictEqual(e._els['meta-theme-color'].getAttribute('content'), '#14101c');
    e._els['theme-light'].dispatch('click');
    await flush();
    assert.strictEqual(e._els['meta-theme-color'].getAttribute('content'), '#fff5f9');
  });

  await test('没有 matchMedia 的旧浏览器不报错，退回浅色', async function () {
    var e = buildEnv({}, serverResponder());   // 不提供 matchMedia
    await flush();
    assert.strictEqual(e._els.__body.classList.contains('dark'), false);
  });

  // ---------- Service Worker ----------
  section('Service Worker 注册');

  await test('http 下注册 sw.js', async function () {
    var e = buildEnv({}, serverResponder(), { systemDark: false });
    await flush();
    assert.deepStrictEqual(e._swRegistrations, ['sw.js']);
  });

  await test('file:// 下不注册（浏览器不允许，注册只会抛错）', async function () {
    var e = buildEnv({}, serverResponder(), { protocol: 'file:' });
    await flush();
    assert.strictEqual(e._swRegistrations.length, 0);
  });

  await test('不支持 serviceWorker 的浏览器不报错', async function () {
    var e = buildEnv({}, serverResponder(), { noServiceWorker: true });
    await flush();
    assert.ok(e._els['cal-grid'].innerHTML.length > 0, '页面仍应正常渲染');
  });

  await test('sw.js 不缓存 /api，避免经期数据落到磁盘缓存', function () {
    var sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
    assert.ok(/pathname\.startsWith\('\/api\/'\)/.test(sw), '缺少 /api 直连规则');
    assert.ok(sw.indexOf('push') === -1 || !/addEventListener\(['"]push['"]/.test(sw),
      '不应注册 push 事件');
  });

  await test('manifest 里的图标文件真实存在', function () {
    var mf = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
    mf.icons.forEach(function (i) {
      assert.ok(fs.existsSync(path.join(ROOT, i.src)), '缺少图标 ' + i.src);
    });
    assert.ok(mf.icons.some(function (i) { return i.purpose === 'maskable'; }),
      '缺少 maskable 图标，安卓上会被套白底方框');
  });

  // ---------- 昵称与改密码 ----------
  section('昵称与改密码');

  var envP = buildEnv({
    settings: { serverUrl: SERVER, token: 'tok-pw', username: 'alice', nickname: '小爱' }
  }, serverResponder(), { systemDark: false });
  await flush(150);

  await test('登录态下回填昵称', function () {
    assert.strictEqual(envP._els['prof-nickname'].value, '小爱');
  });

  await test('改昵称会 PUT /api/auth/profile 并更新顶部显示', async function () {
    envP._els['prof-nickname'].value = '阿爱';
    envP._els['btn-save-profile'].dispatch('click');
    await flush(120);
    var call = envP._fetchCalls.filter(function (c) {
      return /auth\/profile$/.test(c.url) && c.method === 'PUT';
    }).pop();
    assert.ok(call, '未发出 profile 请求');
    assert.strictEqual(JSON.parse(call.body).nickname, '阿爱');
    assert.strictEqual(envP._els['acct-name'].textContent, '阿爱');
  });

  await test('改密码表单默认收起，点一下展开', function () {
    assert.strictEqual(envP._els['pwd-form'].hidden, true);
    envP._els['btn-toggle-pwd'].dispatch('click');
    assert.strictEqual(envP._els['pwd-form'].hidden, false);
    assert.strictEqual(envP._els['btn-toggle-pwd'].getAttribute('aria-expanded'), 'true');
  });

  await test('两次新密码不一致时本地拦下，不发请求', async function () {
    var before = envP._fetchCalls.length;
    envP._els['pwd-old'].value = 'password123';
    envP._els['pwd-new'].value = 'newpassword1';
    envP._els['pwd-new2'].value = 'newpassword2';
    envP._els['btn-change-pwd'].dispatch('click');
    await flush(80);
    assert.ok(envP._els['pwd-msg'].textContent.indexOf('不一样') > -1,
      '实际: ' + envP._els['pwd-msg'].textContent);
    assert.strictEqual(envP._fetchCalls.length, before, '不该发请求');
  });

  await test('新密码少于 8 位时本地拦下', async function () {
    var before = envP._fetchCalls.length;
    envP._els['pwd-new'].value = 'short1';
    envP._els['pwd-new2'].value = 'short1';
    envP._els['btn-change-pwd'].dispatch('click');
    await flush(80);
    assert.ok(envP._els['pwd-msg'].textContent.indexOf('8 位') > -1);
    assert.strictEqual(envP._fetchCalls.length, before);
  });

  await test('新旧密码相同时本地拦下', async function () {
    var before = envP._fetchCalls.length;
    envP._els['pwd-new'].value = 'password123';
    envP._els['pwd-new2'].value = 'password123';
    envP._els['btn-change-pwd'].dispatch('click');
    await flush(80);
    assert.ok(envP._els['pwd-msg'].textContent.indexOf('相同') > -1);
    assert.strictEqual(envP._fetchCalls.length, before);
  });

  await test('改密码成功后清空输入框并报告登出了几台设备', async function () {
    envP._els['pwd-old'].value = 'password123';
    envP._els['pwd-new'].value = 'brandnewpass1';
    envP._els['pwd-new2'].value = 'brandnewpass1';
    envP._els['pwd-logout-others'].checked = true;
    envP._els['btn-change-pwd'].dispatch('click');
    await flush(150);
    var call = envP._fetchCalls.filter(function (c) {
      return /change-password$/.test(c.url);
    }).pop();
    var body = JSON.parse(call.body);
    assert.strictEqual(body.old_password, 'password123');
    assert.strictEqual(body.new_password, 'brandnewpass1');
    assert.strictEqual(body.logout_others, true);
    assert.strictEqual(envP._els['pwd-old'].value, '', '旧密码应被清空');
    assert.strictEqual(envP._els['pwd-new'].value, '');
    assert.ok(envP._els['pwd-msg'].textContent.indexOf('2 台设备已登出') > -1,
      '实际: ' + envP._els['pwd-msg'].textContent);
  });

  await test('旧密码错误时显示服务端原因，不清空输入', async function () {
    envP._els['pwd-old'].value = 'wrongpassword';
    envP._els['pwd-new'].value = 'anotherpass12';
    envP._els['pwd-new2'].value = 'anotherpass12';
    envP._els['btn-change-pwd'].dispatch('click');
    await flush(150);
    assert.ok(envP._els['pwd-msg'].textContent.indexOf('当前密码不对') > -1,
      '实际: ' + envP._els['pwd-msg'].textContent);
    assert.strictEqual(envP._els['pwd-old'].value, 'wrongpassword', '失败不该清空');
  });

  await test('输错旧密码不会把登录态一起清掉（401 语义区分）', function () {
    // 这些接口的 401 是「你刚填的凭据不对」，不是「登录过期」。
    // 若一律当过期处理，输错一次密码就会被莫名登出。
    assert.strictEqual(envP._els['acct-logged-in'].hidden, false, '应仍处于登录态');
  });

  await test('登出后收起表单并清掉残留输入', async function () {
    envP._els['btn-logout'].dispatch('click');
    await flush(150);
    assert.strictEqual(envP._els['pwd-form'].hidden, true, '应收起');
    assert.strictEqual(envP._els['pwd-old'].value, '', '不该留下旧密码');
    assert.strictEqual(envP._els['prof-nickname'].value, '');
  });

  await test('未登录时不提供改密码入口的有效操作', async function () {
    var e = buildEnv({}, serverResponder(), { systemDark: false });
    await flush();
    assert.strictEqual(e._els['acct-logged-in'].hidden, true, '账号区应处于未登录态');
  });

  // ---------- 已登录设备 ----------
  section('已登录设备');

  var envS = buildEnv({
    settings: { serverUrl: SERVER, token: 'tok-dev', username: 'alice' }
  }, serverResponder(), { systemDark: false });
  await flush(200);

  await test('登录后自动列出已登录设备', function () {
    var h = envS._els['session-list'].innerHTML;
    assert.ok(h.indexOf('Windows · Chrome') > -1, '实际: ' + h);
    assert.ok(h.indexOf('iPhone · Safari') > -1);
    assert.ok(envS._els['session-msg'].textContent.indexOf('2 台设备') > -1,
      '实际: ' + envS._els['session-msg'].textContent);
  });

  await test('当前设备标出来且不给「登出」按钮', function () {
    var h = envS._els['session-list'].innerHTML;
    assert.ok(h.indexOf('当前设备') > -1, '应标出当前设备');
    // 只有非当前设备才有 data-revoke，避免用它把自己踢下线
    var ids = [];
    h.replace(/data-revoke="([^"]+)"/g, function (_, v) { ids.push(v); return _; });
    assert.deepStrictEqual(ids, ['bbbbbbbbbbbb'], '实际: ' + ids.join(','));
  });

  await test('点其他设备的「登出」会 DELETE 掉它并刷新列表', async function () {
    envS._els['session-list'].dispatch('click', {
      target: { closest: function () { return { getAttribute: function () { return 'bbbbbbbbbbbb'; } }; } }
    });
    await flush(150);
    var call = envS._fetchCalls.filter(function (c) {
      return /auth\/sessions\//.test(c.url) && c.method === 'DELETE';
    }).pop();
    assert.ok(call, '未发出 DELETE');
    assert.ok(envS._els['session-list'].innerHTML.indexOf('iPhone') === -1,
      '列表应已刷新掉那台设备');
  });

  // ---------- 恢复码 ----------
  section('恢复码');

  var envR = buildEnv({
    settings: { serverUrl: SERVER, token: 'tok-rec', username: 'alice' }
  }, serverResponder(), { systemDark: false });
  await flush(200);

  await test('登录后显示恢复码状态；未生成时明确提示', function () {
    assert.ok(envR._els['rec-status'].textContent.indexOf('还没生成') > -1,
      '实际: ' + envR._els['rec-status'].textContent);
  });

  await test('不填密码就点生成只给提示，不发请求', async function () {
    var before = envR._fetchCalls.length;
    envR._els['btn-gen-recovery'].dispatch('click');
    await flush(80);
    assert.ok(envR._els['rec-gen-msg'].textContent.indexOf('当前密码') > -1);
    assert.strictEqual(envR._fetchCalls.length, before, '不该发请求');
  });

  await test('密码错误时显示服务端原因，不展示任何码', async function () {
    envR._els['rec-gen-pwd'].value = 'wrong-password';
    envR._els['btn-gen-recovery'].dispatch('click');
    await flush(150);
    assert.ok(envR._els['rec-gen-msg'].textContent.indexOf('密码不对') > -1,
      '实际: ' + envR._els['rec-gen-msg'].textContent);
    assert.strictEqual(envR._els['rec-codes-box'].hidden, true);
    // 同上：生成恢复码时输错密码不该把登录态清掉
    assert.strictEqual(envR._els['acct-logged-in'].hidden, false, '应仍处于登录态');
  });

  await test('生成成功后展示明文码并清空密码框', async function () {
    envR._els['rec-gen-pwd'].value = 'password123';
    envR._els['btn-gen-recovery'].dispatch('click');
    await flush(200);
    assert.strictEqual(envR._els['rec-codes-box'].hidden, false, '应展示码');
    var h = envR._els['rec-codes'].innerHTML;
    assert.ok(h.indexOf('ABCD-EFGH-JKMN') > -1, '实际: ' + h);
    assert.strictEqual(envR._els['rec-gen-pwd'].value, '', '密码框应清空');
    assert.ok(envR._els['rec-status'].textContent.indexOf('剩 3 / 3') > -1,
      '实际: ' + envR._els['rec-status'].textContent);
  });

  await test('恢复码明文不写进本地存储', function () {
    var dump = JSON.stringify(envR._store);
    assert.ok(dump.indexOf('ABCD') === -1, '恢复码不该落到 localStorage');
    assert.ok(dump.indexOf('EFGH') === -1);
  });

  await test('复制按钮把全部码写入剪贴板，并带上账号说明', async function () {
    envR._els['btn-copy-codes'].dispatch('click');
    await flush(80);
    var text = envR._copied[envR._copied.length - 1];
    assert.ok(text.indexOf('ABCD-EFGH-JKMN') > -1, '实际: ' + text);
    assert.ok(text.indexOf('PQRS-TUVW-XYZ2') > -1);
    assert.ok(text.indexOf('alice') > -1, '应带上账号名，否则多账号时分不清');
    assert.ok(text.indexOf('只能用一次') > -1, '应说明一次性');
  });

  await test('登出后清掉屏幕上的恢复码明文', async function () {
    envR._els['btn-logout'].dispatch('click');
    await flush(150);
    assert.strictEqual(envR._els['rec-codes-box'].hidden, true);
    assert.strictEqual(envR._els['rec-codes'].innerHTML, '', '不该留下明文');
    assert.strictEqual(envR._els['rec-gen-pwd'].value, '');
  });

  // ---------- 用恢复码找回密码 ----------
  section('用恢复码找回密码');

  await test('未登录页面提供「忘记密码」入口，默认收起', async function () {
    assert.ok(htmlIds['btn-toggle-forgot'], '缺少忘记密码入口');
    assert.strictEqual(initiallyHidden['forgot-form'], true, '表单应默认收起');
  });

  await test('展开时自动带入上面填的用户名', async function () {
    var e = buildEnv({}, serverResponder(), { systemDark: false });
    await flush();
    e._els['acct-username'].value = 'alice';
    e._els['btn-toggle-forgot'].dispatch('click');
    assert.strictEqual(e._els['forgot-form'].hidden, false);
    assert.strictEqual(e._els['rec-username'].value, 'alice');
  });

  await test('没填服务器地址时本地拦下', async function () {
    var e = buildEnv({}, serverResponder(), { systemDark: false });
    await flush();
    e._els['btn-toggle-forgot'].dispatch('click');
    e._els['rec-username'].value = 'alice';
    e._els['rec-code'].value = 'ABCD-EFGH-JKMN';
    e._els['rec-new-pwd'].value = 'brand-new-pw-1';
    var before = e._fetchCalls.length;
    e._els['btn-recover'].dispatch('click');
    await flush(80);
    assert.ok(e._els['rec-msg'].textContent.indexOf('服务器地址') > -1,
      '实际: ' + e._els['rec-msg'].textContent);
    assert.strictEqual(e._fetchCalls.length, before);
  });

  await test('新密码太短时本地拦下，不白白消耗恢复码', async function () {
    var e = buildEnv({}, serverResponder(), { systemDark: false });
    await flush();
    e._els['acct-server-url'].value = SERVER;
    e._els['btn-toggle-forgot'].dispatch('click');
    e._els['rec-username'].value = 'alice';
    e._els['rec-code'].value = 'ABCD-EFGH-JKMN';
    e._els['rec-new-pwd'].value = 'short1';
    var before = e._fetchCalls.length;
    e._els['btn-recover'].dispatch('click');
    await flush(80);
    assert.ok(e._els['rec-msg'].textContent.indexOf('8 位') > -1);
    assert.strictEqual(e._fetchCalls.length, before);
  });

  await test('恢复码错误时显示服务端原因，仍保持未登录', async function () {
    var e = buildEnv({}, serverResponder(), { systemDark: false });
    await flush();
    e._els['acct-server-url'].value = SERVER;
    e._els['btn-toggle-forgot'].dispatch('click');
    e._els['rec-username'].value = 'alice';
    e._els['rec-code'].value = 'ZZZZ-ZZZZ-ZZZZ';
    e._els['rec-new-pwd'].value = 'brand-new-pw-1';
    e._els['btn-recover'].dispatch('click');
    await flush(150);
    assert.ok(e._els['rec-msg'].textContent.indexOf('恢复码不对') > -1,
      '实际: ' + e._els['rec-msg'].textContent);
    assert.strictEqual(e._els['acct-logged-in'].hidden, true, '不该登录成功');
  });

  await test('恢复码正确时重设密码并直接登录，token 落本地', async function () {
    var responder = serverResponder();
    var e = buildEnv({
      settings: { serverUrl: SERVER, token: 'tok-seed', username: 'alice' }
    }, responder, { systemDark: false });
    await flush(200);
    // 先生成一批码（模拟用户之前保存过）
    e._els['rec-gen-pwd'].value = 'password123';
    e._els['btn-gen-recovery'].dispatch('click');
    await flush(200);
    // 再登出，模拟「忘了密码」的处境
    e._els['btn-logout'].dispatch('click');
    await flush(150);

    e._els['acct-server-url'].value = SERVER;
    e._els['btn-toggle-forgot'].dispatch('click');
    e._els['rec-username'].value = 'alice';
    e._els['rec-code'].value = 'abcd efgh jkmn';   // 小写加空格也应被接受
    e._els['rec-new-pwd'].value = 'brand-new-pw-1';
    e._els['btn-recover'].dispatch('click');
    await flush(250);

    var call = e._fetchCalls.filter(function (c) {
      return /recovery\/reset$/.test(c.url);
    }).pop();
    assert.ok(call, '未发出 reset 请求');
    assert.strictEqual(JSON.parse(call.body).new_password, 'brand-new-pw-1');
    assert.strictEqual(e._els['acct-logged-in'].hidden, false, '应已登录');
    var saved = JSON.parse(e._store['nebula-rosette:settings']);
    assert.strictEqual(saved.token, 'tok-reset');
    assert.strictEqual(e._els['rec-code'].value, '', '恢复码不该留在输入框里');
    assert.ok(e._els['rec-gen-msg'].textContent.indexOf('重新生成') > -1,
      '应提示重新生成一批，实际: ' + e._els['rec-gen-msg'].textContent);
  });

  await test('前端不再声称「没有找回密码功能」', function () {
    assert.ok(html.indexOf('没有「忘记密码」功能') === -1,
      '恢复码已实现，这句过期文案必须删掉');
  });

  // ---------- 注销账号 ----------
  section('注销账号');

  function delAcctEnv() {
    return buildEnv({
      periods: [{ start: '2026-03-01', end: '2026-03-05' }],
      notes: { '2026-03-01': { flow: 'medium', pain: 3 } },
      settings: { serverUrl: SERVER, token: 'tok-del-acct', username: 'alice' }
    }, serverResponder(), { systemDark: false });
  }

  await test('注销区默认收起，展开后才出现表单', async function () {
    var e = delAcctEnv();
    await flush(150);
    assert.strictEqual(e._els['delacct-form'].hidden, true);
    e._els['btn-toggle-delacct'].dispatch('click');
    assert.strictEqual(e._els['delacct-form'].hidden, false);
    assert.strictEqual(e._els['btn-toggle-delacct'].getAttribute('aria-expanded'), 'true');
    assert.strictEqual(e._els['delacct-caret'].textContent, '收起');
    // 初始 aria-expanded 由 HTML 给（stub 元素不解析 HTML 属性，所以查源文件）
    assert.ok(/id="btn-toggle-delacct"[^>]*aria-expanded="false"/.test(html) ||
      /aria-expanded="false"[^>]*id="btn-toggle-delacct"/.test(html) ||
      html.indexOf('id="btn-toggle-delacct" type="button" aria-expanded="false"') > -1,
      'HTML 里该按钮应带 aria-expanded="false"');
  });

  await test('不填密码不发请求', async function () {
    var e = delAcctEnv();
    await flush(150);
    e._els['btn-toggle-delacct'].dispatch('click');
    e._els['delacct-confirm'].value = 'alice';
    var before = e._fetchCalls.length;
    e._els['btn-delete-account'].dispatch('click');
    await flush(80);
    assert.ok(e._els['delacct-msg'].textContent.indexOf('当前密码') > -1,
      '实际: ' + e._els['delacct-msg'].textContent);
    assert.strictEqual(e._fetchCalls.length, before, '不该发请求');
  });

  await test('用户名打错时本地拦下，密码不会被发出去', async function () {
    var e = delAcctEnv();
    await flush(150);
    e._els['btn-toggle-delacct'].dispatch('click');
    e._els['delacct-pwd'].value = 'password123';
    e._els['delacct-confirm'].value = 'alicee';
    var before = e._fetchCalls.length;
    e._els['btn-delete-account'].dispatch('click');
    await flush(80);
    assert.ok(e._els['delacct-msg'].textContent.indexOf('不匹配') > -1,
      '实际: ' + e._els['delacct-msg'].textContent);
    assert.ok(e._els['delacct-msg'].textContent.indexOf('alice') > -1, '应提示当前账号名');
    assert.strictEqual(e._fetchCalls.length, before, '密码不该被发出去');
  });

  await test('confirm 取消时不发请求，登录态不变', async function () {
    var e = delAcctEnv();
    await flush(150);
    e._confirmResult = false;
    e._els['btn-toggle-delacct'].dispatch('click');
    e._els['delacct-pwd'].value = 'password123';
    e._els['delacct-confirm'].value = 'alice';
    var before = e._fetchCalls.length;
    e._els['btn-delete-account'].dispatch('click');
    await flush(120);
    assert.strictEqual(e._fetchCalls.length, before, '取消了还发请求');
    assert.ok(e._confirms.length > 0, '应弹过确认');
    assert.ok(e._confirms[0].indexOf('alice') > -1, '确认文案应带账号名');
    assert.strictEqual(e._els['acct-logged-in'].hidden, false, '仍应保持登录');
  });

  await test('密码错误时显示服务端原因，仍保持登录态', async function () {
    var e = delAcctEnv();
    await flush(150);
    e._els['btn-toggle-delacct'].dispatch('click');
    e._els['delacct-pwd'].value = 'wrong-password';
    e._els['delacct-confirm'].value = 'alice';
    e._els['btn-delete-account'].dispatch('click');
    await flush(200);
    assert.ok(e._els['delacct-msg'].textContent.indexOf('密码不对') > -1,
      '实际: ' + e._els['delacct-msg'].textContent);
    assert.strictEqual(e._els['acct-logged-in'].hidden, false, '401 不该把人登出');
    assert.strictEqual(JSON.parse(e._store['nebula-rosette:settings']).token, 'tok-del-acct',
      '输错密码不该清掉有效 token');
  });

  await test('成功注销后清掉本地 token、回到仅本机模式', async function () {
    var e = delAcctEnv();
    await flush(150);
    e._els['btn-toggle-delacct'].dispatch('click');
    e._els['delacct-pwd'].value = 'password123';
    e._els['delacct-confirm'].value = 'alice';
    e._els['btn-delete-account'].dispatch('click');
    await flush(250);

    var call = e._fetchCalls.filter(function (c) {
      return /auth\/delete-account$/.test(c.url);
    }).pop();
    assert.ok(call, '未发出 delete-account 请求');
    var sent = JSON.parse(call.body);
    assert.strictEqual(sent.password, 'password123');
    assert.strictEqual(sent.confirm_username, 'alice');

    assert.strictEqual(e._els['acct-logged-in'].hidden, true, '应回到未登录');
    assert.strictEqual(e._els['acct-logged-out'].hidden, false);
    var saved = JSON.parse(e._store['nebula-rosette:settings']);
    assert.strictEqual(saved.token, '', 'token 必须清空');
    assert.strictEqual(saved.username, '');
    assert.ok(e._els['mode-badge'].textContent.indexOf('仅存本机') > -1,
      '实际: ' + e._els['mode-badge'].textContent);
  });

  await test('注销只删云端，本机记录仍在', async function () {
    var e = delAcctEnv();
    await flush(150);
    e._els['btn-toggle-delacct'].dispatch('click');
    e._els['delacct-pwd'].value = 'password123';
    e._els['delacct-confirm'].value = 'alice';
    e._els['btn-delete-account'].dispatch('click');
    await flush(250);
    var periods = JSON.parse(e._store['nebula-rosette:periods'] || '[]');
    assert.strictEqual(periods.length, 1, '本机经期记录不该被删');
    assert.ok(e._els['toast'].textContent.indexOf('本机记录保留') > -1,
      '实际: ' + e._els['toast'].textContent);
  });

  await test('注销成功后表单收起且密码框已清空', async function () {
    var e = delAcctEnv();
    await flush(150);
    e._els['btn-toggle-delacct'].dispatch('click');
    e._els['delacct-pwd'].value = 'password123';
    e._els['delacct-confirm'].value = 'alice';
    e._els['btn-delete-account'].dispatch('click');
    await flush(250);
    assert.strictEqual(e._els['delacct-form'].hidden, true, '应自动收起');
    assert.strictEqual(e._els['delacct-pwd'].value, '', '密码不该留在输入框');
    assert.strictEqual(e._els['delacct-confirm'].value, '');
  });

  await test('注销后同一批本机记录可以再推给新账号', async function () {
    // 注销 → 用同名重新注册 → 本机数据应能重新同步上去。
    // 这条保证注销没把「本机 → 云端」的链路搞坏（比如把 deleted 队列写脏）。
    var responder = serverResponder();
    var e = buildEnv({
      periods: [{ start: '2026-03-01', end: '2026-03-05' }],
      settings: { serverUrl: SERVER, token: 'tok-x', username: 'alice' }
    }, responder, { systemDark: false });
    await flush(150);
    e._els['btn-toggle-delacct'].dispatch('click');
    e._els['delacct-pwd'].value = 'password123';
    e._els['delacct-confirm'].value = 'alice';
    e._els['btn-delete-account'].dispatch('click');
    await flush(250);

    e._els['acct-server-url'].value = SERVER;
    e._els['acct-username'].value = 'alice';
    e._els['acct-password'].value = 'password123';
    e._els['btn-register'].dispatch('click');
    await flush(400);
    assert.strictEqual(e._els['acct-logged-in'].hidden, false, '应重新登录成功');
    var puts = e._fetchCalls.filter(function (c) {
      return /\/api\/data$/.test(c.url) && c.method === 'PUT';
    });
    assert.ok(puts.length > 0, '重新登录后应把本机数据推上去');
    assert.ok(JSON.parse(puts[puts.length - 1].body).periods.length > 0,
      '推上去的应含本机经期');
  });

  // ---------- 删除与合并同步 ----------
  section('删除同步');

  await test('删除经期会把 start 放进删除队列上报', async function () {
    var e = buildEnv({
      periods: [{ start: '2026-03-01', end: '2026-03-05' }],
      settings: { serverUrl: SERVER, token: 'tok-del', username: 'alice' }
    }, serverResponder(), { systemDark: false });
    await flush(150);
    e._els['cal-grid'].dispatch('click', {
      target: { closest: function () { return { getAttribute: function () { return '2026-03-01'; } }; } }
    });
    await flush(60);
    e._els['sheet-remove'].dispatch('click');
    await flush(1600);
    var puts = e._fetchCalls.filter(function (c) {
      return /\/api\/data$/.test(c.url) && c.method === 'PUT';
    });
    var last = JSON.parse(puts[puts.length - 1].body);
    assert.ok(last.deletedPeriods.indexOf('2026-03-01') > -1,
      '删除队列应含该日期，实际 ' + JSON.stringify(last.deletedPeriods));
  });

  await test('推送成功后删除队列被清空，不会反复上报', async function () {
    var e = buildEnv({
      periods: [{ start: '2026-03-01', end: '2026-03-05' }],
      settings: { serverUrl: SERVER, token: 'tok-del2', username: 'alice' }
    }, serverResponder(), { systemDark: false });
    await flush(150);
    await e.Storage.markPeriodDeleted('2026-03-01');
    e._els['btn-sync-now'].dispatch('click');
    await flush(200);
    var meta = await e.Storage.getMeta();
    assert.deepStrictEqual(meta.deletedPeriods, [], '推送后应清空');
  });

  await test('备注被清空时记为删除，而不是静默不上报', async function () {
    var e = buildEnv({
      periods: [{ start: '2026-03-01', end: '2026-03-05' }],
      notes: { '2026-03-02': { flow: 'light', pain: 1, text: '旧的' } },
      settings: { serverUrl: SERVER, token: 'tok-del3', username: 'alice' }
    }, serverResponder(), { systemDark: false });
    await flush(150);
    e._els['cal-grid'].dispatch('click', {
      target: { closest: function () { return { getAttribute: function () { return '2026-03-02'; } }; } }
    });
    await flush(60);
    e._els['sheet-flow'].value = '';
    e._els['sheet-pain'].value = '0';
    e._els['sheet-note'].value = '';
    e._els['sheet-save'].dispatch('click');
    await flush(1600);
    var puts = e._fetchCalls.filter(function (c) {
      return /\/api\/data$/.test(c.url) && c.method === 'PUT';
    });
    var last = JSON.parse(puts[puts.length - 1].body);
    assert.ok(last.deletedNotes.indexOf('2026-03-02') > -1,
      '实际 ' + JSON.stringify(last.deletedNotes));
  });

  await test('改备注会带上本地时间戳，服务端才能判新旧', async function () {
    var e = buildEnv({
      periods: [{ start: '2026-03-01', end: '2026-03-05' }],
      settings: { serverUrl: SERVER, token: 'tok-ts', username: 'alice' }
    }, serverResponder(), { systemDark: false });
    await flush(150);
    e._els['cal-grid'].dispatch('click', {
      target: { closest: function () { return { getAttribute: function () { return '2026-03-03'; } }; } }
    });
    await flush(60);
    e._els['sheet-note'].value = '有点累';
    e._els['sheet-save'].dispatch('click');
    await flush(1600);
    var puts = e._fetchCalls.filter(function (c) {
      return /\/api\/data$/.test(c.url) && c.method === 'PUT';
    });
    var last = JSON.parse(puts[puts.length - 1].body);
    assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(last.noteTimes['2026-03-03'] || ''),
      '缺少或格式不对: ' + last.noteTimes['2026-03-03']);
  });

  await test('清空数据走整表替换，否则合并模式下服务端删不掉', async function () {
    var e = buildEnv({
      periods: [{ start: '2026-03-01', end: '2026-03-05' }],
      settings: { serverUrl: SERVER, token: 'tok-clr', username: 'alice' }
    }, serverResponder(), { systemDark: false });
    await flush(150);
    e._els['btn-clear'].dispatch('click');
    await flush(200);
    var rep = e._fetchCalls.filter(function (c) { return /\/api\/data\/replace$/.test(c.url); });
    assert.strictEqual(rep.length, 1, '应调用 /api/data/replace');
    assert.deepStrictEqual(JSON.parse(rep[0].body).periods, []);
  });

  // ---------- 症状、洞察、报告 ----------
  section('症状记录');

  var SYM_SEED = {
    periods: [
      { start: '2026-01-01', end: '2026-01-05' },
      { start: '2026-01-29', end: '2026-02-02' },
      { start: '2026-02-26', end: '2026-03-02' }
    ],
    notes: {
      '2026-01-02': { flow: 'heavy', pain: 4, symptoms: ['cramps', 'headache'] },
      '2026-01-30': { flow: 'heavy', pain: 5, symptoms: ['cramps'] },
      '2026-02-27': { flow: 'medium', pain: 4, symptoms: ['cramps', 'fatigue'] }
    }
  };

  await test('症状 chips 按 period.js 的定义渲染，数量一致', async function () {
    var e = buildEnv({}, serverResponder(), { systemDark: false });
    await flush();
    var html = e._els['sheet-symptoms'].innerHTML;
    var n = (html.match(/data-sym="/g) || []).length;
    assert.strictEqual(n, e.PeriodCore.SYMPTOMS.length, '实际 ' + n);
    assert.ok(html.indexOf('data-sym="cramps"') > -1);
    assert.ok(/aria-pressed="false"/.test(html), '初始应全部未选中');
  });

  await test('打开某天时回填已记录的症状', async function () {
    var e = buildEnv(SYM_SEED, serverResponder(), { systemDark: false });
    await flush(150);
    e._els['cal-grid'].dispatch('click', {
      target: { closest: function () { return { getAttribute: function () { return '2026-01-02'; } }; } }
    });
    await flush(60);
    var chips = e._els['sheet-symptoms'].querySelectorAll('[data-sym]');
    var on = chips.filter(function (c) { return c.getAttribute('aria-pressed') === 'true'; })
      .map(function (c) { return c.getAttribute('data-sym'); });
    assert.deepStrictEqual(on.sort(), ['cramps', 'headache']);
  });

  await test('点 chip 切换选中状态', async function () {
    var e = buildEnv({}, serverResponder(), { systemDark: false });
    await flush();
    var chips = e._els['sheet-symptoms'].querySelectorAll('[data-sym]');
    var target = chips[0];
    e._els['sheet-symptoms'].dispatch('click', {
      target: { closest: function () { return target; } }
    });
    assert.strictEqual(target.getAttribute('aria-pressed'), 'true');
    e._els['sheet-symptoms'].dispatch('click', {
      target: { closest: function () { return target; } }
    });
    assert.strictEqual(target.getAttribute('aria-pressed'), 'false');
  });

  await test('保存时把选中的症状写进 notes', async function () {
    var e = buildEnv({ periods: [{ start: '2026-03-01', end: '2026-03-05' }] },
      serverResponder(), { systemDark: false });
    await flush(150);
    e._els['cal-grid'].dispatch('click', {
      target: { closest: function () { return { getAttribute: function () { return '2026-03-02'; } }; } }
    });
    await flush(60);
    var chips = e._els['sheet-symptoms'].querySelectorAll('[data-sym]');
    var pick = chips.filter(function (c) {
      return ['cramps', 'insomnia'].indexOf(c.getAttribute('data-sym')) > -1;
    });
    pick.forEach(function (c) {
      e._els['sheet-symptoms'].dispatch('click', {
        target: { closest: function () { return c; } }
      });
    });
    e._els['sheet-save'].dispatch('click');
    await flush(150);
    var notes = JSON.parse(e._store['nebula-rosette:notes']);
    assert.deepStrictEqual((notes['2026-03-02'].symptoms || []).sort(), ['cramps', 'insomnia']);
  });

  await test('只选了症状（没有流量痛感备注）也算有记录，不被当成清空', async function () {
    var e = buildEnv({ periods: [{ start: '2026-03-01', end: '2026-03-05' }] },
      serverResponder(), { systemDark: false });
    await flush(150);
    e._els['cal-grid'].dispatch('click', {
      target: { closest: function () { return { getAttribute: function () { return '2026-03-03'; } }; } }
    });
    await flush(60);
    var chips = e._els['sheet-symptoms'].querySelectorAll('[data-sym]');
    e._els['sheet-symptoms'].dispatch('click', {
      target: { closest: function () { return chips[0]; } }
    });
    e._els['sheet-save'].dispatch('click');
    await flush(150);
    var notes = JSON.parse(e._store['nebula-rosette:notes']);
    assert.ok(notes['2026-03-03'], '该天应有记录');
    assert.strictEqual(notes['2026-03-03'].symptoms.length, 1);
  });

  await test('取消全部症状且其他都空时视为删除，进删除队列', async function () {
    var e = buildEnv({
      periods: [{ start: '2026-03-01', end: '2026-03-05' }],
      notes: { '2026-03-04': { symptoms: ['cramps'] } },
      settings: { serverUrl: SERVER, token: 'tok-sym', username: 'alice' }
    }, serverResponder(), { systemDark: false });
    await flush(150);
    e._els['cal-grid'].dispatch('click', {
      target: { closest: function () { return { getAttribute: function () { return '2026-03-04'; } }; } }
    });
    await flush(60);
    var chips = e._els['sheet-symptoms'].querySelectorAll('[data-sym]');
    var cramps = chips.filter(function (c) { return c.getAttribute('data-sym') === 'cramps'; })[0];
    assert.strictEqual(cramps.getAttribute('aria-pressed'), 'true', '应先是选中的');
    e._els['sheet-symptoms'].dispatch('click', {
      target: { closest: function () { return cramps; } }
    });
    e._els['sheet-save'].dispatch('click');
    await flush(1600);
    var meta = await e.Storage.getMeta();
    assert.ok(meta.deletedNotes.indexOf('2026-03-04') > -1 ||
      e._fetchCalls.some(function (c) {
        return c.body && JSON.parse(c.body).deletedNotes &&
          JSON.parse(c.body).deletedNotes.indexOf('2026-03-04') > -1;
      }), '应记为删除');
  });

  section('症状排行与健康提示');

  await test('症状排行按出现过的经期次数排序', async function () {
    var e = buildEnv(SYM_SEED, serverResponder(), { systemDark: false });
    await flush(150);
    var html = e._els['symptom-chart'].innerHTML;
    assert.ok(html.indexOf('腹痛') > -1, '缺少腹痛');
    assert.ok(html.indexOf('3/3 次') > -1, '腹痛应是 3/3，实际: ' + html.slice(0, 300));
    assert.ok(html.indexOf('腹痛') < html.indexOf('疲倦'), '腹痛应排在疲倦之前');
  });

  await test('没有症状记录时给出引导而不是空白', async function () {
    var e = buildEnv({ periods: [{ start: '2026-03-01', end: '2026-03-05' }] },
      serverResponder(), { systemDark: false });
    await flush(150);
    assert.ok(e._els['symptom-chart'].innerHTML.indexOf('勾选症状') > -1);
  });

  await test('持续高痛感会给出「跟医生聊聊」级别的提示', async function () {
    var e = buildEnv(SYM_SEED, serverResponder(), { systemDark: false });
    await flush(150);
    var html = e._els['insight-list'].innerHTML;
    assert.ok(html.indexOf('痛感持续偏强') > -1, '实际: ' + html.slice(0, 400));
    assert.ok(html.indexOf('insight-attention') > -1, '应为 attention 级别');
    assert.ok(html.indexOf('依据：') > -1, '每条提示必须给出依据');
    assert.ok(e._els['insight-count'].textContent.indexOf('医生') > -1);
  });

  await test('提示文案不含任何用药建议', async function () {
    var e = buildEnv(SYM_SEED, serverResponder(), { systemDark: false });
    await flush(150);
    var html = e._els['insight-list'].innerHTML;
    ['布洛芬', '止痛药', '避孕', '安全期'].forEach(function (bad) {
      assert.strictEqual(html.indexOf(bad), -1, '不应出现「' + bad + '」');
    });
  });

  await test('记录很少时明确说结论不可靠', async function () {
    var e = buildEnv({ periods: [{ start: '2026-03-01', end: '2026-03-05' },
      { start: '2026-03-29', end: '2026-04-02' }] }, serverResponder(), { systemDark: false });
    await flush(150);
    assert.ok(e._els['insight-list'].innerHTML.indexOf('记录还不多') > -1);
  });

  await test('无记录时不显示提示卡内容', async function () {
    var e = buildEnv({}, serverResponder(), { systemDark: false });
    await flush();
    assert.ok(e._els['insight-list'].innerHTML.indexOf('没有需要特别留意') > -1);
  });

  section('月度报告');

  await test('报告包含周期长度、症状和最近记录', async function () {
    var e = buildEnv(SYM_SEED, serverResponder(), { systemDark: false });
    await flush(150);
    var txt = e._els['report-body'].textContent;
    assert.ok(txt.indexOf('经期记录摘要') > -1);
    assert.ok(txt.indexOf('周期长度') > -1);
    assert.ok(txt.indexOf('腹痛') > -1);
    assert.ok(txt.indexOf('2026-01-01') > -1, '应含最近记录日期');
    assert.ok(txt.indexOf('非医疗诊断') > -1);
  });

  await test('报告不含备注正文——它的用途就是发给别人看', async function () {
    var seed = JSON.parse(JSON.stringify(SYM_SEED));
    seed.notes['2026-01-02'].text = '和男朋友吵架了很难受';
    var e = buildEnv(seed, serverResponder(), { systemDark: false });
    await flush(150);
    var txt = e._els['report-body'].textContent;
    assert.strictEqual(txt.indexOf('男朋友'), -1, '备注正文泄露进报告');
    assert.strictEqual(txt.indexOf('吵架'), -1);
  });

  await test('无记录时报告说明还没有数据，不报错', async function () {
    var e = buildEnv({}, serverResponder(), { systemDark: false });
    await flush();
    assert.ok(e._els['report-body'].textContent.indexOf('还没有任何记录') > -1);
  });

  await test('复制按钮写入剪贴板', async function () {
    var e = buildEnv(SYM_SEED, serverResponder(), { systemDark: false });
    await flush(150);
    e._els['btn-copy-report'].dispatch('click');
    await flush(80);
    assert.strictEqual(e._copied.length, 1);
    assert.ok(e._copied[0].indexOf('经期记录摘要') > -1);
  });

  await test('没有 clipboard API 时提示手动复制，不静默失败', async function () {
    var e = buildEnv(SYM_SEED, serverResponder(), { systemDark: false, noClipboard: true });
    await flush(150);
    e._els['btn-copy-report'].dispatch('click');
    await flush(80);
    assert.ok(e._els['toast'].textContent.indexOf('手动复制') > -1,
      '实际: ' + e._els['toast'].textContent);
  });

  section('经前逐日规律');

  // 三次周期，每次经前 3 天有情绪起伏，经期第 2 天最疼
  var TL_SEED = {
    periods: [
      { start: '2026-01-01', end: '2026-01-05' },
      { start: '2026-01-29', end: '2026-02-02' },
      { start: '2026-02-26', end: '2026-03-02' }
    ],
    notes: {
      '2025-12-29': { symptoms: ['mood_swings'] },
      '2026-01-01': { flow: 'medium', pain: 2 },
      '2026-01-02': { flow: 'heavy', pain: 5, symptoms: ['cramps'] },
      '2026-01-26': { symptoms: ['mood_swings'] },
      '2026-01-29': { flow: 'medium', pain: 3 },
      '2026-01-30': { flow: 'heavy', pain: 5, symptoms: ['cramps'] },
      '2026-02-23': { symptoms: ['mood_swings'] },
      '2026-02-26': { flow: 'light', pain: 2 },
      '2026-02-27': { flow: 'medium', pain: 4, symptoms: ['cramps'] }
    }
  };

  await test('热力图渲染出经前列与经期列，并标出原点', async function () {
    var e = buildEnv(TL_SEED, serverResponder(), { systemDark: false });
    await flush(150);
    var html = e._els['timeline-chart'].innerHTML;
    assert.ok(html.indexOf('hm-grid') > -1, '未渲染网格');
    assert.ok(html.indexOf('>前3<') > -1, '缺经前第 3 天列: ' + html.slice(0, 300));
    assert.ok(html.indexOf('>第1<') > -1, '缺经期第 1 天列');
    assert.ok(html.indexOf('hm-onset') > -1, '经期开始列应有原点标记');
    assert.ok(e._els['timeline-note'].textContent.indexOf('3 次') > -1,
      '实际: ' + e._els['timeline-note'].textContent);
  });

  await test('给出「提前几天开始」和「第几天最疼」的结论', async function () {
    var e = buildEnv(TL_SEED, serverResponder(), { systemDark: false });
    await flush(150);
    var html = e._els['timeline-chart'].innerHTML;
    assert.ok(html.indexOf('提前 3 天') > -1, '实际: ' + html.slice(-600));
    assert.ok(html.indexOf('情绪起伏') > -1);
    assert.ok(html.indexOf('第 2 天平均最疼') > -1, '实际: ' + html.slice(-600));
  });

  await test('没有样本的列画成斜纹，不伪装成「没有症状」', async function () {
    var e = buildEnv(TL_SEED, serverResponder(), { systemDark: false });
    await flush(150);
    // 三次经期都只有 5 天，第 8~10 天没有样本
    assert.ok(e._els['timeline-chart'].innerHTML.indexOf('hm-empty') > -1);
  });

  await test('没有经前记录时给引导而不是空图', async function () {
    var e = buildEnv({ periods: [{ start: '2026-03-01', end: '2026-03-05' }] },
      serverResponder(), { systemDark: false });
    await flush(150);
    assert.ok(e._els['timeline-chart'].innerHTML.indexOf('经期前几天') > -1);
    assert.strictEqual(e._els['timeline-note'].textContent, '');
  });

  await test('报告里带上经前反应一段', async function () {
    var e = buildEnv(TL_SEED, serverResponder(), { systemDark: false });
    await flush(150);
    var txt = e._els['report-body'].textContent;
    assert.ok(txt.indexOf('【经前反应】') > -1, '实际: ' + txt.slice(0, 800));
    assert.ok(txt.indexOf('通常提前 3 天') > -1);
    assert.ok(txt.indexOf('情绪起伏') > -1);
  });

  // 横幅要测「快来了」的状态，所以日期必须相对今天生成，
  // 写死的种子日期永远落在过去，只会命中「已推迟」分支。
  function relSeed() {
    var P = require(path.join(ROOT, 'js/period.js'));
    var today = P.todayKey();
    var periods = [];
    var notes = {};
    // 三次周期，间隔 28 天；最后一次结束后再过 26 天就是今天 → 距预测 2 天
    var starts = [P.addDays(today, -84), P.addDays(today, -56), P.addDays(today, -28)];
    starts.forEach(function (s) {
      periods.push({ start: s, end: P.addDays(s, 4) });
      notes[P.addDays(s, -3)] = { symptoms: ['mood_swings'] };
      notes[P.addDays(s, 1)] = { flow: 'heavy', pain: 4, symptoms: ['cramps'] };
    });
    return { periods: periods, notes: notes };
  }

  await test('临近预测日时横幅带上个人化的经前预告', async function () {
    var e = buildEnv(relSeed(), serverResponder(), { systemDark: false });
    await flush(150);
    assert.strictEqual(e._els['reminder'].hidden, false, '横幅应显示');
    assert.strictEqual(e._els['reminder-hint'].hidden, false,
      '应显示经前预告，标题: ' + e._els['reminder-title'].textContent);
    assert.ok(e._els['reminder-hint'].textContent.indexOf('情绪起伏') > -1,
      '实际: ' + e._els['reminder-hint'].textContent);
  });

  await test('没有经前记录时横幅不多出一行空提示', async function () {
    var seed = relSeed();
    seed.notes = {};   // 去掉所有备注，只留周期
    var e = buildEnv(seed, serverResponder(), { systemDark: false });
    await flush(150);
    assert.strictEqual(e._els['reminder-hint'].hidden, true);
    assert.strictEqual(e._els['reminder-hint'].textContent, '');
  });

  section('CSV 导出');

  await test('点导出 CSV 触发下载，文件名带日期与 .csv', async function () {
    var e = buildEnv(TL_SEED, serverResponder(), { systemDark: false });
    await flush(150);
    e._els['btn-export-csv'].dispatch('click');
    await flush(60);
    assert.strictEqual(e._downloads.length, 1, '应触发一次下载');
    assert.ok(/^nebula-rosette-\d{4}-\d{2}-\d{2}\.csv$/.test(e._downloads[0].name),
      '实际文件名: ' + e._downloads[0].name);
  });

  await test('CSV 以 BOM 开头，否则中文表头在 Excel 里乱码', async function () {
    var e = buildEnv(TL_SEED, serverResponder(), { systemDark: false });
    await flush(150);
    e._els['btn-export-csv'].dispatch('click');
    await flush(60);
    assert.strictEqual(e._downloads[0].text.charCodeAt(0), 0xFEFF);
  });

  await test('CSV 内容含表头与逐日数据', async function () {
    var e = buildEnv(TL_SEED, serverResponder(), { systemDark: false });
    await flush(150);
    e._els['btn-export-csv'].dispatch('click');
    await flush(60);
    var txt = e._downloads[0].text;
    assert.ok(txt.indexOf('日期,星期,阶段') > -1, '缺表头: ' + txt.slice(0, 120));
    assert.ok(txt.indexOf('2026-01-02') > -1);
    assert.ok(txt.indexOf('腹痛') > -1);
    // 经前那天也要在里面——它不在任何经期内，最容易被漏掉
    assert.ok(txt.indexOf('2025-12-29') > -1, '经前记录未导出');
  });

  await test('备注里的公式在 CSV 里被中和', async function () {
    var seed = JSON.parse(JSON.stringify(TL_SEED));
    seed.notes['2026-01-02'].text = '=1+1';
    var e = buildEnv(seed, serverResponder(), { systemDark: false });
    await flush(150);
    e._els['btn-export-csv'].dispatch('click');
    await flush(60);
    assert.ok(e._downloads[0].text.indexOf("'=1+1") > -1, '公式未被中和');
  });

  await test('没有任何记录时不下载空文件，而是提示', async function () {
    var e = buildEnv({}, serverResponder(), { systemDark: false });
    await flush();
    e._els['btn-export-csv'].dispatch('click');
    await flush(60);
    assert.strictEqual(e._downloads.length, 0, '不该产出空 CSV');
    assert.ok(e._els['toast'].textContent.indexOf('还没有可导出') > -1,
      '实际: ' + e._els['toast'].textContent);
  });

  await test('JSON 导出仍然正常，且不含 apiKey', async function () {
    var seed = JSON.parse(JSON.stringify(TL_SEED));
    seed.settings = { apiKey: 'sk-must-not-leak', theme: 'rosette' };
    var e = buildEnv(seed, serverResponder(), { systemDark: false });
    await flush(150);
    e._els['btn-export'].dispatch('click');
    await flush(60);
    assert.strictEqual(e._downloads.length, 1);
    assert.ok(/\.json$/.test(e._downloads[0].name));
    assert.strictEqual(e._downloads[0].text.indexOf('sk-must-not-leak'), -1,
      'apiKey 泄露进 JSON 备份');
  });

  section('改经期起止日');

  var EDIT_SEED = {
    periods: [
      { start: '2026-03-01', end: '2026-03-05' },
      { start: '2026-03-29', end: '2026-04-02' }
    ],
    notes: { '2026-03-02': { flow: 'heavy', pain: 4, symptoms: ['cramps'] } },
    settings: { serverUrl: SERVER, token: 'tok-edit', username: 'alice' }
  };

  /** 点开某一天的弹层 */
  function openDay(e, key) {
    e._els['cal-grid'].dispatch('click', {
      target: { closest: function () {
        return { getAttribute: function () { return key; } };
      } }
    });
  }

  await test('经期内的日子才显示「改起止日」按钮', async function () {
    var e = buildEnv(EDIT_SEED, serverResponder(), { systemDark: false });
    await flush(150);
    openDay(e, '2026-03-02');
    await flush(60);
    assert.strictEqual(e._els['sheet-edit'].hidden, false, '经期内应可改');
    openDay(e, '2026-03-15');
    await flush(60);
    assert.strictEqual(e._els['sheet-edit'].hidden, true, '非经期日不该给改的入口');
  });

  await test('展开后回填这一段的起止日，而不是点击的那天', async function () {
    var e = buildEnv(EDIT_SEED, serverResponder(), { systemDark: false });
    await flush(150);
    openDay(e, '2026-03-03');      // 点的是第 3 天
    await flush(60);
    e._els['sheet-edit'].dispatch('click');
    assert.strictEqual(e._els['sheet-edit-form'].hidden, false);
    assert.strictEqual(e._els['sheet-edit-start'].value, '2026-03-01', '应回填该段开始日');
    assert.strictEqual(e._els['sheet-edit-end'].value, '2026-03-05');
  });

  await test('保存新日期后落盘，原记录被替换', async function () {
    var e = buildEnv(EDIT_SEED, serverResponder(), { systemDark: false });
    await flush(150);
    openDay(e, '2026-03-02');
    await flush(60);
    e._els['sheet-edit'].dispatch('click');
    e._els['sheet-edit-start'].value = '2026-03-02';
    e._els['sheet-edit-end'].value = '2026-03-06';
    e._els['sheet-edit-save'].dispatch('click');
    await flush(150);

    var saved = await e.Storage.getPeriods();
    var seg = saved.filter(function (p) { return p.start === '2026-03-02'; })[0];
    assert.ok(seg, '新起始日未落盘: ' + JSON.stringify(saved));
    assert.strictEqual(seg.end, '2026-03-06');
    assert.strictEqual(saved.filter(function (p) {
      return p.start === '2026-03-01';
    }).length, 0, '旧记录应被替换而不是并存');
    assert.strictEqual(e._els['sheet'].hidden, true, '保存后应关掉弹层');
  });

  await test('改了开始日会把旧 start 排进删除队列并上报', async function () {
    // 关键路径：periods 按 start_date 并集合并，不显式删旧的话
    // 下次拉取会把改错的那段原样拉回来。
    var e = buildEnv(EDIT_SEED, serverResponder(), { systemDark: false });
    await flush(150);
    openDay(e, '2026-03-02');
    await flush(60);
    e._els['sheet-edit'].dispatch('click');
    e._els['sheet-edit-start'].value = '2026-03-02';
    e._els['sheet-edit-end'].value = '2026-03-06';
    e._els['sheet-edit-save'].dispatch('click');
    await flush(1800);

    var puts = e._fetchCalls.filter(function (c) {
      return /\/api\/data$/.test(c.url) && c.method === 'PUT';
    });
    assert.ok(puts.length > 0, '未推送');
    var body = JSON.parse(puts[puts.length - 1].body);
    assert.ok(body.deletedPeriods.indexOf('2026-03-01') > -1,
      '旧 start 应进删除队列，实际 ' + JSON.stringify(body.deletedPeriods));
    assert.ok(body.periods.some(function (p) { return p.start === '2026-03-02'; }),
      '新段应一起推上去');
  });

  await test('只改结束日时不进删除队列（start 没变，合并会直接更新）', async function () {
    var e = buildEnv(EDIT_SEED, serverResponder(), { systemDark: false });
    await flush(150);
    openDay(e, '2026-03-02');
    await flush(60);
    e._els['sheet-edit'].dispatch('click');
    e._els['sheet-edit-end'].value = '2026-03-07';
    e._els['sheet-edit-save'].dispatch('click');
    await flush(1800);
    var puts = e._fetchCalls.filter(function (c) {
      return /\/api\/data$/.test(c.url) && c.method === 'PUT';
    });
    var body = JSON.parse(puts[puts.length - 1].body);
    assert.strictEqual(body.deletedPeriods.indexOf('2026-03-01'), -1,
      'start 没变就不该排删除');
  });

  await test('改日期不影响已记的流量痛感症状', async function () {
    var e = buildEnv(EDIT_SEED, serverResponder(), { systemDark: false });
    await flush(150);
    openDay(e, '2026-03-02');
    await flush(60);
    e._els['sheet-edit'].dispatch('click');
    e._els['sheet-edit-start'].value = '2026-03-02';
    e._els['sheet-edit-end'].value = '2026-03-06';
    e._els['sheet-edit-save'].dispatch('click');
    await flush(200);
    var notes = JSON.parse(e._store['nebula-rosette:notes']);
    assert.strictEqual(notes['2026-03-02'].pain, 4, '备注不该被动到');
    assert.deepStrictEqual(notes['2026-03-02'].symptoms, ['cramps']);
  });

  await test('非法输入显示原因，弹层不关、数据不动', async function () {
    var e = buildEnv(EDIT_SEED, serverResponder(), { systemDark: false });
    await flush(150);
    openDay(e, '2026-03-02');
    await flush(60);
    e._els['sheet-edit'].dispatch('click');
    e._els['sheet-edit-start'].value = '2026-03-05';
    e._els['sheet-edit-end'].value = '2026-03-02';   // 结束早于开始
    e._els['sheet-edit-save'].dispatch('click');
    await flush(120);
    assert.ok(e._els['sheet-edit-msg'].textContent.indexOf('早于') > -1,
      '实际: ' + e._els['sheet-edit-msg'].textContent);
    assert.strictEqual(e._els['sheet'].hidden, false, '出错不该关弹层');
    var saved = JSON.parse(e._store['nebula-rosette:periods']);
    assert.ok(saved.some(function (p) { return p.start === '2026-03-01'; }),
      '数据不该被改动');
  });

  await test('改成和另一段重叠时被拒，提示点出是哪一段', async function () {
    var e = buildEnv(EDIT_SEED, serverResponder(), { systemDark: false });
    await flush(150);
    openDay(e, '2026-03-02');
    await flush(60);
    e._els['sheet-edit'].dispatch('click');
    e._els['sheet-edit-start'].value = '2026-03-28';
    e._els['sheet-edit-end'].value = '2026-03-30';
    e._els['sheet-edit-save'].dispatch('click');
    await flush(120);
    assert.ok(e._els['sheet-edit-msg'].textContent.indexOf('2026-03-29') > -1,
      '实际: ' + e._els['sheet-edit-msg'].textContent);
  });

  await test('取消收起表单且不改数据', async function () {
    var e = buildEnv(EDIT_SEED, serverResponder(), { systemDark: false });
    await flush(150);
    openDay(e, '2026-03-02');
    await flush(60);
    e._els['sheet-edit'].dispatch('click');
    e._els['sheet-edit-start'].value = '2026-03-02';
    e._els['sheet-edit-cancel'].dispatch('click');
    assert.strictEqual(e._els['sheet-edit-form'].hidden, true);
    var saved = JSON.parse(e._store['nebula-rosette:periods']);
    assert.ok(saved.some(function (p) { return p.start === '2026-03-01'; }));
  });

  await test('重开弹层时编辑表单是收起状态，不残留上一次的值', async function () {
    var e = buildEnv(EDIT_SEED, serverResponder(), { systemDark: false });
    await flush(150);
    openDay(e, '2026-03-02');
    await flush(60);
    e._els['sheet-edit'].dispatch('click');
    e._els['sheet-close'].dispatch('click');
    openDay(e, '2026-03-30');
    await flush(60);
    assert.strictEqual(e._els['sheet-edit-form'].hidden, true, '应收起');
    e._els['sheet-edit'].dispatch('click');
    assert.strictEqual(e._els['sheet-edit-start'].value, '2026-03-29',
      '应回填新点开那一段');
  });

  section('备份格式 v2');

  await test('导出的版本号是 2，且 notes 一定带 symptoms 数组', async function () {
    var e = buildEnv({
      periods: [{ start: '2026-03-01', end: '2026-03-05' }],
      notes: { '2026-03-02': { flow: 'heavy', pain: 4 } }   // 老形状，没有 symptoms
    }, serverResponder(), { systemDark: false });
    await flush(150);
    var data = await e.Storage.exportAll();
    assert.strictEqual(data.version, 2);
    assert.ok(Array.isArray(data.notes['2026-03-02'].symptoms),
      'symptoms 必须补成数组');
  });

  await test('导入 v1 老备份成功，并报告已升级', async function () {
    var e = buildEnv({}, serverResponder(), { systemDark: false });
    await flush();
    var info = await e.Storage.importAll({
      app: 'Nebula Rosette', version: 1,
      periods: [{ start: '2026-05-01', end: '2026-05-05' }],
      notes: { '2026-05-02': { flow: 'medium', pain: 3, text: '还行' } }
    });
    assert.strictEqual(info.version, 1);
    assert.strictEqual(info.upgraded, true);
    var notes = await e.Storage.getNotes();
    assert.deepStrictEqual(notes['2026-05-02'].symptoms, [], 'v1 没有症状，应补空数组');
    assert.strictEqual(notes['2026-05-02'].pain, 3);
  });

  await test('没有 version 字段的最早期备份按 v1 处理', async function () {
    var e = buildEnv({}, serverResponder(), { systemDark: false });
    await flush();
    var info = await e.Storage.importAll({
      periods: [{ start: '2026-05-01', end: '2026-05-05' }], notes: {}
    });
    assert.strictEqual(info.version, 1);
    assert.strictEqual(info.upgraded, true);
  });

  await test('拒绝来自更新版本的备份，而不是静默丢字段', async function () {
    var e = buildEnv({}, serverResponder(), { systemDark: false });
    await flush();
    var err = null;
    try {
      await e.Storage.importAll({ version: 99, periods: [], notes: {} });
    } catch (x) { err = x; }
    assert.ok(err, '应该抛错');
    assert.ok(err.message.indexOf('v99') > -1, '实际: ' + err.message);
    assert.ok(err.message.indexOf('v2') > -1, '应说明当前支持到哪个版本');
  });

  await test('导入时清掉脏值：非法流量、越界痛感、不认识的症状 key', async function () {
    var e = buildEnv({}, serverResponder(), { systemDark: false });
    await flush();
    await e.Storage.importAll({
      version: 2,
      periods: [{ start: '2026-05-01', end: '2026-05-05' }],
      notes: {
        '2026-05-02': {
          flow: 'ENORMOUS', pain: 99,
          symptoms: ['cramps', 'made_up_symptom', 'cramps'], text: '  ok  '
        },
        'not-a-date': { flow: 'light' },
        '2026-05-03': { flow: null, pain: 0, symptoms: [], text: '' }
      }
    });
    var notes = await e.Storage.getNotes();
    var n = notes['2026-05-02'];
    assert.strictEqual(n.flow, null, '非法流量应丢掉');
    assert.strictEqual(n.pain, null, '越界痛感应丢掉');
    assert.deepStrictEqual(n.symptoms, ['cramps'], '未知 key 应丢掉且去重');
    assert.strictEqual(n.text, 'ok', '文本应去空白');
    assert.strictEqual('not-a-date' in notes, false, '非日期键不该进库');
    assert.strictEqual('2026-05-03' in notes, false, '整条没内容的应丢掉');
  });

  await test('字符串型痛感被接受（宽容读取，备份是用户唯一的副本）', async function () {
    var e = buildEnv({}, serverResponder(), { systemDark: false });
    await flush();
    await e.Storage.importAll({
      version: 2, periods: [],
      notes: { '2026-05-02': { pain: '3' } }
    });
    var notes = await e.Storage.getNotes();
    assert.strictEqual(notes['2026-05-02'].pain, 3);
  });

  await test('周期里 end 早于 start 的脏数据当成未结束，而非整份拒绝', async function () {
    var e = buildEnv({}, serverResponder(), { systemDark: false });
    await flush();
    await e.Storage.importAll({
      version: 2,
      periods: [{ start: '2026-05-01', end: '2026-04-01' }], notes: {}
    });
    var ps = await e.Storage.getPeriods();
    assert.strictEqual(ps.length, 1);
    assert.strictEqual(ps[0].end, null);
  });

  await test('periods 非法时仍然整份拒绝，不清空已有数据', async function () {
    var e = buildEnv({
      periods: [{ start: '2026-03-01', end: '2026-03-05' }]
    }, serverResponder(), { systemDark: false });
    await flush(150);
    var err = null;
    try {
      await e.Storage.importAll({ version: 2, periods: [{ start: 'nope' }], notes: {} });
    } catch (x) { err = x; }
    assert.ok(err, '应该抛错');
    var ps = await e.Storage.getPeriods();
    assert.strictEqual(ps.length, 1, '已有数据不该被清');
  });

  await test('导出再导入一轮数据不变（round-trip）', async function () {
    var e = buildEnv({
      periods: [{ start: '2026-03-01', end: '2026-03-05' }],
      notes: { '2026-03-02': { flow: 'heavy', pain: 4, symptoms: ['cramps'], text: '疼' } }
    }, serverResponder(), { systemDark: false });
    await flush(150);
    var dumped = await e.Storage.exportAll();
    await e.Storage.importAll(JSON.parse(JSON.stringify(dumped)));
    var again = await e.Storage.exportAll();
    assert.deepStrictEqual(again.periods, dumped.periods);
    assert.deepStrictEqual(again.notes, dumped.notes);
  });

  section('前后端症状定义一致');

  section('账号隔离与失败保存回归');

  await test('切换账号使用独立记录，切回后保留原记录和同步基线', async function () {
    var e = buildEnv({}, serverResponder());
    await flush();
    await e.Storage.switchAccount({serverUrl: SERVER, username: 'alice'});
    await e.Storage.savePeriods([{start: '2026-09-01', end: '2026-09-05'}]);
    await e.Storage.saveSyncBase({periods: [], notes: {}, revision: 4});
    await e.Storage.switchAccount({serverUrl: SERVER, username: 'bob'});
    assert.strictEqual((await e.Storage.getPeriods()).length, 0);
    assert.strictEqual((await e.Storage.getMeta()).syncBase, null);
    await e.Storage.saveNotes({'2026-09-02': {text: 'bob'}});
    await e.Storage.switchAccount({serverUrl: SERVER, username: 'alice'});
    assert.strictEqual((await e.Storage.getPeriods())[0].start, '2026-09-01');
    assert.strictEqual(Object.keys(await e.Storage.getNotes()).length, 0);
    assert.strictEqual((await e.Storage.getMeta()).syncBase.revision, 4);
  });

  await test('不同服务器的同名账号不会共用记录', async function () {
    var e = buildEnv({}, serverResponder()); await flush();
    await e.Storage.switchAccount({serverUrl: SERVER, username: 'alice'});
    await e.Storage.saveNotes({'2026-09-01': {text: 'private'}});
    await e.Storage.switchAccount({serverUrl: 'https://other.example', username: 'alice'});
    assert.strictEqual(Object.keys(await e.Storage.getNotes()).length, 0);
  });

  await test('匿名记录不会静默上传到新登录账号', async function () {
    var e = buildEnv({periods: [{start: '2026-09-01'}]}, serverResponder());
    await flush();
    e._els['acct-server-url'].value = SERVER;
    e._els['acct-username'].value = 'bob';
    e._els['acct-password'].value = 'password123';
    e._els['btn-login'].dispatch('click'); await flush(150);
    var put = e._fetchCalls.find(function (c) { return c.method === 'PUT' && /\/api\/data$/.test(c.url); });
    assert.ok(put);
    assert.strictEqual(JSON.parse(put.body).periods.length, 0);
    // 匿名记录原样保留，没有在切换时删除。
    assert.strictEqual(JSON.parse(e._store['nebula-rosette:periods'])[0].start, '2026-09-01');
  });

  await test('两种存储都不可用时不提示保存成功，仍可导出内存记录', async function () {
    var e = buildEnv({}, serverResponder()); await flush();
    e.localStorage.setItem = function () { throw new Error('quota'); };
    e._els['btn-quick'].dispatch('click'); await flush(80);
    assert.ok(e._els['toast'].textContent.indexOf('保存失败') > -1);
    await assert.rejects(e.Storage.saveNotes({}), /保存失败/);
    e._els['btn-export'].dispatch('click'); await flush(80);
    assert.ok(e._downloads.length > 0);
  });

  await test('同步基线不会被较早读取的备注元数据覆盖', async function () {
    var e = buildEnv({}, serverResponder()); await flush();
    var old = await e.Storage.getMeta();
    await e.Storage.saveSyncBase({periods: [], notes: {}, revision: 9});
    await e.Storage.saveMeta(old);
    assert.strictEqual((await e.Storage.getMeta()).syncBase.revision, 9);
  });

  await test('网页入口的样式脚本是本地资源，并在离线缓存清单中', function () {
    assert.ok(html.includes('<script src="assets/tailwind.js"></script>'));
    assert.ok(fs.existsSync(path.join(ROOT, 'assets/tailwind.js')));
    assert.ok(fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8').includes("'assets/tailwind.js'"));
  });

  await test('同步请求等待期间新增记录不会被旧响应覆盖', async function () {
    var e = buildEnv({settings: {serverUrl: SERVER, token: 'tok-a', username: 'alice'}}, serverResponder());
    await flush(150);
    var release, pending, sent = [];
    e._setResponder(function (url, opts) {
      if (/\/api\/data$/.test(url) && opts.method === 'PUT') {
        var body = JSON.parse(opts.body); sent.push(body);
        if (!pending) {
          pending = true;
          return new Promise(function (resolve) { release = function () {
            resolve({ok: true, snapshot: {periods: body.periods, notes: body.notes, revision: 2}});
          }; });
        }
        return {ok: true, snapshot: {periods: body.periods, notes: body.notes, revision: 3}};
      }
      return {};
    });
    e._els['btn-sync-now'].dispatch('click'); await flush(60);
    assert.ok(release, '应已发出等待中的请求');
    e._els['btn-quick'].dispatch('click'); await flush(60);
    release(); await flush(1600);
    assert.strictEqual((await e.Storage.getPeriods()).length, 1);
    assert.strictEqual(sent.length, 2);
    assert.strictEqual(sent[1].periods.length, 1);
    assert.strictEqual(sent[1].syncBase.periods.length, 0);
  });

  await test('同步冲突不会显示同步完成或清掉本机编辑', async function () {
    var e = buildEnv({periods: [{start: '2026-09-01', end: '2026-09-05'}],
      settings: {serverUrl: SERVER, token: 'tok-a', username: 'alice'}}, serverResponder());
    await flush(150);
    e._setResponder(function () { return {__status: 409, detail: '记录冲突'}; });
    e._els['btn-sync-now'].dispatch('click'); await flush(100);
    assert.ok(e._els['sync-status'].textContent.includes('记录冲突'));
    assert.ok(!e._els['toast'].textContent.includes('同步完成'));
    assert.strictEqual((await e.Storage.getPeriods()).length, 1);
  });

  section('备份导入校验与确认');

  await test('不存在的日期和重复经期被拒绝，原记录不变', async function () {
    var e = buildEnv({periods: [{start: '2026-09-01'}]}, serverResponder()); await flush();
    var bad = [
      {periods: [{start: '2026-02-29'}]},
      {periods: [{start: '2026-04-31'}]},
      {periods: [{start: '2026-09-01', end: '2026-09-31'}]},
      {periods: [{start: '2026-09-01'}, {start: '2026-09-01'}]},
      {periods: [], notes: {'2026-02-30': {text: 'bad'}}}
    ];
    for (var data of bad) await assert.rejects(e.Storage.importAll(data));
    assert.strictEqual((await e.Storage.getPeriods())[0].start, '2026-09-01');
  });

  await test('预览支持闰年且不修改本机记录', async function () {
    var e = buildEnv({periods: [{start: '2026-09-01'}]}, serverResponder()); await flush();
    var preview = e.Storage.prepareImport({version: 2, periods: [{start: '2024-02-29'}], notes: {}});
    assert.strictEqual(preview.periods.length, 1);
    assert.strictEqual((await e.Storage.getPeriods())[0].start, '2026-09-01');
  });

  function importFile(e, payload) {
    e.FileReader = function () {
      this.readAsText = function () { this.result = JSON.stringify(payload); this.onload(); };
    };
    e._els['input-import'].dispatch('change', {target: {files: [{}], value: ''}});
  }

  await test('取消导入保留记录，确认框列出备份数量', async function () {
    var e = buildEnv({periods: [{start: '2026-09-01'}]}, serverResponder()); await flush();
    e._confirmResult = false;
    importFile(e, {version: 2, periods: [], notes: {'2026-10-01': {text: 'note'}}});
    await flush();
    assert.ok(e._confirms[0].includes('0 条经期记录、1 天备注'));
    assert.strictEqual((await e.Storage.getPeriods())[0].start, '2026-09-01');
    assert.ok(e._els['toast'].textContent.includes('已取消'));
  });

  await test('确认后才替换记录并显示成功', async function () {
    var e = buildEnv({periods: [{start: '2026-09-01'}]}, serverResponder()); await flush();
    importFile(e, {version: 2, periods: [{start: '2026-10-01'}], notes: {}});
    await flush(100);
    assert.strictEqual((await e.Storage.getPeriods())[0].start, '2026-10-01');
    assert.ok(e._els['toast'].textContent.includes('导入成功'));
  });

  await test('读取文件期间禁止编辑，读取失败后恢复操作', async function () {
    var e = buildEnv({}, serverResponder()); await flush();
    var reader;
    e.FileReader = function () { reader = this; this.readAsText = function () {}; };
    e._els['input-import'].dispatch('change', {target: {files: [{}], value: ''}});
    e._els['btn-quick'].dispatch('click'); await flush();
    assert.strictEqual((await e.Storage.getPeriods()).length, 0);
    reader.onerror();
    e._els['btn-quick'].dispatch('click'); await flush();
    assert.strictEqual((await e.Storage.getPeriods()).length, 1);
  });

  await test('period.js 的 SYMPTOMS 与 server 的 SYMPTOM_KEYS 完全一致', function () {
    var P = require(path.join(ROOT, 'js/period.js'));
    var py = fs.readFileSync(path.join(ROOT, 'server/main.py'), 'utf8');
    var m = /SYMPTOM_KEYS = \(([\s\S]*?)\)/.exec(py);
    assert.ok(m, '服务端未找到 SYMPTOM_KEYS');
    var serverKeys = (m[1].match(/"([a-z_]+)"/g) || []).map(function (s) {
      return s.replace(/"/g, '');
    });
    var frontKeys = P.SYMPTOMS.map(function (s) { return s.key; });
    assert.deepStrictEqual(frontKeys.slice().sort(), serverKeys.slice().sort(),
      '前端 ' + frontKeys.join(',') + ' vs 服务端 ' + serverKeys.join(','));
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})();
