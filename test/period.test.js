/*
 * period.js 单元测试（零依赖，直接 node test/period.test.js 运行）
 */
var assert = require('assert');
var P = require('../js/period.js');

var passed = 0;
var failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (e) {
    failed++;
    console.log('  FAIL ' + name);
    console.log('       ' + e.message);
  }
}

console.log('\n[日期工具]');

test('addDays 跨月正确', function () {
  assert.strictEqual(P.addDays('2026-01-30', 3), '2026-02-02');
});

test('addDays 跨年正确', function () {
  assert.strictEqual(P.addDays('2026-12-30', 5), '2027-01-04');
});

test('addDays 闰年 2 月正确', function () {
  assert.strictEqual(P.addDays('2028-02-28', 1), '2028-02-29');
});

test('addDays 负偏移正确', function () {
  assert.strictEqual(P.addDays('2026-03-01', -1), '2026-02-28');
});

test('diffDays 正负方向正确', function () {
  assert.strictEqual(P.diffDays('2026-01-01', '2026-01-31'), 30);
  assert.strictEqual(P.diffDays('2026-01-31', '2026-01-01'), -30);
  assert.strictEqual(P.diffDays('2026-05-05', '2026-05-05'), 0);
});

test('toKey/parseKey 往返不丢日期（无 UTC 偏移问题）', function () {
  var keys = ['2026-01-01', '2026-06-15', '2026-12-31', '2028-02-29'];
  keys.forEach(function (k) {
    assert.strictEqual(P.toKey(P.parseKey(k)), k);
  });
});

test('parseKey 得到本地零点而非 UTC 零点', function () {
  var d = P.parseKey('2026-08-30');
  assert.strictEqual(d.getFullYear(), 2026);
  assert.strictEqual(d.getMonth(), 7);
  assert.strictEqual(d.getDate(), 30);
  assert.strictEqual(d.getHours(), 0);
});

test('isBetween 边界包含', function () {
  assert.strictEqual(P.isBetween('2026-01-01', '2026-01-01', '2026-01-05'), true);
  assert.strictEqual(P.isBetween('2026-01-05', '2026-01-01', '2026-01-05'), true);
  assert.strictEqual(P.isBetween('2026-01-06', '2026-01-01', '2026-01-05'), false);
});

console.log('\n[统计工具]');

test('median 奇数个', function () {
  assert.strictEqual(P.median([29, 27, 28]), 28);
});

test('median 偶数个取中间两数平均', function () {
  assert.strictEqual(P.median([26, 28, 30, 32]), 29);
});

test('median 抗离群值（均值会被拖偏）', function () {
  var data = [28, 28, 29, 28, 60];
  assert.strictEqual(P.median(data), 28);
  assert.ok(P.mean(data) > 34, '均值应被 60 拖偏');
});

test('stdDev 样本量不足返回 0', function () {
  assert.strictEqual(P.stdDev([28]), 0);
  assert.strictEqual(P.stdDev([]), 0);
});

test('stdDev 全相同返回 0', function () {
  assert.strictEqual(P.stdDev([28, 28, 28, 28]), 0);
});

console.log('\n[周期长度与离群过滤]');

function mk(starts) {
  return starts.map(function (s) { return { start: s }; });
}

test('cycleLengths 计算相邻开始日间隔', function () {
  var ps = mk(['2026-01-01', '2026-01-29', '2026-02-26']);
  assert.deepStrictEqual(P.cycleLengths(ps), [28, 28]);
});

test('cycleLengths 对乱序输入先排序', function () {
  var ps = mk(['2026-02-26', '2026-01-01', '2026-01-29']);
  assert.deepStrictEqual(P.cycleLengths(ps), [28, 28]);
});

test('cycleLengths 忽略无 start 的脏数据', function () {
  var ps = [{ start: '2026-01-01' }, { end: '2026-01-05' }, null, { start: '2026-01-29' }];
  assert.deepStrictEqual(P.cycleLengths(ps), [28]);
});

test('filterOutliers 剔除 <21 与 >45 天', function () {
  assert.deepStrictEqual(P.filterOutliers([28, 15, 30, 58, 27]), [28, 30, 27]);
});

test('filterOutliers 全为离群时退回原数据', function () {
  assert.deepStrictEqual(P.filterOutliers([60, 70]), [60, 70]);
});

console.log('\n[预测]');

test('无记录时不可预测', function () {
  var r = P.predictNext([]);
  assert.strictEqual(r.available, false);
  assert.ok(r.message);
});

test('仅 1 次记录时按 28 天估算并标记 estimated/low', function () {
  var r = P.predictNext(mk(['2026-08-01']));
  assert.strictEqual(r.available, true);
  assert.strictEqual(r.estimated, true);
  assert.strictEqual(r.confidence, 'low');
  assert.strictEqual(r.predictedDate, '2026-08-29');
});

test('规律周期预测日期正确且置信度 high', function () {
  var r = P.predictNext(mk(['2026-05-01', '2026-05-29', '2026-06-26', '2026-07-24']));
  assert.strictEqual(r.predictedDate, '2026-08-21');
  assert.strictEqual(r.confidence, 'high');
  assert.strictEqual(r.medianCycleLength, 28);
  assert.deepStrictEqual(r.window, { start: '2026-08-19', end: '2026-08-23' });
});

test('离群周期不会把预测拖偏两周', function () {
  // 一个 58 天的异常周期，若用均值会把预测推后约 7 天
  var ps = mk(['2026-01-01', '2026-01-29', '2026-03-28', '2026-04-25', '2026-05-23']);
  var r = P.predictNext(ps);
  assert.strictEqual(r.outliersDropped, 1);
  assert.strictEqual(r.medianCycleLength, 28);
  assert.strictEqual(r.predictedDate, '2026-06-20');
});

test('波动大时窗口更宽、置信度更低', function () {
  var regular = P.predictNext(mk(['2026-01-01', '2026-01-29', '2026-02-26', '2026-03-26']));
  var noisy = P.predictNext(mk(['2026-01-01', '2026-01-23', '2026-02-25', '2026-03-18']));
  var rw = P.diffDays(regular.window.start, regular.window.end);
  var nw = P.diffDays(noisy.window.start, noisy.window.end);
  assert.ok(nw > rw, '波动大的窗口应更宽，实际 ' + nw + ' vs ' + rw);
  assert.notStrictEqual(noisy.confidence, 'high');
});

test('预测只依赖 start_date，不受 end/备注缺失影响', function () {
  var withEnd = [
    { start: '2026-06-01', end: '2026-06-05', flow: 'medium' },
    { start: '2026-06-29', end: '2026-07-03' }
  ];
  var withoutEnd = mk(['2026-06-01', '2026-06-29']);
  assert.strictEqual(P.predictNext(withEnd).predictedDate, P.predictNext(withoutEnd).predictedDate);
});

