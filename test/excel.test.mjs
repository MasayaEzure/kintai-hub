// Excel 取込アダプタ(src/excel.mjs)の単体テスト。
// サンプル実ファイルは gitignore 配下でコミットされないため、単体テストは
// 合成ワークシート(セルオブジェクトを直接組み立てる)で完結させる。
// 実ファイルでの統合テストは、ファイルが存在する場合のみ実行する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  SHEET_NAME,
  ExcelParseError,
  deriveBase,
  cellToMinutes,
  fmtMinutes,
  classify,
  parseWorkbook,
  parseXls,
  toPlanDays,
} from '../src/excel.mjs';

const BASE = deriveBase({ start: '09:00', end: '18:00', rest: '01:00' }); // 実働基準 480 分
const WH = { start: '09:00', end: '18:00', rest: '01:00' };
const min = (h, m = 0) => h * 60 + m;

// ---- 合成ワークシートの組み立て --------------------------------------------
const excelSerial = (y, m, d) => (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000;
// 時刻セル: シリアル値には実ファイル同様の浮動小数の割り切れなさが自然に混入する。
// w は Excel の表示文字列(時は 0 埋めなし)
const timeCell = (m) => ({ t: 'n', v: m / 1440, w: `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}` });

// days: { 日番号: { start, end, rest(分), note } }。指定しない日は空欄
function buildWorkbook({ year = 2026, month = 6, days = {} } = {}) {
  const ws = {};
  ws.D2 = { t: 'n', v: year };
  ws.F2 = { t: 'n', v: month };
  for (const [addr, v] of [
    ['D8', '日'], ['E8', '曜日'], ['F9', '開始'], ['G9', '終了'],
    ['H8', '休憩時間'], ['I8', '実働時間'], ['I9', '実作業'], ['L9', '備考'],
  ]) ws[addr] = { t: 's', v };

  const dim = new Date(year, month, 0).getDate();
  let total = 0;
  for (let d = 1; d <= dim; d++) {
    const r = 10 + d;
    ws[`A${r}`] = { t: 'n', v: excelSerial(year, month, d) };
    const spec = days[d];
    if (!spec) continue;
    if (spec.start !== undefined) ws[`F${r}`] = timeCell(spec.start);
    if (spec.end !== undefined) ws[`G${r}`] = timeCell(spec.end);
    if (spec.rest !== undefined) ws[`H${r}`] = timeCell(spec.rest);
    if (spec.note) ws[`L${r}`] = { t: 's', v: spec.note };
    if (spec.start !== undefined && spec.end !== undefined) total += spec.end - spec.start - (spec.rest ?? 0);
  }
  ws.N43 = { t: 'n', v: total / 1440 };
  return { SheetNames: [SHEET_NAME], Sheets: { [SHEET_NAME]: ws } };
}

// 2026-06(30日・祝日なし)の平日を通常勤務で埋めた days 指定を返す
function normalJune(overrides = {}) {
  const days = {};
  for (let d = 1; d <= 30; d++) {
    const dow = new Date(2026, 5, d).getDay();
    if (dow !== 0 && dow !== 6) days[d] = { start: min(9), end: min(18), rest: min(1) };
  }
  return { ...days, ...overrides };
}

// ---- cellToMinutes: 0:00 / 空欄 / "" キャッシュ / エラー型の厳密区別 --------
test('cellToMinutes: 0:00(シリアル値0)と空欄と""キャッシュを厳密区別する', () => {
  assert.equal(cellToMinutes({ t: 'n', v: 0 }), 0); // 0:00 は 0(falsy だが空欄ではない)
  assert.equal(cellToMinutes(undefined), null); // セル欠落 = 空欄
  assert.equal(cellToMinutes({ t: 's', v: '' }), null); // 数式の "" キャッシュ
  assert.equal(cellToMinutes({ t: 's', v: '  ' }), null);
  assert.equal(cellToMinutes({ t: 'n', v: 0.375 }), 540); // 9:00
  assert.equal(cellToMinutes({ t: 's', v: '9:00' }), 540); // 文字列時刻も許容
});

test('cellToMinutes: 浮動小数の汚れは丸めで吸収する', () => {
  assert.equal(cellToMinutes({ t: 'n', v: 0.33333333333333326 }), 480); // 8:00 の実例の汚れ
  assert.equal(cellToMinutes({ t: 'n', v: min(21, 15) / 1440 }), min(21, 15)); // 端数時刻 21:15
});

test('cellToMinutes: エラー型・時刻でない文字列・想定外型は throw する', () => {
  assert.throws(() => cellToMinutes({ t: 'e', v: 23 }, 'M43'), /エラー型/);
  assert.throws(() => cellToMinutes({ t: 's', v: '休み' }, 'F11'), /時刻でない文字列/);
  assert.throws(() => cellToMinutes({ t: 'b', v: true }, 'F11'), /想定外の型/);
});

// ---- classify: 分類ルール全パターン(確定ルール 2026-08-18) ------------------
const day = (over = {}) => ({
  start: null, end: null, rest: null, note: '', dowLabel: '月', holidayName: null, ...over,
});

test('classify: 空欄の分類(終日休暇・祝日・土日・語彙外備考・空欄平日)', () => {
  // 理由併記も「含む」で照合できる
  assert.equal(classify(day({ note: '私用のため終日休暇' }), BASE).kind, '終日休暇');
  const holiday = classify(day({ holidayName: '海の日' }), BASE);
  assert.equal(holiday.kind, '休日');
  assert.match(holiday.warnings[0], /海の日/);
  assert.equal(classify(day({ dowLabel: '土' }), BASE).kind, '休日');
  assert.equal(classify(day({ dowLabel: '日' }), BASE).kind, '休日');
  // 空欄なのに語彙外の備考だけある日は安全網で要確認に落とす
  const noteOnly = classify(day({ note: '調整中' }), BASE);
  assert.equal(noteOnly.kind, '⚠要確認');
  // 空欄の平日は休暇か記入漏れか判別できない → 警告付きスキップ対象
  const emptyWeekday = classify(day(), BASE);
  assert.equal(emptyWeekday.kind, '⚠空欄平日');
  assert.equal(emptyWeekday.warnings.length, 1);
});

test('classify: 片方だけ空欄・出勤日の休憩空欄', () => {
  assert.equal(classify(day({ start: min(9) }), BASE).kind, '⚠要確認');
  assert.equal(classify(day({ end: min(18) }), BASE).kind, '⚠要確認');
  // 出勤日の H 列は必ず値が入る想定(半休時は 0:00)。空欄は警告
  const restMissing = classify(day({ start: min(9), end: min(18) }), BASE);
  assert.equal(restMissing.kind, '通常'); // 実働 9h ≥ 基準 8h
  assert.match(restMissing.warnings[0], /休憩が空欄/);
});

test('classify: 半休(午前休暇・午後休暇)と整合性チェック', () => {
  const am = classify(day({ start: min(13), end: min(18), rest: 0, note: '午前休暇' }), BASE);
  assert.deepEqual([am.kind, am.warnings], ['午前休暇', []]);
  const amBad = classify(day({ start: min(12), end: min(18), rest: min(1), note: '午前休暇' }), BASE);
  assert.equal(amBad.kind, '午前休暇'); // キーワードがラベルを決め、値条件は警告に降格
  assert.equal(amBad.warnings.length, 2); // 開始が13:00より前+休憩が0:00でない

  const pm = classify(day({ start: min(9), end: min(12), rest: 0, note: '午後休暇' }), BASE);
  assert.deepEqual([pm.kind, pm.warnings], ['午後休暇', []]);
  const pmBad = classify(day({ start: min(9), end: min(13), rest: 0, note: '午後休暇' }), BASE);
  assert.equal(pmBad.kind, '午後休暇');
  assert.equal(pmBad.warnings.length, 1);
});

test('classify: 遅刻・早退・中抜けと整合性チェック', () => {
  assert.equal(classify(day({ start: min(10), end: min(18), rest: min(1), note: '寝坊により遅刻' }), BASE).kind, '遅刻');
  const lateBad = classify(day({ start: min(9), end: min(18), rest: min(1), note: '遅刻' }), BASE);
  assert.equal(lateBad.kind, '遅刻');
  assert.match(lateBad.warnings[0], /開始が基準/);

  assert.equal(classify(day({ start: min(9), end: min(16), rest: min(1), note: '早退' }), BASE).kind, '早退');
  const earlyBad = classify(day({ start: min(9), end: min(18), rest: min(1), note: '早退' }), BASE);
  assert.match(earlyBad.warnings[0], /終了が基準/);

  assert.equal(classify(day({ start: min(9), end: min(19), rest: min(2), note: '通院で中抜け' }), BASE).kind, '中抜け');
  const nukeBad = classify(day({ start: min(9), end: min(18), rest: min(1), note: '中抜け' }), BASE);
  assert.match(nukeBad.warnings[0], /休憩が基準/);
});

test('classify: 値あり+備考なしは実働と基準の比較で通常/要確認', () => {
  assert.equal(classify(day({ start: min(9), end: min(18), rest: min(1) }), BASE).kind, '通常');
  // 時差勤務(8:30-17:30)も実働が基準以上なら通常
  assert.equal(classify(day({ start: min(8, 30), end: min(17, 30), rest: min(1) }), BASE).kind, '通常');
  const short = classify(day({ start: min(9), end: min(17), rest: min(1) }), BASE);
  assert.equal(short.kind, '⚠要確認');
  assert.match(short.warnings[0], /基準.*未満なのに備考なし/);
});

test('classify: 語彙外の備考・終日休暇なのに時刻・複数キーワードの安全網', () => {
  // 統制語彙からの逸脱検知(7/2「急用のため早上がり」が実例)
  const offVocab = classify(day({ start: min(9), end: min(15), rest: min(1), note: '急用のため早上がり' }), BASE);
  assert.equal(offVocab.kind, '⚠要確認');
  assert.match(offVocab.warnings[0], /語彙外の備考/);

  assert.equal(classify(day({ start: min(9), end: min(18), rest: min(1), note: '終日休暇' }), BASE).kind, '⚠要確認');

  const multi = classify(day({ start: min(10), end: min(16), rest: min(1), note: '遅刻・早退' }), BASE);
  assert.equal(multi.kind, '遅刻'); // 先頭キーワード優先
  assert.match(multi.warnings[0], /複数キーワード/);
});

// ---- parseWorkbook: 正常系 ---------------------------------------------------
test('parseWorkbook: 平日埋めの月を読み、月・日数・分類・合計が整合する', () => {
  const wb = buildWorkbook({
    days: normalJune({
      2: { note: '私用のため終日休暇' }, // 6/2(火) 空欄+備考
      3: { start: min(13), end: min(18), rest: 0, note: '午前休暇' },
      30: undefined, // 6/30(火) 空欄平日
    }),
  });
  const parsed = parseWorkbook(wb, WH);
  assert.equal(parsed.month, '2026-06');
  assert.equal(parsed.days.length, 30);
  const byDate = new Map(parsed.days.map((d) => [d.date, d]));
  assert.equal(byDate.get('2026-06-02').kind, '終日休暇');
  assert.equal(byDate.get('2026-06-03').kind, '午前休暇');
  assert.equal(byDate.get('2026-06-06').kind, '休日'); // 土
  assert.equal(byDate.get('2026-06-30').kind, '⚠空欄平日');
  assert.equal(byDate.get('2026-06-01').kind, '通常');
  // 実働合計 = 通常 19 日(平日 22 − 上書き 3)× 8h + 午前休暇 5h = 9420 分(N43 と一致して throw しない)
  assert.equal(parsed.totalMinutes, 19 * 480 + 300);
});

// ---- parseWorkbook: テンプレ不変条件(静かに壊れず大声で失敗する) --------------
test('parseWorkbook: シートなし・年月セル異常は即 throw する', () => {
  assert.throws(() => parseWorkbook({ SheetNames: ['別シート'], Sheets: {} }, WH), /シート「.*」がありません/);

  const wb = buildWorkbook({ days: normalJune() });
  wb.Sheets[SHEET_NAME].D2 = { t: 's', v: '2026年' }; // 数値でない年
  assert.throws(() => parseWorkbook(wb, WH), (err) => {
    assert.ok(err instanceof ExcelParseError);
    assert.equal(err.status, 400);
    assert.match(err.problems[0], /D2\(年\)が想定外/);
    return true;
  });
});

test('parseWorkbook: ヘッダ改ざん・日行の日付不一致・余剰行を全件検出する', () => {
  const wb = buildWorkbook({ days: normalJune() });
  const ws = wb.Sheets[SHEET_NAME];
  ws.F9 = { t: 's', v: '開始時刻' }; // ヘッダ改ざん
  ws.A11 = { t: 'n', v: excelSerial(2026, 6, 2) }; // 1日の行に2日の日付
  ws.D41 = { t: 'n', v: 31 }; // 30日の月なのに31日目の行に日付が残存
  assert.throws(() => parseWorkbook(wb, WH), (err) => {
    assert.ok(err instanceof ExcelParseError);
    assert.equal(err.problems.length, 3);
    assert.match(err.message, /ヘッダ F9/);
    assert.match(err.message, /A11 の日付/);
    assert.match(err.message, /余剰行 D41/);
    return true;
  });
});

test('parseWorkbook: 丸め結果と Excel 表示(w)の不一致を検出する', () => {
  const wb = buildWorkbook({ days: normalJune() });
  wb.Sheets[SHEET_NAME].F11.w = '9:01'; // シリアル値 9:00 に対し表示だけ 9:01
  assert.throws(() => parseWorkbook(wb, WH), /F11: 丸め=09:00 が Excel 表示="9:01" と不一致/);
});

test('parseWorkbook: 読み取り対象セルのエラー型(#REF!)を検出する', () => {
  const wb = buildWorkbook({ days: normalJune() });
  wb.Sheets[SHEET_NAME].G12 = { t: 'e', v: 23, w: '#REF!' };
  assert.throws(() => parseWorkbook(wb, WH), /G12 がエラー型/);
});

test('parseWorkbook: 実働合計がファイル集計(N43)と合わなければ throw する', () => {
  const wb = buildWorkbook({ days: normalJune() });
  wb.Sheets[SHEET_NAME].N43 = timeCell(min(100)); // 改ざんされた合計
  assert.throws(() => parseWorkbook(wb, WH), /月間実働合計の突合不一致/);
});

test('parseXls: Excel でないバイナリは ExcelParseError(400)に正規化される', () => {
  assert.throws(() => parseXls(Buffer.from('これは xls ではない'), WH), (err) => {
    assert.ok(err instanceof ExcelParseError);
    assert.equal(err.status, 400);
    return true;
  });
});

// ---- toPlanDays: テンプレ不変条件(送信値は F/G/H 素通し) ---------------------
test('toPlanDays: 送信値は F/G/H の素通しで、分類結果による加工をしない', () => {
  const wb = buildWorkbook({
    days: normalJune({
      1: { start: min(9), end: min(17), rest: min(1) }, // ⚠要確認(実働 7h)だが値は素通し
      3: { start: min(13), end: min(18), rest: 0, note: '午前休暇' }, // 半休の休憩 0:00
    }),
  });
  const plan = toPlanDays(parseWorkbook(wb, WH).days);
  const byDate = new Map(plan.map((d) => [d.date, d]));

  const short = byDate.get('2026-06-01');
  assert.equal(short.excelKind, '⚠要確認');
  assert.deepEqual(short.expected, { start: '09:00', end: '17:00', rest: '01:00' }); // 加工なし
  assert.equal(short.warnings.length, 1);

  const am = byDate.get('2026-06-03');
  assert.deepEqual(am.expected, { start: '13:00', end: '18:00', rest: '00:00' }); // 0:00 は "00:00"

  const weekend = byDate.get('2026-06-06');
  assert.deepEqual(weekend.expected, { start: '', end: '', rest: '' }); // 空欄はスキップ対象
  assert.equal(weekend.excelKind, '休日');

  // フロー①の既存安全機構が期待する形(classifyRows/applyRows と互換)
  const d1 = byDate.get('2026-06-02');
  assert.equal(d1.label, '06/02');
  assert.equal(d1.dowLabel, '火');
  assert.equal(d1.recordId, null);
  assert.equal(d1.unsubmitted, false);
});

test('fmtMinutes: null は空文字、0 は "00:00"', () => {
  assert.equal(fmtMinutes(null), '');
  assert.equal(fmtMinutes(0), '00:00');
  assert.equal(fmtMinutes(min(21, 15)), '21:15');
});

// ---- 統合テスト: サンプル実ファイル(gitignore 配下。存在する場合のみ) ---------
const SAMPLE = path.join('data', 'samples', '作業実績表_202607.xls');
test('実ファイル統合: 2026-07 のサンプルをパースできる', { skip: !fs.existsSync(SAMPLE) && 'サンプル実ファイルなし' }, () => {
  const parsed = parseXls(fs.readFileSync(SAMPLE), WH);
  assert.equal(parsed.month, '2026-07');
  assert.equal(parsed.days.length, 31);
  assert.equal(parsed.totalMinutes, min(158, 15)); // ファイル集計 N43 = 158:15(PoC で実証)
  // 7/2「急用のため早上がり」は語彙外備考の安全網で要確認に落ちる(実例)
  assert.equal(parsed.days[1].kind, '⚠要確認');
  assert.ok(parsed.days.some((d) => d.kind === '通常'));
});
