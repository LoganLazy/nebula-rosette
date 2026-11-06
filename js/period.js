/*
 * Nebula Rosette — 周期计算核心
 *
 * 设计约定：
 * 1. 所有日期一律用本地 "YYYY-MM-DD" 字符串，绝不使用 UTC datetime，
 *    避免东八区用户在晚上标记时被记到前一天。
 * 2. 预测置信度与稳定性判断共用同一份 CV 阈值表（CV_BANDS），
 *    保证不会出现"置信度 low 但稳定性显示规律"的自相矛盾提示。
 * 3. 周期长度用中位数而非均值，并过滤离群周期，
 *    避免一个异常长周期把预测拖偏两周。
 */
(function (global) {
  'use strict';

  // 临床上常见的正常周期范围，超出此范围视为离群值（漏记/异常周期）
  var MIN_CYCLE = 21;
  var MAX_CYCLE = 45;

  // 经期本身的合理天数。超出这个范围的记录不参与「持续天数」统计：
  // 1 天通常是忘了标结束，20 天以上通常是忘了标而一直挂着。
  var MIN_BLEED = 2;
  var MAX_BLEED = 12;
  var DEFAULT_BLEED = 5;

  /**
   * 症状标签的唯一定义（key 与 server/main.py 的 SYMPTOM_KEYS 必须一致，
   * 有测试断言两边相等）。
   *
   * 用固定枚举而不是自由输入：自由文本会把「头疼」和「头痛」算成两回事，
   * 统计立刻失去意义；而且输入框在手机上比点选慢得多，
   * 记录类应用里每多一步操作都会掉记录率。
   */
  var SYMPTOMS = [
    { key: 'cramps', label: '腹痛', emoji: '🤕' },
    { key: 'headache', label: '头痛', emoji: '🤯' },
    { key: 'bloating', label: '腹胀', emoji: '🎈' },
    { key: 'backache', label: '腰酸', emoji: '🦴' },
    { key: 'breast_tenderness', label: '胸胀', emoji: '💗' },
    { key: 'nausea', label: '恶心', emoji: '🤢' },
    { key: 'fatigue', label: '疲倦', emoji: '😴' },
    { key: 'acne', label: '长痘', emoji: '🔴' },
    { key: 'mood_swings', label: '情绪起伏', emoji: '🌀' },
    { key: 'anxiety', label: '焦虑', emoji: '😰' },
    { key: 'insomnia', label: '失眠', emoji: '🌙' },
    { key: 'appetite', label: '食欲变化', emoji: '🍫' }
  ];

  var SYMPTOM_LABEL = {};
  SYMPTOMS.forEach(function (s) { SYMPTOM_LABEL[s.key] = s.label; });

  /** 过滤掉未知 key，避免旧数据或手改的备份污染统计 */
  function normSymptoms(list) {
    if (!list || !list.length) return [];
    var out = [];
    list.forEach(function (k) {
      if (SYMPTOM_LABEL[k] && out.indexOf(k) === -1) out.push(k);
    });
    return out;
  }

  /**
   * 唯一的变异系数阈值表 —— 预测置信度与稳定性判断都从这里取值。
   * cvMax: 上界（含）；window: 预测窗口 ±天数
   */
  var CV_BANDS = [
    {
      cvMax: 0.08,
      status: 'very_regular',
      confidence: 'high',
      window: 2,
      label: '非常规律',
      message: '你的周期非常规律，继续保持好习惯！'
    },
    {
      cvMax: 0.15,
      status: 'regular',
      confidence: 'medium',
      window: 3,
      label: '比较规律',
      message: '周期比较规律，略有波动属于正常。'
    },
    {
      cvMax: 0.30,
      status: 'irregular',
      confidence: 'low',
      window: 5,
      label: '有些波动',
      message: '周期有些波动，注意作息和压力管理。'
    },
    {
      cvMax: Infinity,
      status: 'very_irregular',
      confidence: 'low',
      window: 7,
      label: '很不规律',
      message: '周期波动较大，如持续如此建议咨询医生。'
    }
  ];

  function bandForCv(cv) {
    for (var i = 0; i < CV_BANDS.length; i++) {
      if (cv <= CV_BANDS[i].cvMax) return CV_BANDS[i];
    }
    return CV_BANDS[CV_BANDS.length - 1];
  }

  function bandIndex(band) {
    for (var i = 0; i < CV_BANDS.length; i++) {
      if (CV_BANDS[i] === band) return i;
    }
    return CV_BANDS.length - 1;
  }

  /**
   * 离群周期本身就是"不规律"的证据。
   * 若不做这层修正，把 21~45 天之外的周期全过滤掉后，
   * 一个真正紊乱的用户会因为剩下的少数样本一致而被判成"非常规律"。
   * 规则：有离群周期至少降到"有些波动"；离群占比 >= 1/3 直接判"很不规律"。
   */
  function applyOutlierPenalty(band, dropped, total) {
    if (!dropped || !total) return band;
    var floorIdx = (dropped / total >= 1 / 3) ? 3 : 2;
    return bandIndex(band) >= floorIdx ? band : CV_BANDS[floorIdx];
  }

  // ---------- 日期工具（全部基于本地日期字符串） ----------

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  /** Date 对象 -> "YYYY-MM-DD"（取本地年月日） */
  function toKey(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /** "YYYY-MM-DD" -> 本地零点的 Date 对象 */
  function parseKey(key) {
    var p = String(key).split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  function todayKey() {
    return toKey(new Date());
  }

  /** 日期偏移，返回新的日期字符串 */
  function addDays(key, n) {
    var d = parseKey(key);
    d.setDate(d.getDate() + n);
    return toKey(d);
  }

  /** b - a 的天数（正数表示 b 在 a 之后） */
  function diffDays(a, b) {
    // 用 UTC 毫秒做差可规避夏令时导致的 23/25 小时问题
    var da = parseKey(a);
    var db = parseKey(b);
    var ua = Date.UTC(da.getFullYear(), da.getMonth(), da.getDate());
    var ub = Date.UTC(db.getFullYear(), db.getMonth(), db.getDate());
    return Math.round((ub - ua) / 86400000);
  }

  function isBetween(key, startKey, endKey) {
    return diffDays(startKey, key) >= 0 && diffDays(key, endKey) >= 0;
  }

  // ---------- 统计工具 ----------

  function median(arr) {
    if (!arr.length) return 0;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function mean(arr) {
    if (!arr.length) return 0;
    var sum = 0;
    for (var i = 0; i < arr.length; i++) sum += arr[i];
    return sum / arr.length;
  }

  /** 样本标准差（n-1）；样本量 < 2 时返回 0 */
  function stdDev(arr) {
    if (arr.length < 2) return 0;
    var m = mean(arr);
    var acc = 0;
    for (var i = 0; i < arr.length; i++) acc += Math.pow(arr[i] - m, 2);
    return Math.sqrt(acc / (arr.length - 1));
  }

  function round1(n) {
    return Math.round(n * 10) / 10;
  }

  // ---------- 周期数据处理 ----------

  /** 按开始日期升序排序，并剔除无 start 的脏数据 */
  function sortPeriods(periods) {
    return (periods || [])
      .filter(function (p) { return p && p.start; })
      .slice()
      .sort(function (a, b) { return diffDays(b.start, a.start); });
  }

  /**
   * 计算相邻两次经期开始日之间的间隔（周期长度），按时间升序返回。
   */
  function cycleLengths(periods) {
    var sorted = sortPeriods(periods);
    var out = [];
    for (var i = 1; i < sorted.length; i++) {
      out.push(diffDays(sorted[i - 1].start, sorted[i].start));
    }
    return out;
  }

  /** 过滤离群周期；若全部被过滤掉则退回原始数据，避免无数据可用 */
  function filterOutliers(lengths) {
    var kept = lengths.filter(function (n) { return n >= MIN_CYCLE && n <= MAX_CYCLE; });
    return kept.length ? kept : lengths.slice();
  }

  /** 取最近 n 个周期（lengths 为时间升序） */
  function recentLengths(lengths, n) {
    return lengths.slice(Math.max(0, lengths.length - n));
  }

  /**
   * 已结束的经期各自持续了几天（含首尾），按时间升序。
   * 进行中的经期没有 end，不参与统计。
   */
  function bleedLengths(periods) {
    var out = [];
    sortPeriods(periods).forEach(function (p) {
      if (!p.end) return;
      var n = diffDays(p.start, p.end) + 1;
      if (n >= MIN_BLEED && n <= MAX_BLEED) out.push(n);
    });
    return out;
  }

  /**
   * 预测经期会持续几天。用中位数，跟周期长度预测保持同一套做法。
   * 没有足够样本时退回 DEFAULT_BLEED 并标 estimated，不假装有依据。
   */
  function predictBleedLength(periods) {
    var lens = bleedLengths(periods);
    if (!lens.length) {
      return { days: DEFAULT_BLEED, estimated: true, sampleSize: 0 };
    }
    var used = recentLengths(lens, 6);
    return {
      days: Math.round(median(used)),
      estimated: false,
      sampleSize: used.length,
      minDays: Math.min.apply(null, used),
      maxDays: Math.max.apply(null, used)
    };
  }

  /**
   * 预测下次经期。
   * @returns {{available:boolean, predictedDate?:string, confidence?:string,
   *            window?:{start:string,end:string}, medianCycleLength?:number,
   *            stdDev?:number, cv?:number, daysUntil?:number,
   *            outliersDropped?:number, message?:string}}
   */
  function predictNext(periods) {
    var sorted = sortPeriods(periods);
    if (sorted.length === 0) {
      return { available: false, message: '还没有记录，标记一次经期开始就能开始预测。' };
    }

    var lastStart = sorted[sorted.length - 1].start;
    var raw = cycleLengths(sorted);

    if (raw.length === 0) {
      // 只有一次记录：用 28 天典型值给个粗略参考，明确标注低置信度
      var fallback = addDays(lastStart, 28);
      var fbBleed = predictBleedLength(sorted);
      return {
        available: true,
        estimated: true,
        predictedDate: fallback,
        confidence: 'low',
        window: { start: addDays(fallback, -7), end: addDays(fallback, 7) },
        medianCycleLength: 28,
        stdDev: 0,
        cv: null,
        daysUntil: diffDays(todayKey(), fallback),
        outliersDropped: 0,
        bleedDays: fbBleed.days,
        bleedEstimated: fbBleed.estimated,
        message: '只有 1 次记录，按 28 天典型周期粗略估算，再记录 1~2 次会准很多。'
      };
    }

    var clean = filterOutliers(raw);
    var used = recentLengths(clean, 6);
    var med = median(used);
    var sd = stdDev(used);
    var cv = med > 0 ? sd / med : 0;
    var dropped = raw.length - clean.length;
    var band = applyOutlierPenalty(bandForCv(cv), dropped, raw.length);
    var predicted = addDays(lastStart, Math.round(med));
    var bleed = predictBleedLength(sorted);

    return {
      available: true,
      estimated: false,
      predictedDate: predicted,
      confidence: band.confidence,
      window: {
        start: addDays(predicted, -band.window),
        end: addDays(predicted, band.window)
      },
      medianCycleLength: round1(med),
      stdDev: round1(sd),
      cv: Math.round(cv * 1000) / 1000,
      daysUntil: diffDays(todayKey(), predicted),
      outliersDropped: dropped,
      sampleSize: used.length,
      bleedDays: bleed.days,
      bleedEstimated: bleed.estimated,
      bleedSampleSize: bleed.sampleSize
    };
  }

  /**
   * 判断周期稳定性。至少需要 3 次经期记录（即 2 个完整周期）才有意义。
   */
  function assessStability(periods) {
    var raw = cycleLengths(periods);
    if (raw.length < 2) {
      return {
        available: false,
        status: 'unknown',
        label: '数据不足',
        message: '至少需要 3 次经期记录才能判断周期稳定性。'
      };
    }

    var clean = filterOutliers(raw);
    var used = recentLengths(clean, 6);
    var med = median(used);
    var avg = mean(used);
    var sd = stdDev(used);
    var cv = med > 0 ? sd / med : 0;
    var dropped = raw.length - clean.length;
    var band = applyOutlierPenalty(bandForCv(cv), dropped, raw.length);

    return {
      available: true,
      status: band.status,
      label: band.label,
      message: band.message,
      cv: Math.round(cv * 1000) / 1000,
      medianLength: round1(med),
      avgLength: round1(avg),
      stdDev: round1(sd),
      minLength: Math.min.apply(null, used),
      maxLength: Math.max.apply(null, used),
      sampleSize: used.length,
      outliersDropped: dropped
    };
  }

  /**
   * 判断某一天所处的周期阶段，用于每日小贴士。
   * 返回 phase: menstrual | follicular | ovulation | luteal | unknown
   */
  function phaseOn(periods, dateKey) {
    var sorted = sortPeriods(periods);
    if (!sorted.length) return { phase: 'unknown', dayOfCycle: null };

    // 是否落在某次已记录的经期内
    for (var i = 0; i < sorted.length; i++) {
      var p = sorted[i];
      var end = p.end || addDays(p.start, 4); // 未记结束时按 5 天估算
      if (isBetween(dateKey, p.start, end)) {
        return {
          phase: 'menstrual',
          dayOfCycle: diffDays(p.start, dateKey) + 1,
          periodDay: diffDays(p.start, dateKey) + 1
        };
      }
    }

    // 找到该日期之前最近的一次经期开始
    var lastStart = null;
    for (var j = sorted.length - 1; j >= 0; j--) {
      if (diffDays(sorted[j].start, dateKey) >= 0) { lastStart = sorted[j].start; break; }
    }
    if (!lastStart) return { phase: 'unknown', dayOfCycle: null };

    var dayOfCycle = diffDays(lastStart, dateKey) + 1;
    var pred = predictNext(sorted);
    var cycleLen = pred.available ? pred.medianCycleLength : 28;
    var ovulationDay = Math.round(cycleLen) - 14; // 黄体期长度相对恒定

    var phase;
    if (dayOfCycle >= ovulationDay - 2 && dayOfCycle <= ovulationDay + 2) {
      phase = 'ovulation';
    } else if (dayOfCycle < ovulationDay) {
      phase = 'follicular';
    } else {
      phase = 'luteal';
    }
    return { phase: phase, dayOfCycle: dayOfCycle, cycleLength: cycleLen };
  }

  /**
   * 为日历渲染准备的每日标记。
   * @returns {Object} key -> {
   *   period, periodDay, ongoing, segStart, segEnd,   // 经期（segStart/segEnd 用于连续段圆角）
   *   predicted, predictedCore, predStart, predEnd,   // 预测窗口
   *   fertileWindow,                                  // 排卵期前后（仅用于视觉层次）
   *   note, flow, pain                                // 每日记录
   * }
   */
  function buildDayMarks(periods, prediction, notes) {
    var marks = {};
    function ensure(k) {
      if (!marks[k]) marks[k] = {};
      return marks[k];
    }

    var sorted = sortPeriods(periods);
    sorted.forEach(function (p) {
      var end = p.end || p.start;
      var span = Math.max(0, diffDays(p.start, end));
      for (var i = 0; i <= span; i++) {
        var k = addDays(p.start, i);
        var m = ensure(k);
        m.period = true;
        m.periodDay = i + 1;
        m.ongoing = !p.end;
        m.segStart = (i === 0);
        m.segEnd = (i === span);
      }
    });

    if (prediction && prediction.available && prediction.window) {
      var w = prediction.window;
      var wl = diffDays(w.start, w.end);
      for (var d = 0; d <= wl; d++) {
        var wk = addDays(w.start, d);
        if (marks[wk] && marks[wk].period) continue; // 实际记录优先于预测
        var wm = ensure(wk);
        wm.predicted = true;
        wm.predStart = (d === 0);
        wm.predEnd = (d === wl);
        if (wk === prediction.predictedDate) wm.predictedCore = true;
      }

      // 预测的经期本身会持续几天：从预测日起画一条完整缎带，
      // 而不是只标一天。跟窗口是两层信息——窗口表示"可能哪天来"，
      // 这条表示"来了大概持续到几号"。
      var bd = prediction.bleedDays || DEFAULT_BLEED;
      for (var b = 0; b < bd; b++) {
        var bk = addDays(prediction.predictedDate, b);
        if (marks[bk] && marks[bk].period) continue;
        var bm = ensure(bk);
        bm.predicted = true;
        bm.predBleed = true;
        bm.predBleedDay = b + 1;
        bm.predBleedStart = (b === 0);
        bm.predBleedEnd = (b === bd - 1);
      }
    }

    // 排卵期前后（仅作视觉层次，不用于任何生育判断）
    if (sorted.length >= 2 && prediction && prediction.available && prediction.medianCycleLength) {
      var ovDay = Math.round(prediction.medianCycleLength) - 14;
      if (ovDay >= 6) {
        sorted.forEach(function (p) {
          for (var o = -1; o <= 1; o++) {
            var fk = addDays(p.start, ovDay - 1 + o);
            var fm = marks[fk];
            if (fm && (fm.period || fm.predicted)) continue;
            ensure(fk).fertileWindow = true;
          }
        });
      }
    }

    if (notes) {
      Object.keys(notes).forEach(function (k) {
        var n = notes[k];
        if (!n) return;
        var hasContent = n.text || n.flow || n.pain || (n.moods && n.moods.length);
        if (hasContent) {
          var nm = ensure(k);
          nm.note = true;
          if (n.flow) nm.flow = n.flow;
          if (n.pain) nm.pain = n.pain;
        }
      });
    }

    return marks;
  }

  /**
   * 当前周期进度，用于环形图。
   * @returns {{dayOfCycle:number|null, cycleLength:number, percent:number,
   *            phase:string, label:string}}
   */
  function cycleProgress(periods, dateKey) {
    var key = dateKey || todayKey();
    var ph = phaseOn(periods, key);
    if (!ph.dayOfCycle) {
      return { dayOfCycle: null, cycleLength: 28, percent: 0, phase: 'unknown', label: '待记录' };
    }
    var pred = predictNext(periods);
    var len = ph.cycleLength || (pred.available ? pred.medianCycleLength : 28) || 28;
    var pct = Math.max(0, Math.min(100, ph.dayOfCycle / len * 100));
    return {
      dayOfCycle: ph.dayOfCycle,
      cycleLength: Math.round(len),
      percent: Math.round(pct),
      phase: ph.phase,
      label: '第 ' + ph.dayOfCycle + ' 天'
    };
  }

  /**
   * 首页提醒横幅。不做系统推送——推送在 iOS 上不可靠，会被静默，
   * 打开应用就能看到反而更确定。
   * 返回 null 表示没什么值得提醒的，此时不该占屏幕。
   *
   * `notes` 是可选的：给了就会在临近预测日时附上一句基于用户自己记录的
   * 经前预告（「上几次通常提前 3 天开始情绪起伏」）。这是 timelinePattern
   * 唯一真正改变日常使用的地方——历史页的图是回顾，这句话是提前量。
   * 参数放在最后并允许省略，是为了不动已有调用方。
   *
   * @returns {{level:string, title:string, detail:string, hint?:string}|null}
   */
  function reminder(periods, dateKey, notes) {
    var today = dateKey || todayKey();
    var sorted = sortPeriods(periods);
    if (!sorted.length) return null;

    var last = sorted[sorted.length - 1];

    // 进行中的经期优先：已经持续太久要提醒，可能是忘了标结束
    if (!last.end) {
      var days = diffDays(last.start, today) + 1;
      if (days > MAX_BLEED) {
        return {
          level: 'warn',
          title: '这次经期已记录 ' + days + ' 天',
          detail: '超过 ' + MAX_BLEED + ' 天通常是忘了标记结束。如果确实还没结束，建议咨询医生。'
        };
      }
      return { level: 'ongoing', title: '经期第 ' + days + ' 天', detail: '结束后记得标一下，预测会更准。' };
    }

    var pred = predictNext(sorted);
    if (!pred.available) return null;

    var until = diffDays(today, pred.predictedDate);

    /**
     * 临近预测日时的个人化经前预告。
     *
     * 三道门槛，都是为了不制造假模式：
     *   - 至少 2 次经前窗口有记录（一次不构成规律）；
     *   - 该症状至少在半数窗口里出现过；
     *   - 今天确实落在「通常开始出现」的那几天里。
     * 任一不满足就返回 undefined，横幅少一行，而不是给一句听起来
     * 很确定、其实没有依据的话。
     */
    function pmsHint(daysUntil) {
      if (!notes || daysUntil === null || daysUntil < 0) return undefined;
      var tl = timelinePattern(sorted, notes);
      var pm = tl.premenstrual;
      if (!pm.available || pm.windows < 2 || !pm.leadDays) return undefined;
      if (daysUntil > pm.leadDays) return undefined;
      var top = pm.top[0];
      if (!top || top.cycles < 2 || top.ratio < 0.5) return undefined;
      return '你的记录里，经期前 ' + pm.leadDays + ' 天左右常出现' + top.label +
        '（' + top.cycles + '/' + pm.windows + ' 次）。';
    }

    if (until < 0) {
      var late = -until;
      // 落在预测窗口内的"迟"还不算迟，那本来就是误差范围
      if (pred.window && today <= pred.window.end) {
        return {
          level: 'info',
          title: '预计这几天来',
          detail: '还在预测窗口内（到 ' + pred.window.end + '），晚几天是正常的。'
        };
      }
      return {
        level: late >= 10 ? 'warn' : 'info',
        title: '比预测晚了 ' + late + ' 天',
        detail: late >= 10
          ? '推迟较久可能与压力、作息、体重变化有关。如有需要请咨询医生。'
          : '推迟几天很常见，先不用紧张。'
      };
    }

    if (until === 0) {
      return { level: 'soon', title: '预计今天来', detail: '记得准备一下。', hint: pmsHint(0) };
    }
    if (until <= 3) {
      return {
        level: 'soon',
        title: '预计 ' + until + ' 天后来',
        detail: '大约在 ' + pred.predictedDate + '，' + confidenceWord(pred.confidence) + '。',
        hint: pmsHint(until)
      };
    }
    if (until <= 7) {
      return {
        level: 'info',
        title: '距下次约 ' + until + ' 天',
        detail: '预计 ' + pred.predictedDate + '。',
        hint: pmsHint(until)
      };
    }
    return null;   // 还早，不打扰
  }

  function confidenceWord(c) {
    if (c === 'high') return '预测比较可靠';
    if (c === 'medium') return '预测大致可靠';
    return '你的周期波动较大，仅作参考';
  }

  /**
   * 流量与痛感的历史趋势。数据早就存在 notes 里了，只是之前没展示。
   * 只统计落在经期内的记录——非经期的零星备注不代表这次经期的情况。
   * @returns {{available:boolean, cycles:Array, painAvg:number|null,
   *            flowCounts:Object, worstPainDay:number|null}}
   */
  function symptomTrends(periods, notes) {
    var sorted = sortPeriods(periods);
    notes = notes || {};
    var cycles = [];
    var allPain = [];
    var flowCounts = { light: 0, medium: 0, heavy: 0 };
    var painByDay = {};
    var symptomCounts = {};    // key -> 出现过的天数
    var symptomCycles = {};    // key -> { 经期起始日: true }，用于「几次里出现过几次」

    sorted.forEach(function (p) {
      var end = p.end || addDays(p.start, DEFAULT_BLEED - 1);
      var span = Math.max(0, diffDays(p.start, end));
      var pains = [];
      var flows = [];
      var syms = {};
      for (var i = 0; i <= span; i++) {
        var n = notes[addDays(p.start, i)];
        if (!n) continue;
        if (typeof n.pain === 'number' && n.pain > 0) {
          pains.push(n.pain);
          allPain.push(n.pain);
          var d = i + 1;
          (painByDay[d] = painByDay[d] || []).push(n.pain);
        }
        if (n.flow && flowCounts.hasOwnProperty(n.flow)) {
          flows.push(n.flow);
          flowCounts[n.flow] += 1;
        }
        normSymptoms(n.symptoms).forEach(function (k) {
          symptomCounts[k] = (symptomCounts[k] || 0) + 1;
          (symptomCycles[k] = symptomCycles[k] || {})[p.start] = true;
          syms[k] = true;
        });
      }
      var symKeys = Object.keys(syms);
      if (pains.length || flows.length || symKeys.length) {
        cycles.push({
          start: p.start,
          maxPain: pains.length ? Math.max.apply(null, pains) : null,
          avgPain: pains.length ? round1(mean(pains)) : null,
          peakFlow: flows.indexOf('heavy') > -1 ? 'heavy'
            : flows.indexOf('medium') > -1 ? 'medium'
              : flows.length ? 'light' : null,
          symptoms: symKeys,
          recordedDays: Math.max(pains.length, flows.length, symKeys.length)
        });
      }
    });

    // 哪一天最疼——痛感在经期内的分布，用于「第 2 天最难受」这类洞察
    var worstDay = null;
    var worstAvg = -1;
    Object.keys(painByDay).forEach(function (d) {
      if (painByDay[d].length < 2) return;   // 单次记录不足以说明规律
      var a = mean(painByDay[d]);
      if (a > worstAvg) { worstAvg = a; worstDay = Number(d); }
    });

    // 症状排行：按「在几次经期里出现过」排，而不是按总天数。
    // 按天数排会让一次持续 5 天的腹痛压过 4 次各出现 1 天的头痛，
    // 而后者才更能说明「每次都会有」。
    var symptomTop = Object.keys(symptomCounts).map(function (k) {
      return {
        key: k,
        label: SYMPTOM_LABEL[k] || k,
        days: symptomCounts[k],
        cycles: Object.keys(symptomCycles[k] || {}).length
      };
    }).sort(function (a, b) {
      return (b.cycles - a.cycles) || (b.days - a.days) || (a.key < b.key ? -1 : 1);
    });

    return {
      available: cycles.length > 0,
      cycles: cycles,
      painAvg: allPain.length ? round1(mean(allPain)) : null,
      painMax: allPain.length ? Math.max.apply(null, allPain) : null,
      flowCounts: flowCounts,
      worstPainDay: worstDay,
      worstPainAvg: worstAvg >= 0 ? round1(worstAvg) : null,
      symptomTop: symptomTop,
      recordedCycles: cycles.length
    };
  }

  // ---------- 经前 / 经期逐日模式 ----------

  // 经前观察窗。取 7 天而不是更长：黄体期典型 12~14 天，窗口再往前推就会
  // 盖到排卵前后，那时的症状与「经前反应」是两件事，混在一起会稀释信号。
  var PMS_WINDOW = 7;
  // 经期内看到第几天。MAX_BLEED 是 12，但 8 天以上的样本极少，
  // 画出来是一排空格子，反而让前几天的对比变模糊。
  var TL_PERIOD_DAYS = 10;

  /**
   * offset 的约定：负数 = 经期开始前第几天（-1 就是前一天），
   * 正数 = 经期第几天（1 = 开始当天）。刻意没有 0——
   * 「第 0 天」对用户没有意义，而两套编号混用是 off-by-one 的温床。
   */
  function tlDateFor(startKey, offset) {
    return offset < 0 ? addDays(startKey, offset) : addDays(startKey, offset - 1);
  }

  function tlLabel(offset) {
    return offset < 0 ? '前' + (-offset) : '第' + offset;
  }

  /**
   * 这条备注是否含结构化记录。
   * 只认流量/痛感/症状，不认纯文字：文字备注无法参与统计，
   * 把它算成「有记录」只会抬高分母、压低所有比例。
   */
  function noteHasContent(n) {
    if (!n) return false;
    if (n.flow) return true;
    if (typeof n.pain === 'number' && n.pain > 0) return true;
    return normSymptoms(n.symptoms).length > 0;
  }

  /**
   * 以「经期开始日」为原点，把记录按相对天数摊开。
   *
   * 存在的理由：`symptomTrends` 只看 p.start 到经期结束之间的记录，
   * 经前那几天被整段丢掉了。而情绪起伏、焦虑、胸胀、长痘这几个标签
   * 主要就出现在来之前——数据一直在记，只是从来没被用过。
   *
   * 分母的处理是这里唯一需要小心的地方：某天没记录，既可能是「那天没症状」，
   * 也可能是「那天忘了记」，从数据上分不开。所以：
   *   - 整次周期一条结构化记录都没有 → 这次不进分母（用户当时根本没在记）；
   *   - 进了分母之后，没记录的日子按「没有该症状」算。
   * 代价是偶尔漏记会让比例偏低，这个方向的偏差是安全的：
   * 宁可少报一个模式，也不要凭空造出一个。
   *
   * 经前窗口里落在上一次经期内的日子会被剔除——那是上次的出血期，
   * 把它的腹痛算成 PMS 会造出一个不存在的模式。
   */
  function timelinePattern(periods, notes, opts) {
    notes = notes || {};
    opts = opts || {};
    var preDays = opts.preDays || PMS_WINDOW;
    var periodDays = opts.periodDays || TL_PERIOD_DAYS;
    var sorted = sortPeriods(periods);

    var offsets = [];
    var o;
    for (o = -preDays; o <= -1; o++) offsets.push(o);
    for (o = 1; o <= periodDays; o++) offsets.push(o);

    var slots = {};
    offsets.forEach(function (off) {
      slots[off] = {
        samples: 0, pains: [], symptoms: {},
        flow: { light: 0, medium: 0, heavy: 0 }
      };
    });

    var trackedCycles = 0;
    var preWindows = 0;
    var preSymCycles = {};   // key -> 有几次经前窗口出现过
    var preSymDays = {};     // key -> 共几天出现过
    var preLead = [];        // 每次最早提前几天出现症状
    var prePain = [];

    sorted.forEach(function (p, idx) {
      var prev = sorted[idx - 1];
      var prevEnd = prev ? (prev.end || addDays(prev.start, DEFAULT_BLEED - 1)) : null;
      var end = p.end || addDays(p.start, DEFAULT_BLEED - 1);
      var span = diffDays(p.start, end);   // 0 基：0 表示只持续一天

      var usable = [];
      offsets.forEach(function (off) {
        if (off < 0) {
          if (prevEnd && diffDays(tlDateFor(p.start, off), prevEnd) >= 0) return;
          usable.push(off);
        } else if (off - 1 <= span) {
          usable.push(off);
        }
      });

      var tracked = usable.some(function (off) {
        return noteHasContent(notes[tlDateFor(p.start, off)]);
      });
      if (!tracked) return;
      trackedCycles += 1;

      var preSeen = {};
      var hasPreWindow = false;
      var earliest = null;

      usable.forEach(function (off) {
        var slot = slots[off];
        slot.samples += 1;
        if (off < 0) hasPreWindow = true;

        var n = notes[tlDateFor(p.start, off)];
        if (!n) return;
        if (typeof n.pain === 'number' && n.pain > 0) {
          slot.pains.push(n.pain);
          if (off < 0) prePain.push(n.pain);
        }
        if (n.flow && slot.flow.hasOwnProperty(n.flow)) slot.flow[n.flow] += 1;
        normSymptoms(n.symptoms).forEach(function (key) {
          slot.symptoms[key] = (slot.symptoms[key] || 0) + 1;
          if (off < 0) {
            preSymDays[key] = (preSymDays[key] || 0) + 1;
            preSeen[key] = true;
            if (earliest === null || off < earliest) earliest = off;
          }
        });
      });

      if (hasPreWindow) {
        preWindows += 1;
        Object.keys(preSeen).forEach(function (key) {
          preSymCycles[key] = (preSymCycles[key] || 0) + 1;
        });
        if (earliest !== null) preLead.push(-earliest);
      }
    });

    var days = offsets.map(function (off) {
      var s = slots[off];
      var keys = Object.keys(s.symptoms).sort(function (a, b) {
        return (s.symptoms[b] - s.symptoms[a]) || (a < b ? -1 : 1);
      });
      return {
        offset: off,
        label: tlLabel(off),
        phase: off < 0 ? 'pre' : 'bleed',
        samples: s.samples,
        painAvg: s.pains.length ? round1(mean(s.pains)) : null,
        painMax: s.pains.length ? Math.max.apply(null, s.pains) : null,
        painDays: s.pains.length,
        flowCounts: s.flow,
        symptoms: s.symptoms,
        symptomDays: keys.reduce(function (acc, k) { return acc + s.symptoms[k]; }, 0),
        topSymptom: keys.length ? keys[0] : null
      };
    });

    // 症状排行按「出现过的周期数」排，与 symptomTrends 同一套理由：
    // 一次持续 5 天的腹胀不该压过 4 次各 1 天的头痛。
    var preTop = Object.keys(preSymCycles).map(function (k) {
      return {
        key: k,
        label: SYMPTOM_LABEL[k] || k,
        cycles: preSymCycles[k],
        days: preSymDays[k] || 0,
        ratio: preWindows ? Math.round(preSymCycles[k] / preWindows * 100) / 100 : 0
      };
    }).sort(function (a, b) {
      return (b.cycles - a.cycles) || (b.days - a.days) || (a.key < b.key ? -1 : 1);
    });

    // 整条时间线上出现过的症状，按总天数排。热力图的行就取它的前几个。
    var allCounts = {};
    days.forEach(function (d) {
      Object.keys(d.symptoms).forEach(function (k) {
        allCounts[k] = (allCounts[k] || 0) + d.symptoms[k];
      });
    });
    var symptomRows = Object.keys(allCounts).map(function (k) {
      return { key: k, label: SYMPTOM_LABEL[k] || k, days: allCounts[k] };
    }).sort(function (a, b) {
      return (b.days - a.days) || (a.key < b.key ? -1 : 1);
    });

    return {
      available: trackedCycles > 0,
      trackedCycles: trackedCycles,
      preDays: preDays,
      periodDays: periodDays,
      offsets: offsets,
      days: days,
      symptomRows: symptomRows,
      premenstrual: {
        available: preWindows > 0 && preTop.length > 0,
        windows: preWindows,
        top: preTop,
        // 中位数而不是最早的一次：一次特别早的记录不该定义「通常提前几天」
        leadDays: preLead.length ? Math.round(median(preLead)) : null,
        painAvg: prePain.length ? round1(mean(prePain)) : null
      }
    };
  }

  /**
   * 值得留意的健康信号。
   *
   * 这不是诊断，也刻意不试图做诊断——它只做一件事：把「你自己的记录里
   * 客观存在、但翻日历不容易发现」的模式指出来，并给出「记录了什么、
   * 因此建议聊聊什么」。所有文案都指向咨询医生，不给任何处理建议。
   *
   * 每条 insight 都带 evidence（具体数字），因为不给依据的提醒
   * 只会制造焦虑：用户无法判断该不该当真。
   *
   * @returns {{items:Array<{id:string,level:string,title:string,detail:string,evidence:string}>}}
   */
  function healthInsights(periods, notes) {
    var sorted = sortPeriods(periods);
    var items = [];
    if (sorted.length < 2) return { items: items, available: false };

    var raw = cycleLengths(sorted);
    var stab = assessStability(sorted);
    var bleeds = bleedLengths(sorted);

    // 1) 周期过短 / 过长。用中位数判断而不是单次，单次异常太常见了。
    if (raw.length >= 2) {
      var medAll = median(raw);
      if (medAll < MIN_CYCLE) {
        items.push({
          id: 'cycle_short',
          level: 'attention',
          title: '周期偏短',
          detail: '多次周期短于 21 天。这可能与激素水平或排卵情况有关，值得跟医生提一下。',
          evidence: '中位周期 ' + round1(medAll) + ' 天（共 ' + raw.length + ' 个周期）'
        });
      } else if (medAll > MAX_CYCLE) {
        items.push({
          id: 'cycle_long',
          level: 'attention',
          title: '周期偏长',
          detail: '多次周期超过 45 天。长期如此建议就诊了解原因。',
          evidence: '中位周期 ' + round1(medAll) + ' 天（共 ' + raw.length + ' 个周期）'
        });
      }
    }

    // 2) 波动过大。用已有的稳定性判断，不另立标准，避免两套结论互相矛盾。
    if (stab.available && stab.status === 'very_irregular') {
      items.push({
        id: 'very_irregular',
        level: 'attention',
        title: '周期很不规律',
        detail: '周期长度起伏较大。压力、作息、体重变化都可能造成，持续如此建议就诊。',
        evidence: '范围 ' + stab.minLength + '~' + stab.maxLength + ' 天，波动度 ' +
          Math.round(stab.cv * 100) + '%'
      });
    }

    // 3) 经期持续过久。任一次超过 MAX_BLEED 天都值得说，不必等成为规律。
    var longBleeds = [];
    sorted.forEach(function (p) {
      if (!p.end) return;
      var n = diffDays(p.start, p.end) + 1;
      if (n > MAX_BLEED) longBleeds.push({ start: p.start, days: n });
    });
    if (longBleeds.length) {
      var worst = longBleeds[longBleeds.length - 1];
      items.push({
        id: 'long_bleed',
        level: 'attention',
        title: '有经期持续偏久',
        detail: '单次经期超过 ' + MAX_BLEED + ' 天。如果不是忘了标记结束，建议就诊。',
        evidence: worst.start + ' 那次记了 ' + worst.days + ' 天' +
          (longBleeds.length > 1 ? '，共 ' + longBleeds.length + ' 次偏久' : '')
      });
    }

    // 4) 频繁重度流量。一次不算，多次才是模式。
    var heavyDays = 0;
    Object.keys(notes || {}).forEach(function (k) {
      if (notes[k] && notes[k].flow === 'heavy') heavyDays += 1;
    });
    if (heavyDays >= 6) {
      items.push({
        id: 'heavy_flow',
        level: 'info',
        title: '重度流量的天数不少',
        detail: '量多的日子较多时，有些人会伴随缺铁。体检时可以顺便查一下血常规。',
        evidence: '共记录 ' + heavyDays + ' 天「多」'
      });
    }

    // 5) 持续高痛感。取每次经期的最高痛感，看是否长期在 4 以上。
    var trends = symptomTrends(sorted, notes);
    var highPainCycles = trends.cycles.filter(function (c) {
      return c.maxPain !== null && c.maxPain >= 4;
    });
    if (highPainCycles.length >= 3) {
      items.push({
        id: 'high_pain',
        level: 'attention',
        title: '痛感持续偏强',
        detail: '连续多次经期痛感达到「明显」以上。影响到日常时不必忍着，' +
          '这是可以就诊处理的问题。',
        evidence: highPainCycles.length + ' 次经期最高痛感 ≥4/5'
      });
    }

    // 6) 当前推迟很久。只在真的超出预测窗口很多时才说。
    var pred = predictNext(sorted);
    if (pred.available && !pred.estimated) {
      var late = -pred.daysUntil;
      if (late >= 14) {
        items.push({
          id: 'very_late',
          level: 'attention',
          title: '已比预测晚 ' + late + ' 天',
          detail: '推迟两周以上时，建议先排除怀孕可能，之后如仍未来建议就诊。',
          evidence: '预测 ' + pred.predictedDate + '，今天 ' + todayKey()
        });
      }
    }

    // 7) 记录太少时说清楚「结论还不可靠」，而不是给一个看起来确定的结果。
    if (raw.length < 3) {
      items.push({
        id: 'low_data',
        level: 'info',
        title: '记录还不多',
        detail: '目前的预测和稳定性判断只是粗略参考。再记 1~2 次会明显变准。',
        evidence: '已有 ' + sorted.length + ' 次经期记录'
      });
    }

    return {
      available: items.length > 0,
      items: items,
      // 有几条是「建议聊聊」级别的——UI 用它决定要不要把卡片显示成需要注意
      attentionCount: items.filter(function (i) { return i.level === 'attention'; }).length
    };
  }

  // ---------- CSV 导出 ----------

  var FLOW_CN = { light: '少', medium: '中', heavy: '多' };

  /**
   * 一个单元格。做两件容易被忽略的事：
   *
   * 1. RFC 4180 转义：含逗号、引号、换行的值必须整体加引号，内部引号翻倍。
   *    备注是自由文本，用户写个逗号就能把整张表错位一列。
   * 2. 公式注入防护：以 = + - @ 或制表符开头的文本在 Excel / WPS /
   *    Google Sheets 里会被当公式执行。这份 CSV 的用途正是发给别人打开，
   *    所以给这类值前面补一个单引号，让它保持文本。数字列不走这里，
   *    否则 3 会变成 '3 而无法参与计算。
   */
  function csvText(v) {
    var s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function csvNum(v) {
    return (v === null || v === undefined || v === '') ? '' : String(v);
  }

  /**
   * 逐日 CSV。刻意只出一张表而不是「日记录 + 周期汇总」两个文件：
   * 一张表一种 schema，能直接丢进 Excel 排序筛选或做数据透视；
   * 两种行混在一个文件里，任何表格软件都读不成规整数据。
   * 汇总数字已经在「给医生的报告」那段文字里，不需要再出一个文件。
   *
   * 行的取值范围是「所有有记录的日子」∪「所有经期内的日子」：
   * 只取经期内会丢掉经前那几天的症状（那正是最近才开始统计的部分），
   * 只取有记录的日子则会漏掉「这天在经期但什么都没记」——
   * 后者对医生同样是信息（说明那天没有不适）。
   */
  function buildCsv(periods, notes) {
    notes = notes || {};
    var sorted = sortPeriods(periods);

    var rows = {};   // dateKey -> true
    Object.keys(notes).forEach(function (k) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(k) && noteHasContent(notes[k])) rows[k] = true;
    });
    sorted.forEach(function (p) {
      var end = p.end || addDays(p.start, DEFAULT_BLEED - 1);
      var span = Math.max(0, diffDays(p.start, end));
      for (var i = 0; i <= span; i++) rows[addDays(p.start, i)] = true;
    });

    // 每次经期的下一次开始日，用来算周期长度
    var nextStart = {};
    sorted.forEach(function (p, i) {
      if (sorted[i + 1]) nextStart[p.start] = sorted[i + 1].start;
    });

    var header = ['日期', '星期', '阶段', '经期第几天', '周期第几天',
      '本次经期开始', '本次周期长度', '流量', '痛感', '症状', '备注'];
    var WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    var PHASE_CN = {
      menstrual: '经期', follicular: '卵泡期',
      ovulation: '排卵期', luteal: '黄体期', unknown: ''
    };

    var lines = [header.map(csvText).join(',')];

    Object.keys(rows).sort().forEach(function (key) {
      var n = notes[key] || {};
      var ph = phaseOn(sorted, key);

      // 该日期属于哪一次经期（只有落在经期内才算）
      var owner = null;
      for (var i = 0; i < sorted.length; i++) {
        var p = sorted[i];
        var end = p.end || addDays(p.start, DEFAULT_BLEED - 1);
        if (isBetween(key, p.start, end)) { owner = p; break; }
      }

      var cycleLen = owner && nextStart[owner.start]
        ? diffDays(owner.start, nextStart[owner.start]) : '';

      lines.push([
        csvText(key),
        csvText(WD[parseKey(key).getDay()]),
        csvText(PHASE_CN[ph.phase] || ''),
        csvNum(owner ? diffDays(owner.start, key) + 1 : ''),
        csvNum(ph.dayOfCycle || ''),
        csvText(owner ? owner.start : ''),
        csvNum(cycleLen),
        csvText(n.flow ? FLOW_CN[n.flow] || n.flow : ''),
        csvNum(typeof n.pain === 'number' && n.pain > 0 ? n.pain : ''),
        csvText(normSymptoms(n.symptoms).map(function (k) {
          return SYMPTOM_LABEL[k] || k;
        }).join(' ')),
        csvText(n.text || '')
      ].join(','));
    });

    // CRLF 是 RFC 4180 规定的行结束符，也是 Excel 最不容易出错的选择
    return { text: lines.join('\r\n') + '\r\n', rows: lines.length - 1 };
  }

  // ---------- 修改经期起止日 ----------

  function isDateKey(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    // 正则挡不住 2026-02-31：转回来比一次才能确认这天真的存在
    return toKey(parseKey(v)) === v;
  }

  /**
   * 校验并应用一次「改起止日」。
   *
   * 存在的理由：之前标错日期只能删掉整段重记，而重记会丢掉这段时间里的
   * 流量/痛感/症状关联（备注按日期存所以不丢，但用户得重新标一次开始和结束），
   * 更要紧的是删除会进同步删除队列，等于在所有设备上抹掉再重建。
   *
   * 返回值刻意不抛异常：这是用户输入校验，每条失败都要给一句能看懂的话。
   * @returns {{ok:true, periods:Array, changed:boolean}|{ok:false, error:string}}
   */
  function applyPeriodEdit(periods, originalStart, newStart, newEnd) {
    var sorted = sortPeriods(periods);
    var target = null;
    for (var i = 0; i < sorted.length; i++) {
      if (sorted[i].start === originalStart) { target = sorted[i]; break; }
    }
    if (!target) return { ok: false, error: '找不到要修改的那次记录。' };

    if (!isDateKey(newStart)) return { ok: false, error: '开始日期不是有效日期。' };
    newEnd = newEnd || null;
    if (newEnd !== null && !isDateKey(newEnd)) {
      return { ok: false, error: '结束日期不是有效日期。' };
    }

    if (newEnd !== null && diffDays(newStart, newEnd) < 0) {
      return { ok: false, error: '结束日不能早于开始日。' };
    }

    // 未来的日期没有意义：经期是已发生的事实，不是计划
    var today = todayKey();
    if (diffDays(today, newStart) > 0) {
      return { ok: false, error: '开始日不能是未来的日期。' };
    }
    if (newEnd !== null && diffDays(today, newEnd) > 0) {
      return { ok: false, error: '结束日不能是未来的日期。' };
    }

    if (newEnd !== null) {
      var span = diffDays(newStart, newEnd) + 1;
      // 上限用 MAX_BLEED，和 bleedLengths 的统计口径、以及提醒里
      // 「超过 12 天多半是忘了标结束」保持同一个数，不另立一套标准
      if (span > MAX_BLEED) {
        return { ok: false, error: '一次经期不会超过 ' + MAX_BLEED + ' 天，请检查日期。' };
      }
    }

    // 与其他记录重叠检查。未标结束的按 DEFAULT_BLEED 估一个范围——
    // 否则一段进行中的记录会被当成只占一天，改出来的新段能直接盖上去。
    var newFrom = newStart;
    var newTo = newEnd || addDays(newStart, DEFAULT_BLEED - 1);
    for (var j = 0; j < sorted.length; j++) {
      var o = sorted[j];
      if (o.start === originalStart) continue;
      var oFrom = o.start;
      var oTo = o.end || addDays(o.start, DEFAULT_BLEED - 1);
      if (diffDays(newFrom, oTo) >= 0 && diffDays(oFrom, newTo) >= 0) {
        return { ok: false, error: '和 ' + oFrom + ' 那次记录重叠了。' };
      }
    }

    var changed = (target.start !== newStart) ||
      ((target.end || null) !== newEnd);

    var out = sorted.map(function (p) {
      if (p.start !== originalStart) return { start: p.start, end: p.end || null };
      return { start: newStart, end: newEnd };
    });

    return { ok: true, periods: sortPeriods(out), changed: changed };
  }

  /** 历史周期列表（供历史页展示），最近的在前 */
  function cycleHistory(periods) {
    var sorted = sortPeriods(periods);
    var out = [];
    for (var i = sorted.length - 1; i >= 0; i--) {
      var cur = sorted[i];
      var prev = sorted[i - 1];
      var next = sorted[i + 1];
      out.push({
        start: cur.start,
        end: cur.end || null,
        periodLength: cur.end ? diffDays(cur.start, cur.end) + 1 : null,
        cycleLength: next ? diffDays(cur.start, next.start) : null,
        prevCycleLength: prev ? diffDays(prev.start, cur.start) : null,
        isOutlier: prev ? (function () {
          var n = diffDays(prev.start, cur.start);
          return n < MIN_CYCLE || n > MAX_CYCLE;
        })() : false
      });
    }
    return out;
  }

  var API = {
    MIN_CYCLE: MIN_CYCLE,
    MAX_CYCLE: MAX_CYCLE,
    MIN_BLEED: MIN_BLEED,
    MAX_BLEED: MAX_BLEED,
    DEFAULT_BLEED: DEFAULT_BLEED,
    SYMPTOMS: SYMPTOMS,
    SYMPTOM_LABEL: SYMPTOM_LABEL,
    normSymptoms: normSymptoms,
    CV_BANDS: CV_BANDS,
    bandForCv: bandForCv,
    applyOutlierPenalty: applyOutlierPenalty,
    toKey: toKey,
    parseKey: parseKey,
    todayKey: todayKey,
    addDays: addDays,
    diffDays: diffDays,
    isBetween: isBetween,
    median: median,
    mean: mean,
    stdDev: stdDev,
    sortPeriods: sortPeriods,
    cycleLengths: cycleLengths,
    filterOutliers: filterOutliers,
    bleedLengths: bleedLengths,
    predictBleedLength: predictBleedLength,
    predictNext: predictNext,
    assessStability: assessStability,
    phaseOn: phaseOn,
    cycleProgress: cycleProgress,
    buildDayMarks: buildDayMarks,
    reminder: reminder,
    symptomTrends: symptomTrends,
    PMS_WINDOW: PMS_WINDOW,
    TL_PERIOD_DAYS: TL_PERIOD_DAYS,
    tlDateFor: tlDateFor,
    timelinePattern: timelinePattern,
    buildCsv: buildCsv,
    isDateKey: isDateKey,
    applyPeriodEdit: applyPeriodEdit,
    healthInsights: healthInsights,
    cycleHistory: cycleHistory
  };

  global.PeriodCore = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