console.log('\n[稳定性]');

test('少于 3 次记录时返回 unknown', function () {
  assert.strictEqual(P.assessStability(mk(['2026-01-01'])).status, 'unknown');
  assert.strictEqual(P.assessStability(mk(['2026-01-01', '2026-01-29'])).status, 'unknown');
  assert.strictEqual(P.assessStability([]).available, false);
});

test('3 次记录即可判定', function () {
  var r = P.assessStability(mk(['2026-01-01', '2026-01-29', '2026-02-26']));
  assert.strictEqual(r.available, true);
  assert.strictEqual(r.status, 'very_regular');
});

test('完全规律 CV=0 判为 very_regular', function () {
  var r = P.assessStability(mk(['2026-01-01', '2026-01-29', '2026-02-26', '2026-03-26']));
  assert.strictEqual(r.cv, 0);
  assert.strictEqual(r.status, 'very_regular');
});

test('大幅波动判为 very_irregular', function () {
  var r = P.assessStability(mk(['2026-01-01', '2026-01-22', '2026-03-10', '2026-03-31', '2026-05-20']));
  assert.strictEqual(r.status, 'very_irregular');
});

test('离群周期本身即不规律证据，不因被过滤而误判为规律', function () {
  // 三个 47/48 天的异常周期被过滤后，剩余样本一致，CV 会等于 0
  var r = P.assessStability(mk(['2026-01-01', '2026-02-17', '2026-04-05', '2026-05-23', '2026-06-20']));
  assert.ok(r.outliersDropped > 0, '应有离群周期被剔除');
  assert.notStrictEqual(r.status, 'very_regular');
  assert.strictEqual(r.status, 'very_irregular');
});

test('单个离群周期至少降级到有些波动', function () {
  var ps = mk(['2026-01-01', '2026-01-29', '2026-03-28', '2026-04-25', '2026-05-23', '2026-06-20']);
  var r = P.assessStability(ps);
  assert.strictEqual(r.outliersDropped, 1);
  assert.strictEqual(r.cv, 0);
  assert.strictEqual(r.status, 'irregular');
  // 预测日期仍应由中位数决定，不受降级影响
  assert.strictEqual(P.predictNext(ps).predictedDate, '2026-07-18');
});

test('稳定性同时给出中位数与均值、极值', function () {
  var r = P.assessStability(mk(['2026-01-01', '2026-01-29', '2026-02-28', '2026-03-27']));
  assert.strictEqual(r.sampleSize, 3);
  assert.ok(r.minLength <= r.medianLength && r.medianLength <= r.maxLength);
});

console.log('\n[阈值一致性 —— 计划书中的 bug 回归测试]');

test('预测与稳定性共用同一份 CV 阈值，不再自相矛盾', function () {
  var datasets = [
    ['2026-01-01', '2026-01-29', '2026-02-26', '2026-03-26'],
    ['2026-01-01', '2026-01-30', '2026-02-26', '2026-03-27'],
    ['2026-01-01', '2026-01-23', '2026-02-25', '2026-03-18'],
    ['2026-01-01', '2026-01-22', '2026-03-05', '2026-03-26']
  ];
  datasets.forEach(function (ds) {
    var ps = mk(ds);
    var pred = P.predictNext(ps);
    var stab = P.assessStability(ps);
    assert.strictEqual(pred.cv, stab.cv, '同一数据 CV 应一致: ' + ds.join(','));
    var band = P.bandForCv(pred.cv);
    assert.strictEqual(pred.confidence, band.confidence);
    assert.strictEqual(stab.status, band.status);
    // high 置信度必须对应 very_regular，不允许出现 low + regular 的组合
    if (pred.confidence === 'high') assert.strictEqual(stab.status, 'very_regular');
    if (stab.status === 'very_irregular') assert.strictEqual(pred.confidence, 'low');
  });
});

test('CV_BANDS 阈值单调递增且覆盖到无穷', function () {
  for (var i = 1; i < P.CV_BANDS.length; i++) {
    assert.ok(P.CV_BANDS[i].cvMax > P.CV_BANDS[i - 1].cvMax);
  }
  assert.strictEqual(P.CV_BANDS[P.CV_BANDS.length - 1].cvMax, Infinity);
});

console.log('\n[周期阶段]');

test('经期内判为 menstrual 并给出第几天', function () {
  var ps = [{ start: '2026-08-01', end: '2026-08-05' }];
  var r = P.phaseOn(ps, '2026-08-03');
  assert.strictEqual(r.phase, 'menstrual');
  assert.strictEqual(r.periodDay, 3);
});

test('未记结束日时按 5 天估算经期', function () {
  var ps = [{ start: '2026-08-01' }];
  assert.strictEqual(P.phaseOn(ps, '2026-08-05').phase, 'menstrual');
  assert.notStrictEqual(P.phaseOn(ps, '2026-08-06').phase, 'menstrual');
});

test('排卵期前后判为 follicular / ovulation / luteal', function () {
  var ps = [
    { start: '2026-06-01', end: '2026-06-05' },
    { start: '2026-06-29', end: '2026-07-03' },
    { start: '2026-07-27', end: '2026-07-31' }
  ];
  assert.strictEqual(P.phaseOn(ps, '2026-08-03').phase, 'follicular'); // 第 8 天
  assert.strictEqual(P.phaseOn(ps, '2026-08-09').phase, 'ovulation');  // 第 14 天
  assert.strictEqual(P.phaseOn(ps, '2026-08-20').phase, 'luteal');     // 第 25 天
});

test('无记录时阶段为 unknown 且不抛错', function () {
  assert.strictEqual(P.phaseOn([], '2026-08-30').phase, 'unknown');
});

console.log('\n[日历标记]');

test('实际经期标记覆盖预测标记', function () {
  var ps = [{ start: '2026-08-01', end: '2026-08-05' }];
  var pred = {
    available: true,
    predictedDate: '2026-08-03',
    window: { start: '2026-08-01', end: '2026-08-05' }
  };
  var marks = P.buildDayMarks(ps, pred, null);
  assert.strictEqual(marks['2026-08-03'].period, true);
  assert.ok(!marks['2026-08-03'].predicted, '已记录的日子不应再标预测');
});

test('预测窗口内标 predicted，核心日标 predictedCore', function () {
  var pred = {
    available: true,
    predictedDate: '2026-09-01',
    window: { start: '2026-08-30', end: '2026-09-03' },
    bleedDays: 1   // 只画 1 天，单独验证窗口边界
  };
  var marks = P.buildDayMarks([], pred, null);
  assert.strictEqual(marks['2026-08-30'].predicted, true);
  assert.strictEqual(marks['2026-09-01'].predictedCore, true);
  assert.ok(!marks['2026-09-04'], '窗口外不该有标记');
});

