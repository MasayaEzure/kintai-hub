// 申請一覧の組み立て・送信済み台帳照合・確認結果の適用(PoC 08 の検証パターンを引き継ぐ)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildApplications,
  reconcile,
  toLedger,
  buildSubmissionPlan,
  applyDecision,
  dateText,
  recordsOverlappingMonth,
} from '../src/applications.mjs';
import { buildAnswers } from '../src/adapters/typeform.mjs';

// excel.mjs の day 形式の最小合成(buildApplications が参照するフィールドのみ)
const day = (date, kind, { note = '', start = null, end = null, warnings = [] } = {}) => ({
  date, kind, note, start, end, warnings,
});

// ---- buildApplications: 種別対応・まとめ・理由推定(PoC 11 パターン) ----------

test('単日の終日休暇 → お休み(理由なしは私用推定)', () => {
  const { apps, excluded } = buildApplications([
    day('2026-08-03', '終日休暇', { note: '終日休暇' }),
    day('2026-08-04', '通常'),
  ]);
  assert.equal(excluded.length, 0);
  assert.deepEqual(apps, [{
    type: 'お休み', date: '2026-08-03', endDate: null, time: null,
    reason: '私用', detail: '', note: '終日休暇', contacted: 'はい',
  }]);
});

test('平日連続の終日休暇は 1 件にまとまり endDate が付く', () => {
  const { apps } = buildApplications([
    day('2026-08-12', '終日休暇', { note: '終日休暇' }),
    day('2026-08-13', '終日休暇', { note: '私用のため終日休暇' }),
    day('2026-08-14', '通常'),
  ]);
  assert.equal(apps.length, 1);
  assert.equal(apps[0].date, '2026-08-12');
  assert.equal(apps[0].endDate, '2026-08-13');
  assert.equal(apps[0].note, '終日休暇 / 私用のため終日休暇');
});

test('土日(休日)を挟んだ終日休暇は別件に分かれる(金+翌月曜)', () => {
  const { apps } = buildApplications([
    day('2026-08-21', '終日休暇', { note: '終日休暇' }), // 金
    day('2026-08-22', '休日'),
    day('2026-08-23', '休日'),
    day('2026-08-24', '終日休暇', { note: '終日休暇' }), // 月
  ]);
  assert.equal(apps.length, 2);
  assert.deepEqual(apps.map((a) => [a.date, a.endDate]), [['2026-08-21', null], ['2026-08-24', null]]);
});

test('遅刻・午前休暇 → 遅参(開始時刻付き)/ 早退・午後休暇 → 早帰り(終了時刻付き)', () => {
  const { apps } = buildApplications([
    day('2026-08-05', '午前休暇', { note: '午前休暇', start: 13 * 60, end: 18 * 60 }),
    day('2026-08-06', '遅刻', { note: '体調不良のため遅刻', start: 10 * 60, end: 18 * 60 }),
    day('2026-08-07', '午後休暇', { note: '午後休暇', start: 9 * 60, end: 12 * 60 }),
    day('2026-08-10', '早退', { note: '早退', start: 9 * 60, end: 16 * 60 }),
  ]);
  assert.deepEqual(apps.map((a) => [a.type, a.time, a.reason]), [
    ['遅参', '13:00', '私用'],
    ['遅参', '10:00', 'ご体調不良'], // 備考に「体調」→ ご体調不良推定
    ['早帰り', '12:00', '私用'],
    ['早帰り', '16:00', '私用'], // 理由なし → 私用推定
  ]);
});

test('中抜け・⚠系は申請対象外(excluded)、通常・休日は何も生成しない', () => {
  const { apps, excluded } = buildApplications([
    day('2026-08-17', '中抜け', { note: '中抜け' }),
    day('2026-08-18', '⚠要確認', { note: '急用のため早上がり', warnings: ['語彙外の備考: 急用のため早上がり'] }),
    day('2026-08-19', '⚠空欄平日', { warnings: ['休暇か記入漏れか判別できません'] }),
    day('2026-08-20', '通常'),
    day('2026-08-22', '休日'),
  ]);
  assert.equal(apps.length, 0);
  assert.deepEqual(excluded.map((x) => x.date), ['2026-08-17', '2026-08-18', '2026-08-19']);
  assert.match(excluded[0].why, /中抜け/);
  assert.match(excluded[1].why, /⚠要確認/);
});

// ---- dateText / buildAnswers: Typeform 日にち欄の書式 -------------------------

