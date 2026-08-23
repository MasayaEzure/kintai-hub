// plan.mjs の純関数テスト: defaultTargetMonth の境界。
// (buildMonthPlan は Excel 唯一情報源化に伴い廃止された)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultTargetMonth } from '../src/plan.mjs';

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