test('预测经期缎带从预测日起铺满预测天数，可以超出窗口', function () {
  var pred = {
    available: true,
    predictedDate: '2026-09-01',
    window: { start: '2026-08-30', end: '2026-09-03' },
    bleedDays: 5
  };
  var marks = P.buildDayMarks([], pred, null);
  assert.strictEqual(marks['2026-09-01'].predBleed, true);
  assert.strictEqual(marks['2026-09-01'].predBleedStart, true);
  assert.strictEqual(marks['2026-09-01'].predBleedDay, 1);
  // 09-05 是第 5 天，已在窗口（到 09-03）之外，但仍属于这次预测经期
  assert.strictEqual(marks['2026-09-05'].predBleed, true);
  assert.strictEqual(marks['2026-09-05'].predBleedEnd, true);
  assert.strictEqual(marks['2026-09-05'].predBleedDay, 5);
  assert.ok(!marks['2026-09-06'], '第 6 天不该有标记');
});

test('已记录的经期优先于预测缎带，不被覆盖', function () {
  var pred = {
    available: true,
    predictedDate: '2026-09-01',
    window: { start: '2026-09-01', end: '2026-09-01' },
    bleedDays: 5
  };
  var marks = P.buildDayMarks([{ start: '2026-09-02', end: '2026-09-04' }], pred, null);
  assert.strictEqual(marks['2026-09-02'].period, true);
  assert.ok(!marks['2026-09-02'].predBleed, '实际记录不该被预测覆盖');
});

test('未记结束的经期标记 ongoing 且只占 1 天', function () {
  var marks = P.buildDayMarks([{ start: '2026-08-28' }], null, null);
  assert.strictEqual(marks['2026-08-28'].ongoing, true);
  assert.ok(!marks['2026-08-29']);
});

test('空备注不产生标记', function () {
  var notes = { '2026-08-10': { text: '' }, '2026-08-11': { text: '有点累' }, '2026-08-12': null };
  var marks = P.buildDayMarks([], null, notes);
  assert.ok(!marks['2026-08-10']);
  assert.strictEqual(marks['2026-08-11'].note, true);
  assert.ok(!marks['2026-08-12']);
});

test('buildDayMarks 在全空输入下不抛错', function () {
  assert.deepStrictEqual(P.buildDayMarks(null, null, null), {});
});

console.log('\n[历史列表]');

test('历史列表最近在前并标出离群周期', function () {
  var ps = [
    { start: '2026-01-01', end: '2026-01-05' },
    { start: '2026-01-29', end: '2026-02-02' },
    { start: '2026-03-28', end: '2026-04-01' }
  ];
  var h = P.cycleHistory(ps);
  assert.strictEqual(h[0].start, '2026-03-28');
  assert.strictEqual(h[0].periodLength, 5);
  assert.strictEqual(h[0].isOutlier, true); // 58 天
  assert.strictEqual(h[1].cycleLength, 58);
  assert.strictEqual(h[2].cycleLength, 28);
  assert.strictEqual(h[2].isOutlier, false);
});

console.log('\n[经期持续天数预测]');

test('取已结束经期天数的中位数', function () {
  var ps = [
    { start: '2026-01-01', end: '2026-01-05' },   // 5 天
    { start: '2026-01-29', end: '2026-02-04' },   // 7 天
    { start: '2026-02-26', end: '2026-03-01' }    // 4 天
  ];
  assert.deepStrictEqual(P.bleedLengths(ps), [5, 7, 4]);
  var b = P.predictBleedLength(ps);
  assert.strictEqual(b.days, 5);   // 中位数
  assert.strictEqual(b.estimated, false);
  assert.strictEqual(b.sampleSize, 3);
});

test('进行中的经期不参与统计', function () {
  var ps = [
    { start: '2026-01-01', end: '2026-01-05' },
    { start: '2026-01-29' }   // 没标结束
  ];
  assert.deepStrictEqual(P.bleedLengths(ps), [5]);
});

test('异常天数被剔除（1 天多半忘标结束，20 天多半忘了关）', function () {
  var ps = [
    { start: '2026-01-01', end: '2026-01-01' },   // 1 天，剔除
    { start: '2026-01-29', end: '2026-02-02' },   // 5 天，保留
    { start: '2026-02-26', end: '2026-03-20' }    // 23 天，剔除
  ];
  assert.deepStrictEqual(P.bleedLengths(ps), [5]);
});

test('无可用样本时退回默认 5 天并标 estimated', function () {
  var b = P.predictBleedLength([{ start: '2026-01-01' }]);
  assert.strictEqual(b.days, P.DEFAULT_BLEED);
  assert.strictEqual(b.estimated, true);
  assert.strictEqual(b.sampleSize, 0);
});

test('predictNext 带上 bleedDays', function () {
  var ps = [
    { start: '2026-01-01', end: '2026-01-06' },
    { start: '2026-01-29', end: '2026-02-03' },
    { start: '2026-02-26', end: '2026-03-03' }
  ];
  var pred = P.predictNext(ps);
  assert.strictEqual(pred.bleedDays, 6);
  assert.strictEqual(pred.bleedEstimated, false);
});

test('只有一次记录时 predictNext 也给出 bleedDays', function () {
  var pred = P.predictNext([{ start: '2026-01-01', end: '2026-01-04' }]);
  assert.strictEqual(pred.estimated, true);
  assert.strictEqual(pred.bleedDays, 4);
});

console.log('\n[提醒横幅]');

test('无记录时不提醒', function () {
  assert.strictEqual(P.reminder([], '2026-03-01'), null);
});

test('距下次超过 7 天时不打扰', function () {
  var ps = [
    { start: '2026-01-01', end: '2026-01-05' },
    { start: '2026-01-29', end: '2026-02-02' },
    { start: '2026-02-26', end: '2026-03-02' }
  ];
  // 预测 03-26，从 03-01 看还有 25 天
  assert.strictEqual(P.reminder(ps, '2026-03-01'), null);
});

test('3 天内预警 level=soon 并给出日期', function () {
  var ps = [
    { start: '2026-01-01', end: '2026-01-05' },
    { start: '2026-01-29', end: '2026-02-02' },
    { start: '2026-02-26', end: '2026-03-02' }
  ];
  var r = P.reminder(ps, '2026-03-24');
  assert.strictEqual(r.level, 'soon');
  assert.ok(r.title.indexOf('2 天后') > -1, '实际: ' + r.title);
  assert.ok(r.detail.indexOf('2026-03-26') > -1);
});

