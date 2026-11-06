/*
 * Nebula Rosette — 服务端 API 客户端
 *
 * 只在用户填了服务器地址并登录后才发请求。未登录时整个应用离线可用。
 */
(function (global) {
  'use strict';

  var session = {
    serverUrl: '',
    token: '',
    username: '',
    nickname: ''
  };

  function normBase(url) {
    return String(url || '').trim().replace(/\/+$/, '');
  }

  function configure(cfg) {
    session.serverUrl = normBase(cfg && cfg.serverUrl);
    session.token = (cfg && cfg.token) || '';
    session.username = (cfg && cfg.username) || '';
    session.nickname = (cfg && cfg.nickname) || '';
  }

  function isLoggedIn() {
    return !!(session.serverUrl && session.token);
  }

  function getSession() {
    return {
      serverUrl: session.serverUrl,
      token: session.token,
      username: session.username,
      nickname: session.nickname
    };
  }

  /**
   * 统一请求：超时、错误信息提取、401 自动清 token。
   *
   * opts.credentialCheck —— 这个接口的 401 表示「你刚填的密码/恢复码不对」，
   * 不是「登录过期」。少了这个标记，改密码或生成恢复码时输错一次，
   * 就会把有效的登录态一起清掉，用户莫名被登出。
   */
  function request(method, path, body, opts) {
    opts = opts || {};
    var base = normBase(opts.serverUrl || session.serverUrl);
    if (!base) return Promise.reject(new Error('还没填服务器地址'));

    var headers = { 'Content-Type': 'application/json' };
    var token = opts.token !== undefined ? opts.token : session.token;
    if (token) headers.Authorization = 'Bearer ' + token;

    var ctrl = new AbortController();
    var timeout = opts.timeout || 20000;
    var timer = setTimeout(function () { ctrl.abort(); }, timeout);

    return fetch(base + path, {
      method: method,
      headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal
    }).then(function (res) {
      return res.text().then(function (raw) {
        var data = null;
        if (raw) { try { data = JSON.parse(raw); } catch (e) { data = null; } }
        if (!res.ok) {
          if (res.status === 401 && token === session.token && !opts.credentialCheck) {
            session.token = '';
          }
          var detail = data && (data.detail || data.message);
          if (Array.isArray(detail)) {
            detail = detail.map(function (d) { return d && d.msg; }).filter(Boolean).join('；');
          }
          var err = new Error(detail || ('请求失败（' + res.status + '）'));
          err.status = res.status;
          throw err;
        }
        return data;
      });
    }).catch(function (err) {
      if (err && err.name === 'AbortError') throw new Error('请求超时，检查服务器地址是否可达');
      if (err && err.message === 'Failed to fetch') {
        throw new Error('连不上服务器。若页面是 file:// 打开的，请改用 http 访问');
      }
      throw err;
    }).then(function (r) { clearTimeout(timer); return r; },
      function (e) { clearTimeout(timer); throw e; });
  }

  // ---------- 账号 ----------

  function register(serverUrl, username, password, nickname) {
    return request('POST', '/api/auth/register',
      { username: username, password: password, nickname: nickname || null },
      { serverUrl: serverUrl, token: '' }
    ).then(function (data) {
      configure({ serverUrl: serverUrl, token: data.token,
        username: data.username, nickname: data.nickname });
      return data;
    });
  }

  function login(serverUrl, username, password) {
    return request('POST', '/api/auth/login',
      { username: username, password: password },
      { serverUrl: serverUrl, token: '' }
    ).then(function (data) {
      configure({ serverUrl: serverUrl, token: data.token,
        username: data.username, nickname: data.nickname });
      return data;
    });
  }

  function logout() {
    if (!isLoggedIn()) return Promise.resolve();
    return request('POST', '/api/auth/logout').catch(function () {
      // 服务端不可达也要让本地登出，否则用户被卡在登录态里
      return null;
    }).then(function () {
      session.token = '';
      session.username = '';
      session.nickname = '';
    });
  }

  function me() {
    return request('GET', '/api/auth/me');
  }

  function health(serverUrl) {
    return request('GET', '/api/health', undefined,
      { serverUrl: serverUrl, token: '', timeout: 8000 });
  }

  // ---------- 数据同步 ----------

  function pull() {
    return request('GET', '/api/data');
  }

  /**
   * 逐条合并推送。meta 带上每条备注的本地修改时间与删除队列——
   * 服务端靠时间戳判新旧，靠删除队列区分「删了」和「这次没带」。
   */
  function push(periods, notes, meta) {
    meta = meta || {};
    return request('PUT', '/api/data', {
      periods: periods,
      notes: notes,
      syncBase: meta.syncBase || { periods: [], notes: {} },
      noteTimes: meta.noteTimes || {},
      deletedNotes: meta.deletedNotes || [],
      deletedPeriods: meta.deletedPeriods || []
    });
  }

  /** 整表替换。只在导入备份后需要让服务端与本地完全一致时用。 */
  function replaceAll(periods, notes) {
    return request('PUT', '/api/data/replace', { periods: periods, notes: notes });
  }

  // ---------- 账号 ----------

  function changePassword(oldPassword, newPassword, logoutOthers) {
    // credentialCheck：401 在这里意味着「旧密码输错了」，不该顺手把登录态清掉
    return request('POST', '/api/auth/change-password', {
      old_password: oldPassword,
      new_password: newPassword,
      logout_others: logoutOthers !== false
    }, { credentialCheck: true });
  }

  function updateProfile(nickname) {
    return request('PUT', '/api/auth/profile', { nickname: nickname || null })
      .then(function (data) {
        session.nickname = data.nickname || '';
        return data;
      });
  }

  /** 当前账号还有效的登录会话（设备列表） */
  function listSessions() {
    return request('GET', '/api/auth/sessions');
  }

  /** 远程登出某台设备。id 是 listSessions 返回的短 id，不是完整 token 哈希。 */
  function revokeSession(id) {
    return request('DELETE', '/api/auth/sessions/' + encodeURIComponent(id));
  }

  // ---------- 注销账号 ----------

  /**
   * 彻底删除账号。要密码 + 手打用户名两道确认——这是不可逆操作，
   * 而设置页里它和「清空数据」挨着，单靠一个 confirm 弹窗太容易误触。
   *
   * 成功后立刻把本地会话清掉：token 已经随账号一起失效，留着只会让
   * 后续每个请求都撞 401。
   */
  function deleteAccount(password, confirmUsername) {
    return request('POST', '/api/auth/delete-account',
      { password: password, confirm_username: confirmUsername },
      { credentialCheck: true }
    ).then(function (data) {
      configure({ token: '', username: '', nickname: '' });
      return data;
    });
  }

  // ---------- 恢复码 ----------

  /** 还剩几个可用的恢复码 */
  function recoveryStatus() {
    return request('GET', '/api/auth/recovery');
  }

  /** 生成新一批。明文只在这一次响应里出现，之后服务端只有哈希。 */
  function generateRecoveryCodes(password) {
    return request('POST', '/api/auth/recovery', { password: password },
      { credentialCheck: true });
  }

  /**
   * 用恢复码重设密码。这是未登录状态下的操作，所以显式传 serverUrl 并清空
   * token —— 走「忘记密码」时本机通常没有有效 token，带上只会触发 401 清理。
   */
  function resetWithRecoveryCode(serverUrl, username, code, newPassword) {
    return request('POST', '/api/auth/recovery/reset',
      { username: username, code: code, new_password: newPassword },
      { serverUrl: serverUrl, token: '' }
    ).then(function (data) {
      configure({ serverUrl: serverUrl, token: data.token,
        username: data.username, nickname: data.nickname });
      return data;
    });
  }

  // ---------- AI ----------

  function chat(question, cycle) {
    return request('POST', '/api/chat', { question: question, cycle: cycle },
      { timeout: 35000 });
  }

  /** 账号自存的 AI 配置（Key 在服务端加密保存，这里拿不到明文） */
  function getAiConfig() {
    return request('GET', '/api/ai-config');
  }

  function saveAiConfig(baseUrl, model, apiKey) {
    var body = { base_url: baseUrl || null, model: model || null };
    // 只有用户真的输入了新 Key 才上传；留空表示沿用已保存的
    if (apiKey) body.api_key = apiKey;
    return request('PUT', '/api/ai-config', body);
  }

  function deleteAiConfig() {
    return request('DELETE', '/api/ai-config');
  }

  global.Api = {
    configure: configure,
    getSession: getSession,
    isLoggedIn: isLoggedIn,
    register: register,
    login: login,
    logout: logout,
    me: me,
    health: health,
    pull: pull,
    push: push,
    replaceAll: replaceAll,
    changePassword: changePassword,
    updateProfile: updateProfile,
    listSessions: listSessions,
    revokeSession: revokeSession,
    recoveryStatus: recoveryStatus,
    generateRecoveryCodes: generateRecoveryCodes,
    resetWithRecoveryCode: resetWithRecoveryCode,
    deleteAccount: deleteAccount,
    chat: chat,
    getAiConfig: getAiConfig,
    saveAiConfig: saveAiConfig,
    deleteAiConfig: deleteAiConfig,
    normBase: normBase
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.Api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
