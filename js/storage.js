/*
 * Nebula Rosette — 本地存储层
 *
 * 数据全部留在浏览器里，绝不上传。优先 IndexedDB，
 * 不可用时（隐私模式、老浏览器）自动退回 localStorage。
 */
(function (global) {
  'use strict';

  var DB_NAME = 'nebula-rosette';
  var DB_VERSION = 1;
  var STORE = 'kv';
  var LS_PREFIX = 'nebula-rosette:';

  var KEY_PERIODS = 'periods';
  var KEY_NOTES = 'notes';
  var KEY_SETTINGS = 'settings';

  var dbPromise = null;
  var scope = '';
  function scoped(key) {
    return key === KEY_SETTINGS || key === 'activeOwner' ? key : scope + key;
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!global.indexedDB) return reject(new Error('no indexedDB'));
      var req;
      try {
        req = global.indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        return reject(e);
      }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('indexedDB open failed')); };
      req.onblocked = function () { reject(new Error('indexedDB blocked')); };
    });
    return dbPromise;
  }

  function idbGet(key) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readonly');
        var req = tx.objectStore(STORE).get(key);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function idbSet(key, value) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('存储事务已中止')); };
      });
    });
  }

  function lsGet(key) {
    try {
      var raw = global.localStorage.getItem(LS_PREFIX + key);
      return raw == null ? undefined : JSON.parse(raw);
    } catch (e) {
      return undefined;
    }
  }

  function lsSet(key, value) {
    try {
      global.localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 统一读写入口：IndexedDB 失败即静默降级到 localStorage */
  function get(key, fallback) {
    key = scoped(key);
    var local = lsGet(key);
    if (local !== undefined) return Promise.resolve(local);
    return idbGet(key)
      .catch(function () { return lsGet(key); })
      .then(function (v) { return v === undefined || v === null ? fallback : v; });
  }

  function set(key, value) {
    key = scoped(key);
    return idbSet(key, value).then(function () {
      try { global.localStorage.removeItem(LS_PREFIX + key); } catch (e) {}
      return true;
    }).catch(function () {
      if (!lsSet(key, value)) throw new Error('保存失败：浏览器存储不可用或空间不足，请导出备份后重试');
      return true;
    });
  }

  function accountScope(session) {
    return session.username ? 'account:' + JSON.stringify([
      String(session.serverUrl || '').replace(/\/+$/, ''), session.username
    ]) + ':' : '';
  }

  // 旧数据仍留在原键下；首次升级只迁移到当时登录的账号。
  async function initializeScope(settings) {
    var owner = await get('activeOwner', null);
    if (owner !== null) {
      // 登录提交中断时，以持久化的凭据所属账号为准，不能把另一账号的记录配给旧 token。
      scope = settings.token && settings.username ? accountScope(settings) : owner;
      return;
    }
    var next = accountScope(settings);
    if (next) {
      var data = await Promise.all([getPeriods(), getNotes(), getMeta()]);
      scope = next;
      await Promise.all([savePeriods(data[0]), saveNotes(data[1]), saveMeta(data[2])]);
    }
    await set('activeOwner', scope);
  }

  async function switchAccount(session) {
    var next = accountScope(session);
    if (next === scope) return;
    // 每个账号有自己的记录和同步基线，不自动上传上一账号/匿名数据。
    await set('activeOwner', next);
    scope = next;
  }

  // ---------- 业务读写 ----------

  function getPeriods() {
    return get(KEY_PERIODS, []);
  }

  function savePeriods(periods) {
    return set(KEY_PERIODS, periods);
  }

  function getNotes() {
    return get(KEY_NOTES, {});
  }

  function saveNotes(notes) {
    return set(KEY_NOTES, notes);
  }

  // ---------- 同步元数据 ----------
  // 逐条合并需要知道「每条记录在本机的最后修改时间」，以及
  // 「哪些记录被删过」——合并模式下"没上报"不等于"已删除"，
  // 不显式记下删除，同步一次就会把删掉的记录从服务端复活。

  var KEY_META = 'syncmeta';

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /**
   * 与服务端 updated_at 同格式的 UTC 时间戳 "YYYY-MM-DD HH:MM:SS"。
   *
   * 必须用 UTC 而不是本地时间：服务端按字符串比较判新旧，多设备分处不同
   * 时区时，本地时间字符串的先后不等于真实修改的先后——东八区本地 20:00
   * 的修改会"赢过"西五区本地 08:00 的修改，尽管后者实际晚了 1 小时。
   * 格式保持不变，所以和服务端 datetime('now')（UTC）以及已存的值仍可
   * 直接按字符串比较。已知局限：升级前已存的本地时间戳无法追溯换算，
   * 仍按旧规则比较，时区偏东的设备在升级后数小时内个别备注可能仍按旧
   * 时间戳判旧；该路径只影响不带 syncBase 的旧版同步，新版三路合并
   * 不依赖时间戳。
   */
  function stamp(d) {
    d = d || new Date();
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) + ' ' +
      pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds());
  }

  function getMeta() {
    return Promise.all([get(KEY_META, {}), get('syncBase', null)]).then(function (values) {
      var m = values[0];
      return {
        noteTimes: (m && m.noteTimes) || {},
        syncBase: values[1],
        deletedNotes: (m && m.deletedNotes) || [],
        deletedPeriods: (m && m.deletedPeriods) || []
      };
    });
  }

  function saveMeta(meta) {
    var copy = Object.assign({}, meta);
    delete copy.syncBase;
    return set(KEY_META, copy);
  }

  function saveSyncBase(base) {
    return set('syncBase', base);
  }

  /** 记下某天备注刚被改过 */
  function touchNote(date) {
    return getMeta().then(function (m) {
      m.noteTimes[date] = stamp();
      // 改回来了就不该再算作已删除
      m.deletedNotes = m.deletedNotes.filter(function (d) { return d !== date; });
      return saveMeta(m).then(function () { return m; });
    });
  }

  function markNoteDeleted(date) {
    return getMeta().then(function (m) {
      delete m.noteTimes[date];
      if (m.deletedNotes.indexOf(date) === -1) m.deletedNotes.push(date);
      return saveMeta(m).then(function () { return m; });
    });
  }

  function markPeriodDeleted(start) {
    return getMeta().then(function (m) {
      if (m.deletedPeriods.indexOf(start) === -1) m.deletedPeriods.push(start);
      return saveMeta(m).then(function () { return m; });
    });
  }

  /** 推送成功后清掉删除队列——服务端已经知道了，再带上就是浪费 */
  function clearDeletions() {
    return getMeta().then(function (m) {
      m.deletedNotes = [];
      m.deletedPeriods = [];
      return saveMeta(m);
    });
  }

  /** 从服务端拉回来后，把对方的时间戳作为本地基线 */
  function mergeNoteTimes(remoteTimes) {
    return getMeta().then(function (m) {
      Object.keys(remoteTimes || {}).forEach(function (k) {
        var cur = m.noteTimes[k];
        if (!cur || remoteTimes[k] > cur) m.noteTimes[k] = remoteTimes[k];
      });
      return saveMeta(m).then(function () { return m; });
    });
  }

  var DEFAULT_SETTINGS = {
    // 账号 / 同步
    serverUrl: '',           // 后端地址；为空则纯本地模式
    token: '',               // 登录会话 token，仅存本机
    username: '',
    nickname: '',

    // AI
    aiEnabled: false,        // 默认关闭，用户主动开启才会有任何网络请求
    aiMode: 'server',        // server = 走已登录的后端（key 在服务端）；direct = 浏览器直连
    baseUrl: '',             // direct 模式：OpenAI 兼容 Base URL
    model: '',               // direct 模式：模型名（大小写敏感）
    apiKey: '',              // direct 模式：仅存本机，绝不随导出外传

    // 外观
    calBg: true,             // 日历背景图
    themeMode: 'auto',       // auto | light | dark
    theme: 'rosette',

    // 提醒
    reminderDismissed: ''    // 当天关掉后不再弹，存 YYYY-MM-DD
  };

  function getSettings() {
    return get(KEY_SETTINGS, {}).then(function (s) {
      var out = {};
      Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
        out[k] = (s && s[k] !== undefined) ? s[k] : DEFAULT_SETTINGS[k];
      });
      return out;
    });
  }

  function saveSettings(settings) {
    return set(KEY_SETTINGS, settings);
  }

  // ---------- 备份格式 ----------

  /**
   * 当前备份格式版本。
   *
   * 从 1 升到 2 的理由：v1 是在只有「流量 / 痛感 / 文字备注」的时候定的，
   * 后来加了 `symptoms` 数组，字段变了但版本号没动——导出的文件确实带症状，
   * 可是从版本号上分不出手里这份到底有没有。等到下次再加字段就彻底没有分界点了，
   * 只能靠猜字段是否存在。
   *
   * v2 明确约定：`notes[date]` 是 `{flow, pain, symptoms, text}`，
   * `symptoms` 一定是数组（可以为空）。导入 v1 时补齐成这个形状。
   */
  var BACKUP_VERSION = 2;

  /** 已知的备注字段。导入时只保留这些，避免把别的应用的字段一路带进库里。 */
  var NOTE_FIELDS = ['flow', 'pain', 'symptoms', 'text'];
  var FLOW_VALUES = ['light', 'medium', 'heavy'];

  /**
   * 把任意来源的一条备注收敛成 v2 的形状。
   *
   * 刻意做得宽容而不是报错：备份文件是用户手里唯一的数据副本，
   * 因为一条 `pain: "3"`（字符串）就拒绝整份导入，代价远大于收益。
   * 但也不无脑照搬——非法的流量值、超范围的痛感、不认识的症状 key
   * 会被丢掉，否则脏值会一路流进统计和图表里。
   * 返回 null 表示这条没有任何有效内容，调用方应该整条丢掉。
   */
  function normalizeNote(raw) {
    if (!raw || typeof raw !== 'object') return null;

    var flow = FLOW_VALUES.indexOf(raw.flow) > -1 ? raw.flow : null;

    var pain = null;
    var pn = Number(raw.pain);
    if (isFinite(pn) && pn >= 1 && pn <= 5) pain = Math.round(pn);

    var syms = [];
    if (Array.isArray(raw.symptoms)) {
      // period.js 是唯一的症状真相来源。它在 storage.js 之前加载，
      // 但仍然容错处理：拿不到就只做去重，不因此丢掉用户的症状数据。
      var core = global.PeriodCore;
      var known = core && core.SYMPTOMS
        ? core.SYMPTOMS.map(function (s) { return s.key; })
        : null;
      raw.symptoms.forEach(function (k) {
        if (typeof k !== 'string') return;
        if (known && known.indexOf(k) === -1) return;
        if (syms.indexOf(k) === -1) syms.push(k);
      });
    }

    var text = (typeof raw.text === 'string' && raw.text.trim()) ? raw.text.trim() : null;

    if (!flow && !pain && !syms.length && !text) return null;
    return { flow: flow, pain: pain, symptoms: syms, text: text };
  }

  /**
   * 导出为可读 JSON（用户完全掌控自己的数据）。
   * 只导出周期与备注；AI 配置尤其 apiKey 一律不导出，
   * 否则用户把备份发给别人就等于把 key 一起发出去了。
   */
  function exportAll() {
    return Promise.all([getPeriods(), getNotes(), getSettings()]).then(function (r) {
      var notes = {};
      Object.keys(r[1] || {}).forEach(function (k) {
        var n = normalizeNote(r[1][k]);
        if (n) notes[k] = n;
      });
      return {
        app: 'Nebula Rosette',
        version: BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        periods: (r[0] || []).map(function (p) {
          return { start: p.start, end: p.end || null };
        }),
        notes: notes,
        settings: { theme: r[2].theme }
      };
    });
  }

  /**
   * 导入 JSON。校验失败时抛错，绝不静默清空用户已有数据。
   *
   * 版本处理：v1 和 v2 的差别只在 `notes` 的形状，周期部分完全一样，
   * 所以不需要一条条迁移脚本——`normalizeNote` 对两个版本都能收敛出 v2 形状。
   * 比当前版本更新的文件直接拒绝：那意味着里面有这个版本读不懂的字段，
   * 导进来只会静默丢数据，不如让用户去用新版本打开。
   */
  function prepareImport(payload) {
    function reject(err) { throw err; }
      if (!payload || typeof payload !== 'object') return reject(new Error('文件格式不正确'));

      var ver = payload.version === undefined ? 1 : payload.version;
      if (typeof ver !== 'number' || !isFinite(ver) || ver < 1) {
        return reject(new Error('备份版本号不正确'));
      }
      if (ver > BACKUP_VERSION) {
        return reject(new Error('这份备份来自更新的版本（v' + ver +
          '），当前最高支持 v' + BACKUP_VERSION + '，请升级后再导入'));
      }

      if (!Array.isArray(payload.periods)) return reject(new Error('缺少 periods 字段'));
      var valid = payload.periods.every(function (p) {
        return p && validDate(p.start);
      });
      if (!valid) return reject(new Error('periods 中有非法日期'));
      if (new Set(payload.periods.map(function (p) { return p.start; })).size !== payload.periods.length) {
        throw new Error('备份中有重复的经期开始日期，请核对后再导入');
      }

      var periods = payload.periods.map(function (p) {
        if (p.end && !validDate(p.end)) throw new Error('备份中有不存在的结束日期');
        var end = (typeof p.end === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.end)) ? p.end : null;
        // 结束日早于开始日的脏数据当成「没标结束」，而不是整份拒绝
        if (end && end < p.start) end = null;
        return { start: p.start, end: end };
      });

      var srcNotes = (payload.notes && typeof payload.notes === 'object') ? payload.notes : {};
      var notes = {};
      Object.keys(srcNotes).forEach(function (k) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) return;   // 非日期键一律丢掉
        if (!validDate(k)) throw new Error('备注日期不存在：' + k);
        var n = normalizeNote(srcNotes[k]);
        if (n) notes[k] = n;
      });

      return {version: ver, periods: periods, notes: notes};
  }

  function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    var parts = value.split('-').map(Number);
    if (parts[0] < 1) return false;
    var date = new Date(0);
    date.setUTCFullYear(parts[0], parts[1] - 1, parts[2]);
    return date.getUTCFullYear() === parts[0] && date.getUTCMonth() === parts[1] - 1 && date.getUTCDate() === parts[2];
  }

  function importAll(payload) {
    return Promise.resolve().then(function () {
      var prepared = prepareImport(payload);
      var periods = prepared.periods, notes = prepared.notes, ver = prepared.version;
      return Promise.all([savePeriods(periods), saveNotes(notes)]).then(function () {
        return { version: ver, periods: periods.length,
          notes: Object.keys(notes).length, upgraded: ver < BACKUP_VERSION };
      });
    });
  }

  function clearAll() {
    return Promise.all([savePeriods([]), saveNotes({}), saveMeta({
      noteTimes: {}, deletedNotes: [], deletedPeriods: []
    })]);
  }

  global.Storage = {
    prepareImport: prepareImport,
    saveSyncBase: saveSyncBase,
    initializeScope: initializeScope,
    switchAccount: switchAccount,
    getPeriods: getPeriods,
    savePeriods: savePeriods,
    getNotes: getNotes,
    saveNotes: saveNotes,
    getSettings: getSettings,
    saveSettings: saveSettings,
    exportAll: exportAll,
    importAll: importAll,
    BACKUP_VERSION: BACKUP_VERSION,
    normalizeNote: normalizeNote,
    clearAll: clearAll,
    stamp: stamp,
    getMeta: getMeta,
    saveMeta: saveMeta,
    touchNote: touchNote,
    markNoteDeleted: markNoteDeleted,
    markPeriodDeleted: markPeriodDeleted,
    clearDeletions: clearDeletions,
    mergeNoteTimes: mergeNoteTimes,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.Storage;
})(typeof globalThis !== 'undefined' ? globalThis : this);