test('当天预测显示「预计今天来」', function () {
  var ps = [
    { start: '2026-01-01', end: '2026-01-05' },
    { start: '2026-01-29', end: '2026-02-02' },
    { start: '2026-02-26', end: '2026-03-02' }
  ];
  var r = P.reminder(ps, '2026-03-26');
  assert.strictEqual(r.level, 'soon');
  assert.ok(r.title.indexOf('今天') > -1);
});

test('还在预测窗口内的推迟不算迟，明确说是正常', function () {
  var ps = [
    { start: '2026-01-01', end: '2026-01-05' },
    { start: '2026-01-29', end: '2026-02-02' },
    { start: '2026-02-26', end: '2026-03-02' }
  ];
  var r = P.reminder(ps, '2026-03-27');   // 预测 03-26，窗口 ±2
  assert.strictEqual(r.level, 'info');
  assert.ok(r.detail.indexOf('正常') > -1, '实际: ' + r.detail);
});

test('超出窗口的推迟报天数，10 天以上升级为 warn', function () {
  var ps = [
    { start: '2026-01-01', end: '2026-01-05' },
    { start: '2026-01-29', end: '2026-02-02' },
    { start: '2026-02-26', end: '2026-03-02' }
  ];
  var r5 = P.reminder(ps, '2026-03-31');   // 晚 5 天
  assert.strictEqual(r5.level, 'info');
  assert.ok(r5.title.indexOf('晚了 5 天') > -1, '实际: ' + r5.title);

  var r12 = P.reminder(ps, '2026-04-07');  // 晚 12 天
  assert.strictEqual(r12.level, 'warn');
  assert.ok(r12.detail.indexOf('医生') > -1);
});

test('进行中的经期显示第几天', function () {
  var r = P.reminder([{ start: '2026-03-01' }], '2026-03-03');
  assert.strictEqual(r.level, 'ongoing');
  assert.ok(r.title.indexOf('第 3 天') > -1, '实际: ' + r.title);
});

test('进行中的经期超过 12 天转 warn 并提示可能忘标结束', function () {
  var r = P.reminder([{ start: '2026-03-01' }], '2026-03-15');
  assert.strictEqual(r.level, 'warn');
  assert.ok(r.detail.indexOf('忘了标记结束') > -1, '实际: ' + r.detail);
  assert.ok(r.detail.indexOf('医生') > -1);
});

test('提醒不泄露到 warn 以外的措辞：ongoing 不提医生', function () {
  var r = P.reminder([{ start: '2026-03-01' }], '2026-03-02');
  assert.ok(r.detail.indexOf('医生') === -1);
});

console.log('\n[横幅里的经前预告]');

// 三次周期都在经前 3 天出现情绪起伏，预测下次 03-26
var HINT_PS = [
  { start: '2026-01-01', end: '2026-01-05' },
  { start: '2026-01-29', end: '2026-02-02' },
  { start: '2026-02-26', end: '2026-03-02' }
];
var HINT_NOTES = {
  '2025-12-29': { symptoms: ['mood_swings'] },
  '2026-01-26': { symptoms: ['mood_swings'] },
  '2026-02-23': { symptoms: ['mood_swings'] }
};

test('临近预测日时给出「经前常出现什么」的预告', function () {
  var r = P.reminder(HINT_PS, '2026-03-24', HINT_NOTES);   // 还有 2 天
  assert.ok(r.hint, '应有 hint');
  assert.ok(r.hint.indexOf('情绪起伏') > -1, '实际: ' + r.hint);
  assert.ok(r.hint.indexOf('3 天') > -1, '实际: ' + r.hint);
});

test('不传 notes 时行为与升级前完全一致', function () {
  var r = P.reminder(HINT_PS, '2026-03-24');
  assert.strictEqual(r.hint, undefined);
  assert.strictEqual(r.level, 'soon');
});

test('还早的时候不给预告——超出通常提前天数就闭嘴', function () {
  // 距预测还有 6 天，而症状通常提前 3 天，此时说了没用
  var r = P.reminder(HINT_PS, '2026-03-20', HINT_NOTES);
  assert.strictEqual(r.hint, undefined, '实际: ' + r.hint);
});

test('只有一次经前记录时不给预告——一次不构成规律', function () {
  var r = P.reminder(HINT_PS, '2026-03-24', {
    '2026-02-23': { symptoms: ['mood_swings'] }
  });
  assert.strictEqual(r.hint, undefined, '实际: ' + r.hint);
});

test('症状出现率低于半数时不给预告', function () {
  // 四次窗口只有一次出现 → ratio 0.25
  var ps = HINT_PS.concat([{ start: '2026-03-26', end: '2026-03-30' }]);
  var notes = { '2026-03-23': { symptoms: ['acne'] },
    '2025-12-29': { pain: 1 }, '2026-01-26': { pain: 1 }, '2026-02-23': { pain: 1 } };
  var r = P.reminder(ps, '2026-04-22', notes);
  if (r && r.hint) {
    assert.ok(r.hint.indexOf('长痘') === -1, '低频症状不该被当成规律: ' + r.hint);
  }
});

test('已经推迟时不给经前预告——那时说「快来了」没有意义', function () {
  var r = P.reminder(HINT_PS, '2026-03-31', HINT_NOTES);   // 晚 5 天
  assert.strictEqual(r.hint, undefined);
});

console.log('\n[症状趋势]');

var TREND_PS = [
  { start: '2026-01-01', end: '2026-01-05' },
  { start: '2026-01-29', end: '2026-02-02' }
];

test('无记录时 available 为 false', function () {
  var t = P.symptomTrends(TREND_PS, {});
  assert.strictEqual(t.available, false);
  assert.strictEqual(t.recordedCycles, 0);
});

test('按经期归组统计痛感峰值与平均', function () {
  var notes = {
    '2026-01-01': { pain: 2, flow: 'light' },
    '2026-01-02': { pain: 4, flow: 'heavy' },
    '2026-01-03': { pain: 1, flow: 'medium' },
    '2026-01-29': { pain: 3, flow: 'medium' },
    '2026-01-30': { pain: 5, flow: 'heavy' }
  };
  var t = P.symptomTrends(TREND_PS, notes);
  assert.strictEqual(t.available, true);
  assert.strictEqual(t.recordedCycles, 2);
  assert.strictEqual(t.cycles[0].maxPain, 4);
  assert.strictEqual(t.cycles[0].peakFlow, 'heavy');
  assert.strictEqual(t.cycles[1].maxPain, 5);
  assert.strictEqual(t.painMax, 5);
  assert.strictEqual(t.flowCounts.heavy, 2);
  assert.strictEqual(t.flowCounts.medium, 2);
  assert.strictEqual(t.flowCounts.light, 1);
});

