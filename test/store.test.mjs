// Store のステートマシン・整合性ルール・永続化のユニットテスト。
// 一時ディレクトリを注入するため実データ(data/)には触れない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, ValidationError } from '../src/store.mjs';

const tmpStore = () => new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'kintai-store-')));

const vacation = (date, extra = {}) => ({ kind: 'vacation', date, reason: '私用', ...extra });

// ---- Typeform ステートマシン(§3-3) ----------------------------------------

test('TF遷移: none → submitting → submitted が通る', () => {
  const store = tmpStore();
  const rec = store.create(vacation('2026-09-01'));
  store.transitionTypeform(rec.id, 'submitting');
  store.transitionTypeform(rec.id, 'submitted');
  assert.equal(store.get(rec.id).statuses.typeform, 'submitted');
});

test('TF遷移: submitting → unknown / failed が通る', () => {
  for (const next of ['unknown', 'failed']) {
    const store = tmpStore();
    const rec = store.create(vacation('2026-09-01'));
    store.transitionTypeform(rec.id, 'submitting');
    store.transitionTypeform(rec.id, next);
    assert.equal(store.get(rec.id).statuses.typeform, next);
  }
});

test('TF遷移: failed → submitting(再送)、unknown → submitting / submitted が通る', () => {
  const store = tmpStore();
  const rec = store.create(vacation('2026-09-01'));
  store.transitionTypeform(rec.id, 'submitting');
  store.transitionTypeform(rec.id, 'failed');
  store.transitionTypeform(rec.id, 'submitting'); // failed からの再送
  store.transitionTypeform(rec.id, 'unknown');
  store.transitionTypeform(rec.id, 'submitted'); // unknown からの手動確定
  assert.equal(store.get(rec.id).statuses.typeform, 'submitted');
});

test('TF遷移: 不正遷移は拒否される(none→submitted / submitted→*)', () => {
  const store = tmpStore();
  const rec = store.create(vacation('2026-09-01'));
  assert.throws(() => store.transitionTypeform(rec.id, 'submitted'), ValidationError);
  assert.throws(() => store.transitionTypeform(rec.id, 'unknown'), ValidationError);
  store.transitionTypeform(rec.id, 'submitting');
  store.transitionTypeform(rec.id, 'submitted');
  for (const next of ['submitting', 'failed', 'unknown', 'none']) {
    assert.throws(() => store.transitionTypeform(rec.id, next), ValidationError, `submitted → ${next} は拒否されるべき`);
  }
});

// ---- 整合性ルール ------------------------------------------------------------

test('同一日の重複レコードは拒否される(期間の重なり含む)', () => {
  const store = tmpStore();
  store.create(vacation('2026-09-10', { endDate: '2026-09-12' }));
  assert.throws(() => store.create(vacation('2026-09-10')), ValidationError);
  assert.throws(() => store.create(vacation('2026-09-12')), ValidationError); // 期間の末尾と重なる
  assert.throws(() => store.create({ kind: 'late', date: '2026-09-11', time: '10:00', reason: '私用' }), ValidationError);
  store.create(vacation('2026-09-13')); // 隣接日は OK
});

test('取消済みレコードとは重複可', () => {
  const store = tmpStore();
  const rec = store.create(vacation('2026-09-10'));
  store.cancelDirect(rec.id);
  store.create(vacation('2026-09-10')); // 取消後は同日で作り直せる
});

test('submitted 以降のレコードは直接取消が拒否される', () => {
  const store = tmpStore();
  const rec = store.create(vacation('2026-09-01'));
  store.transitionTypeform(rec.id, 'submitting');
  store.transitionTypeform(rec.id, 'submitted');
  assert.throws(() => store.cancelDirect(rec.id), ValidationError);
});

test('理由なしのレコードは作成できない(全種別が要申請)', () => {
  const store = tmpStore();
  assert.throws(() => store.create({ kind: 'vacation', date: '2026-09-01' }), ValidationError);
  assert.throws(() => store.create({ kind: 'late', date: '2026-09-02', time: '10:00' }), ValidationError);
});

// ---- 永続化 ------------------------------------------------------------------

test('永続化: 別インスタンスで読み直しても内容が一致し、tmp ファイルが残らない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kintai-store-'));
  const store = new Store(dir);
  const rec = store.create(vacation('2026-09-01'));
  store.transitionTypeform(rec.id, 'submitting');
  store.transitionTypeform(rec.id, 'unknown');

  const reloaded = new Store(dir);
  assert.equal(reloaded.get(rec.id).statuses.typeform, 'unknown');
  assert.equal(fs.existsSync(path.join(dir, 'store.json.tmp')), false);
});

test('永続化: 書き込みのたびに世代バックアップが作られる', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kintai-store-'));
  const store = new Store(dir);
  store.create(vacation('2026-09-01'));
  store.create(vacation('2026-09-02'));
  const backups = fs.readdirSync(path.join(dir, 'backups')).filter((f) => f.startsWith('store-'));
  assert.ok(backups.length >= 1, 'バックアップが 1 件以上あるはず');
});