test('日にち書式: 単日は M/D、期間は YYYY/MM/DD〜YYYY/MM/DD(記入ガイド準拠)', () => {
  assert.equal(dateText({ date: '2026-08-04', endDate: null }), '8/4');
  assert.equal(dateText({ date: '2026-08-12', endDate: '2026-08-13' }), '2026/08/12〜2026/08/13');
});

test('buildAnswers: 期間書式・時刻・詳細空欄がフォーム仕様どおり', () => {
  const range = buildAnswers({ kind: 'vacation', date: '2026-08-12', endDate: '2026-08-13', time: null, reason: '私用', reasonDetail: null, contacted: true });
  assert.equal(range.type, 'お休み');
  assert.equal(range.date, '2026/08/12〜2026/08/13');
  assert.equal(range.detail, '');

  const late = buildAnswers({ kind: 'late', date: '2026-08-17', endDate: null, time: '13:00', reason: '私用', reasonDetail: null, contacted: true });
  assert.deepEqual([late.type, late.date, late.start, late.end], ['遅参', '8/17', '13:00', '']);

  const early = buildAnswers({ kind: 'early', date: '2026-08-18', endDate: null, time: '12:00', reason: 'ご体調不良', reasonDetail: null, contacted: true });
  assert.deepEqual([early.type, early.date, early.start, early.end, early.contacted], ['早帰り', '8/18', '', '12:00', 'はい']);
});

// ---- reconcile: 台帳照合 -------------------------------------------------------

const app = (type, date, { endDate = null, time = null } = {}) => ({ type, date, endDate, time, reason: '私用', detail: '', note: '', contacted: 'はい' });
const entry = (type, date, { endDate = null, time = null, status = 'submitted', recordId = 'r' } = {}) =>
  ({ type, date, endDate, time, status, recordId });

test('reconcile: 完全一致はスキップ、重なりのみは⚠食い違い、台帳孤児は orphans', () => {
  const apps = [
    app('お休み', '2026-08-03'),
    app('遅参', '2026-08-06', { time: '10:00' }),
    app('お休み', '2026-08-12', { endDate: '2026-08-13' }),
  ];
  const ledger = [
    entry('お休み', '2026-08-03'),                       // 完全一致 → skip
    entry('早帰り', '2026-08-06', { time: '15:00' }),    // 同日で内容違い → mismatch
    entry('お休み', '2026-08-24'),                        // Excel に無い → orphan
  ];
  const { toSend, skipped, mismatched, orphans } = reconcile(apps, ledger);
  assert.deepEqual(toSend.map((a) => a.date), ['2026-08-12']);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].entry.date, '2026-08-03');
  assert.equal(mismatched.length, 1);
  assert.equal(mismatched[0].app.date, '2026-08-06');
  assert.deepEqual(orphans.map((e) => e.date), ['2026-08-24']);
});

test('reconcile: 完全一致でも別の重なりがあれば skip せず⚠食い違いにする(隠れた競合を覆い隠さない)', () => {
  const { toSend, skipped, mismatched } = reconcile(
    [app('お休み', '2026-08-12', { endDate: '2026-08-13' })],
    [
      entry('お休み', '2026-08-12', { endDate: '2026-08-13' }), // 完全一致
      entry('遅参', '2026-08-13', { time: '10:00', recordId: 'r2' }), // 同期間に別エントリ(旧データ等)
    ]
  );
  assert.equal(toSend.length, 0);
  assert.equal(skipped.length, 0);
  assert.equal(mismatched.length, 1);
  assert.equal(mismatched[0].entries.length, 2); // 競合が両方とも見える
});

test('reconcile: 期間の一部でも重なれば送信しない(期間短縮は⚠食い違い)', () => {
  const { toSend, mismatched } = reconcile(
    [app('お休み', '2026-08-12')],
    [entry('お休み', '2026-08-12', { endDate: '2026-08-13' })]
  );
  assert.equal(toSend.length, 0);
  assert.equal(mismatched.length, 1);
});

// ---- toLedger: store レコードの振り分け ---------------------------------------

const rec = (kind, date, tf, extra = {}) => ({
  id: `id-${kind}-${date}-${tf}`, kind, date, endDate: null, time: null,
  statuses: { typeform: tf }, cancelled: false, ...extra,
});