test('非经期的备注不计入趋势', function () {
  var notes = {
    '2026-01-02': { pain: 4 },
    '2026-01-20': { pain: 5 }   // 两次经期之间，不该计入
  };
  var t = P.symptomTrends(TREND_PS, notes);
  assert.strictEqual(t.painMax, 4);
  assert.strictEqual(t.recordedCycles, 1);
});

test('找出经期内最疼的是第几天', function () {
  var notes = {
    '2026-01-01': { pain: 1 }, '2026-01-02': { pain: 5 },
    '2026-01-29': { pain: 2 }, '2026-01-30': { pain: 4 }
  };
  var t = P.symptomTrends(TREND_PS, notes);
  assert.strictEqual(t.worstPainDay, 2);
  assert.strictEqual(t.worstPainAvg, 4.5);
});

test('只出现一次的天数不算规律，不报 worstPainDay', function () {
  var notes = { '2026-01-03': { pain: 5 } };
  var t = P.symptomTrends(TREND_PS, notes);
  assert.strictEqual(t.worstPainDay, null);
});

test('pain 为 0 视为未记录', function () {
  var t = P.symptomTrends(TREND_PS, { '2026-01-01': { pain: 0 } });
  assert.strictEqual(t.painMax, null);
});

test('未标结束的经期按默认天数取范围', function () {
  var t = P.symptomTrends([{ start: '2026-03-01' }],
    { '2026-03-03': { pain: 3 }, '2026-03-09': { pain: 5 } });
  assert.strictEqual(t.painMax, 3, '第 9 天超出默认 5 天范围，不该计入');
});

console.log('\n[症状标签]');

test('SYMPTOMS 每项都有 key/label/emoji，key 不重复', function () {
  var seen = {};
  P.SYMPTOMS.forEach(function (s) {
    assert.ok(s.key && s.label && s.emoji, JSON.stringify(s));
    assert.ok(!seen[s.key], '重复 key: ' + s.key);
    seen[s.key] = true;
  });
  assert.ok(P.SYMPTOMS.length >= 10, '症状太少不够用');
});

test('normSymptoms 丢掉未知 key 并去重', function () {
  assert.deepStrictEqual(P.normSymptoms(['cramps', 'nope', 'cramps', 'fatigue']),
    ['cramps', 'fatigue']);
  assert.deepStrictEqual(P.normSymptoms(null), []);
  assert.deepStrictEqual(P.normSymptoms([]), []);
});

console.log('\n[症状排行]');

var SYM_PS = [
  { start: '2026-01-01', end: '2026-01-05' },
  { start: '2026-01-29', end: '2026-02-02' },
  { start: '2026-02-26', end: '2026-03-02' }
];

test('按出现过的经期次数排序，而不是总天数', function () {
  // 头痛在一次经期里连续 3 天，腹痛在 3 次里各 1 天。
  // 按天数排会让头痛胜出，但腹痛才是「每次都有」。
  var notes = {
    '2026-01-01': { symptoms: ['headache'] },
    '2026-01-02': { symptoms: ['headache', 'cramps'] },
    '2026-01-03': { symptoms: ['headache'] },
    '2026-01-30': { symptoms: ['cramps'] },
    '2026-02-27': { symptoms: ['cramps'] }
  };
  var top = P.symptomTrends(SYM_PS, notes).symptomTop;
  assert.strictEqual(top[0].key, 'cramps', '实际: ' + JSON.stringify(top));
  assert.strictEqual(top[0].cycles, 3);
  assert.strictEqual(top[0].days, 3);
  assert.strictEqual(top[1].key, 'headache');
  assert.strictEqual(top[1].cycles, 1);
  assert.strictEqual(top[1].days, 3);
});

test('未知症状 key 不进统计', function () {
  var top = P.symptomTrends(SYM_PS, {
    '2026-01-02': { symptoms: ['cramps', 'made_up_thing'] }
  }).symptomTop;
  assert.strictEqual(top.length, 1);
  assert.strictEqual(top[0].key, 'cramps');
});

test('经期外的症状记录不计入', function () {
  var top = P.symptomTrends(SYM_PS, {
    '2026-01-20': { symptoms: ['cramps'] }   // 两次经期之间
  }).symptomTop;
  assert.deepStrictEqual(top, []);
});

test('只有症状的经期也进 cycles，available 为真', function () {
  var t = P.symptomTrends(SYM_PS, { '2026-01-02': { symptoms: ['acne'] } });
  assert.strictEqual(t.available, true);
  assert.strictEqual(t.cycles.length, 1);
  assert.deepStrictEqual(t.cycles[0].symptoms, ['acne']);
});

console.log('\n[健康提示]');

function ids(r) { return r.items.map(function (i) { return i.id; }); }

test('记录不足 2 次时不给任何结论', function () {
  assert.deepStrictEqual(P.healthInsights([{ start: '2026-01-01' }], {}).items, []);
  assert.deepStrictEqual(P.healthInsights([], {}).items, []);
});

test('每条提示都带 evidence，且不含用药或避孕建议', function () {
  var notes = {
    '2026-01-02': { pain: 5, flow: 'heavy', symptoms: ['cramps'] },
    '2026-01-30': { pain: 5, flow: 'heavy' },
    '2026-02-27': { pain: 4, flow: 'heavy' }
  };
  var r = P.healthInsights(SYM_PS, notes);
  assert.ok(r.items.length > 0);
  r.items.forEach(function (i) {
    assert.ok(i.evidence && i.evidence.length > 0, i.id + ' 缺少 evidence');
    assert.ok(i.level === 'attention' || i.level === 'info', i.id + ' level 非法');
    ['布洛芬', '止痛药', '避孕', '安全期', '受孕'].forEach(function (bad) {
      assert.strictEqual(i.detail.indexOf(bad), -1, i.id + ' 出现禁止词 ' + bad);
    });
  });
});

test('周期普遍偏短时提示 cycle_short', function () {
  var ps = [
    { start: '2026-01-01', end: '2026-01-04' },
    { start: '2026-01-18', end: '2026-01-21' },   // 17 天
    { start: '2026-02-04', end: '2026-02-07' },   // 17 天
    { start: '2026-02-21', end: '2026-02-24' }    // 17 天
  ];
  assert.ok(ids(P.healthInsights(ps, {})).indexOf('cycle_short') > -1);
});

