// plan.mjs の純関数テスト: defaultTargetMonth の境界と、early の休憩 13:00 境界(§5 暫定ルール)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultTargetMonth, buildMonthPlan } from '../src/plan.mjs';

// ---- defaultTargetMonth(F1: 月初5日までは前月、それ以降は当月) ----------------

test('defaultTargetMonth: 月初5日までは前月を返す', () => {
  assert.equal(defaultTargetMonth(new Date(2026, 7, 1)), '2026-07'); // 8/1
  assert.equal(defaultTargetMonth(new Date(2026, 7, 5)), '2026-07'); // 8/5(境界)
});

test('defaultTargetMonth: 6日以降は当月を返す', () => {
  assert.equal(defaultTargetMonth(new Date(2026, 7, 6)), '2026-08'); // 8/6(境界の翌日)
  assert.equal(defaultTargetMonth(new Date(2026, 7, 31)), '2026-08');
});

test('defaultTargetMonth: 年跨ぎ(1月5日以前は前年12月)', () => {
  assert.equal(defaultTargetMonth(new Date(2027, 0, 1)), '2026-12');
  assert.equal(defaultTargetMonth(new Date(2027, 0, 5)), '2026-12');
  assert.equal(defaultTargetMonth(new Date(2027, 0, 6)), '2027-01');
});

// ---- buildMonthPlan: early の休憩境界(time ≤ 13:00 なら 0:00、それ以外は基本休憩) ----

const WH = { start: '09:00', end: '18:00', rest: '01:00' };
const fakeStore = (records) => ({
  activeOn: (date) => records.filter((r) => !r.cancelled && r.date <= date && date <= (r.endDate ?? r.date)),
});
const earlyRec = (date, time) => ({
  id: 'rec-early',
  kind: 'early',
  date,
  endDate: null,
  time,
  statuses: { typeform: 'submitted', calendar: 'registered' },
  cancelled: false,
});
const dayOf = (plan, date) => plan.days.find((d) => d.date === date);

test('early: 退社 13:00 ちょうどは休憩 0:00', () => {
  const plan = buildMonthPlan('2026-09', WH, fakeStore([earlyRec('2026-09-01', '13:00')]));
  assert.deepEqual(dayOf(plan, '2026-09-01').expected, { start: '09:00', end: '13:00', rest: '00:00' });
});

test('early: 退社 12:30(13:00 より前)も休憩 0:00', () => {
  const plan = buildMonthPlan('2026-09', WH, fakeStore([earlyRec('2026-09-01', '12:30')]));
  assert.deepEqual(dayOf(plan, '2026-09-01').expected, { start: '09:00', end: '12:30', rest: '00:00' });
});

test('early: 退社 13:01(13:00 超)は基本休憩', () => {
  const plan = buildMonthPlan('2026-09', WH, fakeStore([earlyRec('2026-09-01', '13:01')]));
  assert.deepEqual(dayOf(plan, '2026-09-01').expected, { start: '09:00', end: '13:01', rest: '01:00' });
});

test('early: 退社 16:00 は基本休憩(UI で変更した rest を使う)', () => {
  const wh = { start: '10:00', end: '19:00', rest: '00:45' };
  const plan = buildMonthPlan('2026-09', wh, fakeStore([earlyRec('2026-09-01', '16:00')]));
  assert.deepEqual(dayOf(plan, '2026-09-01').expected, { start: '10:00', end: '16:00', rest: '00:45' });
});