test('toLedger: submitted/submitting/unknown は送信済み扱い、none/failed は作り直し対象、取消済みは除外', () => {
  const { sent, reusable } = toLedger([
    rec('vacation', '2026-08-03', 'submitted'),
    rec('late', '2026-08-06', 'submitting'),
    rec('early', '2026-08-07', 'unknown'),
    rec('vacation', '2026-08-10', 'none'),
    rec('late', '2026-08-11', 'failed'),
    rec('vacation', '2026-08-12', 'submitted', { cancelled: true }),
  ]);
  assert.deepEqual(sent.map((e) => [e.type, e.status]), [['お休み', 'submitted'], ['遅参', 'submitting'], ['早帰り', 'unknown']]);
  assert.deepEqual(reusable.map((e) => e.status), ['none', 'failed']);
});

// ---- recordsOverlappingMonth: 台帳照合の月スコープ -----------------------------

test('recordsOverlappingMonth: 過去月の送信済みは照合対象外になり orphan に出ない', () => {
  const records = [
    rec('vacation', '2026-07-10', 'submitted'),
    rec('vacation', '2026-08-03', 'submitted'),
  ];
  const scoped = recordsOverlappingMonth(records, '2026-08');
  assert.deepEqual(scoped.map((r) => r.date), ['2026-08-03']);
  const plan = buildSubmissionPlan([day('2026-08-03', '終日休暇', { note: '終日休暇' })], scoped);
  assert.equal(plan.orphans.length, 0);
  assert.equal(plan.skipped.length, 1);
});

test('recordsOverlappingMonth: 同月内の orphan(Excel から消えた日)は引き続き検出される', () => {
  const scoped = recordsOverlappingMonth([rec('vacation', '2026-08-24', 'submitted')], '2026-08');
  const plan = buildSubmissionPlan([day('2026-08-03', '通常')], scoped);
  assert.deepEqual(plan.orphans.map((e) => e.date), ['2026-08-24']);
});

test('recordsOverlappingMonth: 月をまたぐ期間レコードは重なりがあれば含める', () => {
  const records = [
    { ...rec('vacation', '2026-07-30', 'submitted'), endDate: '2026-08-01' },
    { ...rec('vacation', '2026-06-29', 'submitted'), endDate: '2026-06-30' },
  ];
  assert.deepEqual(recordsOverlappingMonth(records, '2026-08').map((r) => r.date), ['2026-07-30']);
  assert.deepEqual(recordsOverlappingMonth(records, '2026-07').map((r) => r.date), ['2026-07-30']);
  assert.deepEqual(recordsOverlappingMonth(records, '2026-06').map((r) => r.date), ['2026-06-29']);
});

// ---- buildSubmissionPlan / applyDecision --------------------------------------

test('buildSubmissionPlan: 送信予定に dateText と staleRecordIds が付く', () => {
  const days = [
    day('2026-08-03', '終日休暇', { note: '終日休暇' }),
    day('2026-08-06', '遅刻', { note: '遅刻', start: 10 * 60 }),
  ];
  const records = [
    rec('vacation', '2026-08-03', 'failed'), // 同日の未送信レコード → 作り直し対象
    rec('late', '2026-08-06', 'submitted', { time: '10:00' }), // 完全一致 → skip
  ];
  const plan = buildSubmissionPlan(days, records);
  assert.equal(plan.planned.length, 1);
  assert.equal(plan.planned[0].dateText, '8/3');
  assert.deepEqual(plan.planned[0].staleRecordIds, ['id-vacation-2026-08-03-failed']);
  assert.equal(plan.skipped.length, 1);
});

test('applyDecision: 理由上書きと除外が反映され、省略分は原案どおり', () => {
  const planned = buildSubmissionPlan([
    day('2026-08-03', '終日休暇', { note: '終日休暇' }),
    day('2026-08-06', '遅刻', { note: '遅刻', start: 10 * 60 }),
    day('2026-08-07', '早退', { note: '早退', end: 16 * 60 }),
  ], []).planned;
  const sendList = applyDecision(planned, [
    { index: 0, reason: 'ご体調不良', exclude: false },
    { index: 1, exclude: true },
  ]);
  assert.deepEqual(sendList.map((a) => [a.date, a.reason]), [
    ['2026-08-03', 'ご体調不良'],
    ['2026-08-07', '私用'], // 省略された index=2 は原案どおり送信
  ]);
});

test('applyDecision: 不正な index・理由は throw(レバテック入力前に失敗させる)', () => {
  const planned = buildSubmissionPlan([day('2026-08-03', '終日休暇', { note: '終日休暇' })], []).planned;
  assert.throws(() => applyDecision(planned, [{ index: 9, reason: '私用' }]), /index が不正/);
  assert.throws(() => applyDecision(planned, [{ index: '0', reason: '私用' }]), /index が不正/);
  assert.throws(() => applyDecision(planned, [{ index: 0, reason: '寝坊' }]), /理由が不正/);
});