test('周期普遍偏长时提示 cycle_long', function () {
  var ps = [
    { start: '2026-01-01', end: '2026-01-05' },
    { start: '2026-03-10', end: '2026-03-14' },   // 68 天
    { start: '2026-05-20', end: '2026-05-24' }    // 71 天
  ];
  assert.ok(ids(P.healthInsights(ps, {})).indexOf('cycle_long') > -1);
});

test('单次经期超过 12 天就提示，不必等成为规律', function () {
  var ps = [
    { start: '2026-01-01', end: '2026-01-05' },
    { start: '2026-01-29', end: '2026-02-14' }    // 17 天
  ];
  var r = P.healthInsights(ps, {});
  assert.ok(ids(r).indexOf('long_bleed') > -1);
  var item = r.items.filter(function (i) { return i.id === 'long_bleed'; })[0];
  assert.ok(item.evidence.indexOf('17 天') > -1, '实际: ' + item.evidence);
});

test('重度流量天数少于 6 天不提示', function () {
  var notes = { '2026-01-02': { flow: 'heavy' }, '2026-01-30': { flow: 'heavy' } };
  assert.strictEqual(ids(P.healthInsights(SYM_PS, notes)).indexOf('heavy_flow'), -1);
});

test('重度流量达 6 天才提示 heavy_flow，且只是 info', function () {
  var notes = {};
  ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-29', '2026-01-30', '2026-02-26']
    .forEach(function (d) { notes[d] = { flow: 'heavy' }; });
  var r = P.healthInsights(SYM_PS, notes);
  var item = r.items.filter(function (i) { return i.id === 'heavy_flow'; })[0];
  assert.ok(item, '应提示 heavy_flow');
  assert.strictEqual(item.level, 'info');
});

test('高痛感不足 3 次不提示', function () {
  var notes = { '2026-01-02': { pain: 5 }, '2026-01-30': { pain: 4 } };
  assert.strictEqual(ids(P.healthInsights(SYM_PS, notes)).indexOf('high_pain'), -1);
});

test('稳定性判断与提示不会互相矛盾', function () {
  // very_irregular 才提示 very_irregular，阈值不另立一套
  var ps = [
    { start: '2026-01-01' }, { start: '2026-01-23' },   // 22
    { start: '2026-03-02' }, { start: '2026-03-25' }    // 38, 23
  ];
  var stab = P.assessStability(ps);
  var has = ids(P.healthInsights(ps, {})).indexOf('very_irregular') > -1;
  assert.strictEqual(has, stab.status === 'very_irregular',
    'stab=' + stab.status + ' insight=' + has);
});

test('attentionCount 只数 attention 级', function () {
  var r = P.healthInsights([{ start: '2026-01-01', end: '2026-01-05' },
    { start: '2026-01-29', end: '2026-02-02' }], {});
  var real = r.items.filter(function (i) { return i.level === 'attention'; }).length;
  assert.strictEqual(r.attentionCount, real);
});

console.log('\n[经前到经期的逐日规律]');

// 三次周期，每次都在经前 3 天开始有情绪起伏，经期第 2 天最疼。
var TL_PERIODS = [
  { start: '2026-03-01', end: '2026-03-05' },
  { start: '2026-03-29', end: '2026-04-02' },
  { start: '2026-04-26', end: '2026-04-30' }
];
var TL_NOTES = {
  '2026-02-26': { symptoms: ['mood_swings'] },
  '2026-03-01': { flow: 'medium', pain: 2 },
  '2026-03-02': { flow: 'heavy', pain: 5, symptoms: ['cramps'] },
  '2026-03-26': { symptoms: ['mood_swings'] },
  '2026-03-29': { flow: 'medium', pain: 3 },
  '2026-03-30': { flow: 'heavy', pain: 4, symptoms: ['cramps'] },
  '2026-04-23': { symptoms: ['mood_swings'] },
  '2026-04-26': { flow: 'light', pain: 1 },
  '2026-04-27': { flow: 'medium', pain: 5, symptoms: ['cramps'] }
};

test('tlDateFor：负 offset 是经前，正 offset 从开始当天算第 1 天', function () {
  assert.strictEqual(P.tlDateFor('2026-03-01', 1), '2026-03-01');
  assert.strictEqual(P.tlDateFor('2026-03-01', 3), '2026-03-03');
  assert.strictEqual(P.tlDateFor('2026-03-01', -1), '2026-02-28');
  assert.strictEqual(P.tlDateFor('2026-03-01', -7), '2026-02-22');
});

test('offsets 不含 0，且经前列在经期列之前', function () {
  var t = P.timelinePattern(TL_PERIODS, TL_NOTES);
  assert.strictEqual(t.offsets.indexOf(0), -1);
  assert.strictEqual(t.offsets[0], -P.PMS_WINDOW);
  assert.strictEqual(t.offsets[t.offsets.length - 1], P.TL_PERIOD_DAYS);
  assert.strictEqual(t.offsets[P.PMS_WINDOW - 1], -1);
  assert.strictEqual(t.offsets[P.PMS_WINDOW], 1);
});

test('识别出「经前通常提前 3 天」', function () {
  var t = P.timelinePattern(TL_PERIODS, TL_NOTES);
  assert.strictEqual(t.available, true);
  assert.strictEqual(t.trackedCycles, 3);
  assert.strictEqual(t.premenstrual.available, true);
  assert.strictEqual(t.premenstrual.leadDays, 3);
  assert.strictEqual(t.premenstrual.top[0].key, 'mood_swings');
  assert.strictEqual(t.premenstrual.top[0].cycles, 3);
  assert.strictEqual(t.premenstrual.top[0].ratio, 1);
});

test('经期第 2 天平均最疼', function () {
  var t = P.timelinePattern(TL_PERIODS, TL_NOTES);
  var d2 = t.days.filter(function (d) { return d.offset === 2; })[0];
  var d1 = t.days.filter(function (d) { return d.offset === 1; })[0];
  assert.strictEqual(d2.painAvg, 4.7);   // (5+4+5)/3 保留一位
  assert.ok(d2.painAvg > d1.painAvg);
  assert.strictEqual(d2.painMax, 5);
  assert.strictEqual(d2.painDays, 3);
});

test('一条记录都没有的周期不计入分母', function () {
  // 多一次完全没记录的周期，比例不应被稀释
  var ps = TL_PERIODS.concat([{ start: '2026-05-24', end: '2026-05-28' }]);
  var t = P.timelinePattern(ps, TL_NOTES);
  assert.strictEqual(t.trackedCycles, 3, '空周期不该进分母');
  assert.strictEqual(t.premenstrual.top[0].ratio, 1);
});

