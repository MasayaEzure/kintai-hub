// levtech.mjs の純関数テスト: 期待値照合(classifyRows)・最終突合(finalExpectedState /
// verifyAgainst)・期待値ありの行なし検出(absentExpectedRows。P2-2)。ブラウザは起動しない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRows,
  finalExpectedState,
  verifyAgainst,
  absentExpectedRows,
} from '../src/adapters/levtech.mjs';

const WORK = { start: '09:00', end: '18:00', rest: '01:00' };
const EMPTY = { start: '', end: '', rest: '' };
const day = (label, expected) => ({
  date: `2026-09-${label.slice(3)}`,
  label,
  dowLabel: '火',
  note: '',
  expected,
});

// ---- classifyRows(F1 手順4) -------------------------------------------------

test('classifyRows: 空欄行に期待値あり → fill', () => {
  const rows = classifyRows([day('09/01', { ...WORK })], new Map([['09/01', { ...EMPTY }]]));
  assert.equal(rows[0].action, 'fill');
});

test('classifyRows: 期待も既存も空欄(休暇・土日)→ skip', () => {
  const rows = classifyRows([day('09/01', { ...EMPTY })], new Map([['09/01', { ...EMPTY }]]));
  assert.equal(rows[0].action, 'skip');
});

test('classifyRows: 既存値が期待値と一致 → match(9:00 と 09:00 の表記ゆれも一致扱い)', () => {
  const rows = classifyRows(
    [day('09/01', { ...WORK })],
    new Map([['09/01', { start: '9:00', end: '18:00', rest: '1:00' }]])
  );
  assert.equal(rows[0].action, 'match');
});

test('classifyRows: 既存値が期待値と異なる → mismatch(勝手に触らない)', () => {
  const rows = classifyRows(
    [day('09/01', { ...WORK })],
    new Map([['09/01', { start: '10:00', end: '18:00', rest: '01:00' }]])
  );
  assert.equal(rows[0].action, 'mismatch');
});

test('classifyRows: 期待値は空欄なのに既存値あり → mismatch(休暇日に勤怠が残るケース)', () => {
  const rows = classifyRows(
    [day('09/01', { ...EMPTY })],
    new Map([['09/01', { start: '09:00', end: '18:00', rest: '01:00' }]])
  );
  assert.equal(rows[0].action, 'mismatch');
});

test('classifyRows: 行が見つからない → absent', () => {
  const rows = classifyRows([day('09/01', { ...WORK })], new Map());
  assert.equal(rows[0].action, 'absent');
  assert.equal(rows[0].existing, null);
});

// ---- absentExpectedRows(P2-2: 期待値ありの行なしは無警告スキップしない) --------

test('absentExpectedRows: 期待値があるのに行がない日だけを返す', () => {
  const rows = classifyRows(
    [day('09/01', { ...WORK }), day('09/02', { ...EMPTY }), day('09/03', { ...WORK })],
    new Map([['09/03', { ...EMPTY }]])
  );
  const missing = absentExpectedRows(rows);
  assert.deepEqual(missing.map((r) => r.label), ['09/01']);
});

test('absentExpectedRows: 期待値が空欄の行なし(月末の存在しない日など)は対象外', () => {
  const rows = classifyRows([day('09/02', { ...EMPTY })], new Map());
  assert.deepEqual(absentExpectedRows(rows), []);
});

// ---- finalExpectedState / verifyAgainst(F1 手順6) ---------------------------

test('finalExpectedState: fill と承認済み mismatch は期待値、未承認 mismatch は現状維持', () => {
  const rows = classifyRows(
    [day('09/01', { ...WORK }), day('09/02', { ...WORK }), day('09/03', { ...WORK })],
    new Map([
      ['09/01', { ...EMPTY }], // fill
      ['09/02', { start: '10:00', end: '18:00', rest: '01:00' }], // mismatch(承認)
      ['09/03', { start: '11:00', end: '18:00', rest: '01:00' }], // mismatch(未承認)
    ])
  );
  const finals = finalExpectedState(rows, ['2026-09-02']);
  assert.deepEqual(finals[0].finalValues, WORK);
  assert.deepEqual(finals[1].finalValues, WORK);
  assert.deepEqual(finals[2].finalValues, { start: '11:00', end: '18:00', rest: '01:00' });
});

test('verifyAgainst: 再スクレイプが最終期待状態と一致すれば差分なし', () => {
  const rows = classifyRows([day('09/01', { ...WORK })], new Map([['09/01', { ...EMPTY }]]));
  const finals = finalExpectedState(rows, []);
  const rescraped = new Map([['09/01', { start: '9:00', end: '18:00', rest: '1:00' }]]);
  assert.deepEqual(verifyAgainst(finals, rescraped), []);
});

test('verifyAgainst: 値の不一致は差分として報告される', () => {
  const rows = classifyRows([day('09/01', { ...WORK })], new Map([['09/01', { ...EMPTY }]]));
  const finals = finalExpectedState(rows, []);
  const rescraped = new Map([['09/01', { start: '09:00', end: '17:00', rest: '01:00' }]]);
  const diffs = verifyAgainst(finals, rescraped);
  assert.equal(diffs.length, 1);
  assert.match(diffs[0], /09\/01/);
});

test('verifyAgainst: 再取得で行が消えた場合も差分として報告される', () => {
  const rows = classifyRows([day('09/01', { ...WORK })], new Map([['09/01', { ...EMPTY }]]));
  const finals = finalExpectedState(rows, []);
  const diffs = verifyAgainst(finals, new Map());
  assert.equal(diffs.length, 1);
  assert.match(diffs[0], /行が見つかりません/);
});

test('verifyAgainst: absent の行は突合対象外', () => {
  const rows = classifyRows([day('09/02', { ...EMPTY })], new Map());
  const finals = finalExpectedState(rows, []);
  assert.deepEqual(verifyAgainst(finals, new Map()), []);
});