test('经前窗口剔除落在上一次经期内的日子', function () {
  // 两次经期只隔 8 天：经前 7 天窗口会整段压在上一次出血期上。
  // 那几天的腹痛属于上一次经期，不能算成 PMS。
  var ps = [
    { start: '2026-01-01', end: '2026-01-10' },
    { start: '2026-01-09', end: '2026-01-13' }
  ];
  var notes = { '2026-01-05': { pain: 4, symptoms: ['cramps'] } };
  var t = P.timelinePattern(ps, notes);
  // 1-05 相对第二次经期是「前 4 天」，但它落在第一次经期内 → 不该出现在经前统计
  assert.strictEqual(t.premenstrual.top.filter(function (s) {
    return s.key === 'cramps';
  }).length, 0);
});

test('样本数为 0 的列与「有样本但无症状」区分开', function () {
  // 一次只持续 2 天的经期，第 8 天不存在 → samples 应为 0
  var t = P.timelinePattern([{ start: '2026-03-01', end: '2026-03-02' }],
    { '2026-03-01': { flow: 'light', pain: 2 } });
  var d8 = t.days.filter(function (d) { return d.offset === 8; })[0];
  var d2 = t.days.filter(function (d) { return d.offset === 2; })[0];
  assert.strictEqual(d8.samples, 0);
  assert.strictEqual(d2.samples, 1);
  assert.strictEqual(d2.painAvg, null, '有样本但没记痛感应为 null');
});

test('纯文字备注不算有效记录', function () {
  var t = P.timelinePattern([{ start: '2026-03-01', end: '2026-03-05' }],
    { '2026-03-02': { text: '今天有点累' } });
  assert.strictEqual(t.available, false, '只有文字不该让周期进统计');
});

test('未知症状 key 不进统计', function () {
  var t = P.timelinePattern([{ start: '2026-03-01', end: '2026-03-05' }],
    { '2026-02-27': { symptoms: ['definitely_not_a_symptom', 'cramps'] } });
  var names = t.symptomRows.map(function (r) { return r.key; });
  assert.strictEqual(names.indexOf('definitely_not_a_symptom'), -1);
  assert.ok(names.indexOf('cramps') > -1);
});

test('symptomRows 按总天数降序', function () {
  var t = P.timelinePattern(TL_PERIODS, TL_NOTES);
  for (var i = 1; i < t.symptomRows.length; i++) {
    assert.ok(t.symptomRows[i - 1].days >= t.symptomRows[i].days);
  }
});

test('没有任何记录时不崩且 available 为 false', function () {
  var t = P.timelinePattern([], {});
  assert.strictEqual(t.available, false);
  assert.strictEqual(t.premenstrual.available, false);
  assert.strictEqual(t.days.length, P.PMS_WINDOW + P.TL_PERIOD_DAYS);
});

console.log('\n[CSV 导出]');

function csvRows(text) {
  return text.replace(/\r\n$/, '').split('\r\n');
}

test('表头固定 11 列，行尾用 CRLF', function () {
  var r = P.buildCsv(TL_PERIODS, TL_NOTES);
  var rows = csvRows(r.text);
  assert.strictEqual(rows[0].split(',').length, 11);
  assert.ok(r.text.indexOf('\r\n') > -1);
  assert.strictEqual(rows.length - 1, r.rows);
});

test('经期内每一天都成行，即使那天没记录', function () {
  var r = P.buildCsv([{ start: '2026-03-01', end: '2026-03-05' }], {});
  assert.strictEqual(r.rows, 5);
  var rows = csvRows(r.text);
  assert.ok(rows[1].indexOf('2026-03-01') === 0);
  assert.ok(rows[5].indexOf('2026-03-05') === 0);
});

test('经期外的有效记录也成行（经前症状不会丢）', function () {
  var r = P.buildCsv([{ start: '2026-03-01', end: '2026-03-02' }],
    { '2026-02-26': { symptoms: ['mood_swings'] } });
  assert.ok(r.text.indexOf('2026-02-26') > -1);
  assert.strictEqual(r.rows, 3);
});

test('日期按升序排列', function () {
  var r = P.buildCsv(TL_PERIODS, TL_NOTES);
  var dates = csvRows(r.text).slice(1).map(function (l) { return l.slice(0, 10); });
  var sortedDates = dates.slice().sort();
  assert.deepStrictEqual(dates, sortedDates);
});

test('含逗号的备注被引号包住，不会错列', function () {
  var r = P.buildCsv([{ start: '2026-03-01', end: '2026-03-02' }],
    { '2026-03-01': { flow: 'light', text: '很难受, 请了假' } });
  var line = csvRows(r.text)[1];
  assert.ok(line.indexOf('"很难受, 请了假"') > -1, line);
});

test('备注里的双引号翻倍转义', function () {
  var r = P.buildCsv([{ start: '2026-03-01', end: '2026-03-02' }],
    { '2026-03-01': { flow: 'light', text: '医生说"再观察"' } });
  assert.ok(r.text.indexOf('"医生说""再观察"""') > -1, r.text);
});

test('备注里的换行不会把一行拆成两行', function () {
  var r = P.buildCsv([{ start: '2026-03-01', end: '2026-03-02' }],
    { '2026-03-01': { flow: 'light', text: '第一行\n第二行' } });
  assert.strictEqual(r.rows, 2, '带换行的备注仍应只占一条记录');
  assert.ok(r.text.indexOf('"第一行\n第二行"') > -1);
});

test('以 = + - @ 开头的备注加前缀单引号，防表格软件当公式执行', function () {
  ['=1+1', '+cmd', '-2+3', '@SUM(A1)'].forEach(function (evil) {
    var r = P.buildCsv([{ start: '2026-03-01', end: '2026-03-02' }],
      { '2026-03-01': { flow: 'light', text: evil } });
    assert.ok(r.text.indexOf("'" + evil) > -1, evil + ' 未被中和：' + r.text);
  });
});

test('数字列不加防注入前缀，仍是可计算的数字', function () {
  var r = P.buildCsv([{ start: '2026-03-01', end: '2026-03-02' }],
    { '2026-03-01': { flow: 'medium', pain: 3 } });
  var cols = csvRows(r.text)[1].split(',');
  assert.strictEqual(cols[3], '1');    // 经期第几天
  assert.strictEqual(cols[8], '3');    // 痛感
});

test('痛感 0 视为未记录，导出为空而不是 0', function () {
  var r = P.buildCsv([{ start: '2026-03-01', end: '2026-03-02' }],
    { '2026-03-01': { flow: 'light', pain: 0 } });
  var cols = csvRows(r.text)[1].split(',');
  assert.strictEqual(cols[8], '');
});

test('周期长度只在有下一次经期时才填', function () {
  var r = P.buildCsv(TL_PERIODS, TL_NOTES);
  var rows = csvRows(r.text).slice(1);
  var first = rows.filter(function (l) { return l.indexOf('2026-03-01') === 0; })[0];
  var last = rows.filter(function (l) { return l.indexOf('2026-04-26') === 0; })[0];
  assert.strictEqual(first.split(',')[6], '28');
  assert.strictEqual(last.split(',')[6], '', '最后一次经期没有下一次，长度应为空');
});

test('症状用中文标签、空格分隔（避免与 CSV 分隔符冲突）', function () {
  var r = P.buildCsv([{ start: '2026-03-01', end: '2026-03-02' }],
    { '2026-03-01': { symptoms: ['cramps', 'headache'] } });
  var col = csvRows(r.text)[1].split(',')[9];
  assert.strictEqual(col, '腹痛 头痛');
});

test('没有任何记录时 rows 为 0，只剩表头', function () {
  var r = P.buildCsv([], {});
  assert.strictEqual(r.rows, 0);
  assert.strictEqual(csvRows(r.text).length, 1);
});

test('手改备份塞进来的非法日期 key 不进 CSV', function () {
  var r = P.buildCsv([], { 'not-a-date': { flow: 'light' } });
  assert.strictEqual(r.rows, 0);
});

console.log('\n[修改经期起止日]');

var ED = [
  { start: '2026-06-01', end: '2026-06-05' },
  { start: '2026-06-29', end: '2026-07-03' }
];

test('isDateKey 挡住 2026-02-31 这类形状合法但不存在的日期', function () {
  assert.strictEqual(P.isDateKey('2026-06-01'), true);
  assert.strictEqual(P.isDateKey('2026-02-31'), false);
  assert.strictEqual(P.isDateKey('2026-13-01'), false);
  assert.strictEqual(P.isDateKey('2026-6-1'), false);
  assert.strictEqual(P.isDateKey(''), false);
  assert.strictEqual(P.isDateKey(null), false);
  // 闰年要认得
  assert.strictEqual(P.isDateKey('2028-02-29'), true);
  assert.strictEqual(P.isDateKey('2026-02-29'), false);
});

test('正常改起止日，返回新数组且不改动原数组', function () {
  var snapshot = JSON.stringify(ED);
  var r = P.applyPeriodEdit(ED, '2026-06-01', '2026-06-02', '2026-06-06');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.periods[0].start, '2026-06-02');
  assert.strictEqual(r.periods[0].end, '2026-06-06');
  assert.strictEqual(r.periods[1].start, '2026-06-29', '不该动别的记录');
  assert.strictEqual(JSON.stringify(ED), snapshot, '不能原地改调用方的数组');
});

test('结束日可以清空，表示「还没结束」', function () {
  var r = P.applyPeriodEdit(ED, '2026-06-01', '2026-06-01', null);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.periods[0].end, null);
  assert.strictEqual(r.changed, true);
});

test('日期没变时 changed 为 false（调用方可以据此跳过一次同步）', function () {
  var r = P.applyPeriodEdit(ED, '2026-06-01', '2026-06-01', '2026-06-05');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.changed, false);
});

test('结束日早于开始日被拒', function () {
  var r = P.applyPeriodEdit(ED, '2026-06-01', '2026-06-05', '2026-06-02');
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.indexOf('早于') > -1, '实际: ' + r.error);
});

test('超过 MAX_BLEED 天被拒，且提示里带上那个数字', function () {
  var r = P.applyPeriodEdit(ED, '2026-06-01', '2026-06-01', '2026-06-20');
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.indexOf(String(P.MAX_BLEED)) > -1, '实际: ' + r.error);
});

test('刚好等于 MAX_BLEED 天是允许的（边界不能一起挡掉）', function () {
  var end = P.addDays('2026-06-01', P.MAX_BLEED - 1);
  var r = P.applyPeriodEdit([{ start: '2026-06-01', end: '2026-06-05' }],
    '2026-06-01', '2026-06-01', end);
  assert.strictEqual(r.ok, true, r.error);
});

test('和另一段重叠被拒，错误里点出是哪一段', function () {
  var r = P.applyPeriodEdit(ED, '2026-06-01', '2026-06-25', '2026-06-30');
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.indexOf('2026-06-29') > -1, '实际: ' + r.error);
});

test('紧挨着但不重叠是允许的', function () {
  // 改成 6-24 ~ 6-28，下一段 6-29 开始，差一天
  var r = P.applyPeriodEdit(ED, '2026-06-01', '2026-06-24', '2026-06-28');
  assert.strictEqual(r.ok, true, r.error);
});

test('未标结束的另一段按 DEFAULT_BLEED 估范围参与重叠判断', function () {
  // 第二段没标结束，按 5 天算占到 7-03；新段落在这个范围里应被拒
  var ps = [{ start: '2026-06-01', end: '2026-06-05' }, { start: '2026-06-29', end: null }];
  var r = P.applyPeriodEdit(ps, '2026-06-01', '2026-07-01', '2026-07-04');
  assert.strictEqual(r.ok, false, '进行中的记录不该被当成只占一天');
  assert.ok(r.error.indexOf('重叠') > -1, '实际: ' + r.error);
});

test('未来的日期被拒（经期是已发生的事实）', function () {
  var future = P.addDays(P.todayKey(), 3);
  var r = P.applyPeriodEdit(ED, '2026-06-01', future, null);
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.indexOf('未来') > -1, '实际: ' + r.error);

  var r2 = P.applyPeriodEdit(ED, '2026-06-01', '2026-06-01', future);
  assert.strictEqual(r2.ok, false, '结束日也不能是未来');
});

test('今天本身是允许的（边界）', function () {
  var t = P.todayKey();
  var r = P.applyPeriodEdit([{ start: P.addDays(t, -3), end: null }],
    P.addDays(t, -3), P.addDays(t, -3), t);
  assert.strictEqual(r.ok, true, r.error);
});

test('非法日期与找不到的记录各自给出可读原因', function () {
  assert.ok(P.applyPeriodEdit(ED, '2026-06-01', '2026-02-31', null).error.indexOf('开始日期') > -1);
  assert.ok(P.applyPeriodEdit(ED, '2026-06-01', '2026-06-01', '2026-99-01').error.indexOf('结束日期') > -1);
  assert.ok(P.applyPeriodEdit(ED, '1999-01-01', '2026-06-01', null).error.indexOf('找不到') > -1);
});

test('改完之后周期长度统计跟着变（改的是真数据，不是显示层）', function () {
  // 原本 6-01 → 6-29 是 28 天；把开始日挪到 6-03 就成了 26 天
  var r = P.applyPeriodEdit(ED, '2026-06-01', '2026-06-03', '2026-06-07');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(P.cycleLengths(r.periods), [26]);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
