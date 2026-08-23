// P1 群(統合レビュー)の回帰テスト。
// P1-1: クラッシュ後の submitting 固着 → 起動時に unknown へ回復
// P1-3: 申請未成立(none / failed)レコードの直接取消(同日の作り直しを塞がない)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, ValidationError } from '../src/store.mjs';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kintai-store-'));
const vacation = (date, extra = {}) => ({ kind: 'vacation', date, reason: '私用', ...extra });

// ---- P1-1: 起動時リカバリ ----------------------------------------------------

test('P1-1: submitting 固着レコードは次回起動時に unknown へ回復する', () => {
  const dir = tmpDir();
  const store = new Store(dir);
  const rec = store.create(vacation('2026-09-01'));
  store.transitionTypeform(rec.id, 'submitting');
  // ここでプロセスクラッシュした想定 → 別インスタンスで読み直す
  const reloaded = new Store(dir);
  assert.equal(reloaded.get(rec.id).statuses.typeform, 'unknown');
  // 回復は永続化される(さらに読み直しても unknown のまま)
  assert.equal(new Store(dir).get(rec.id).statuses.typeform, 'unknown');
});

test('P1-1: submitting 以外の状態は起動時に変更されない', () => {
  const dir = tmpDir();
  const store = new Store(dir);
  const a = store.create(vacation('2026-09-01'));
  const b = store.create(vacation('2026-09-02'));
  store.transitionTypeform(b.id, 'submitting');
  store.transitionTypeform(b.id, 'failed');

  const reloaded = new Store(dir);
  assert.equal(reloaded.get(a.id).statuses.typeform, 'none');
  assert.equal(reloaded.get(b.id).statuses.typeform, 'failed');
});

// ---- P1-3: 直接取消 -----------------------------------------------------------

test('P1-3: 申請失敗(failed)のレコードを直接取消でき、同日で作り直せる', () => {
  const store = new Store(tmpDir());
  const rec = store.create(vacation('2026-09-10'));
  store.transitionTypeform(rec.id, 'submitting');
  store.transitionTypeform(rec.id, 'failed');

  store.cancelDirect(rec.id);
  assert.equal(store.get(rec.id).cancelled, true);
  // 取消後は同日で作り直せる(デッドロック解消の目的。再送前の stale 整理もこの経路)
  store.create(vacation('2026-09-10'));
});

test('P1-3: 未送信(none)のレコードも直接取消できる', () => {
  const store = new Store(tmpDir());
  const rec = store.create(vacation('2026-09-10'));
  store.cancelDirect(rec.id);
  assert.equal(store.get(rec.id).cancelled, true);
});

test('P1-3: 送信済み・送信中・送達不明は直接取消できない', () => {
  const cases = [
    ['submitted', ['submitting', 'submitted']],
    ['submitting', ['submitting']],
    ['unknown', ['submitting', 'unknown']],
  ];
  for (const [label, transitions] of cases) {
    const store = new Store(tmpDir());
    const rec = store.create(vacation('2026-09-10'));
    for (const next of transitions) store.transitionTypeform(rec.id, next);
    assert.throws(() => store.cancelDirect(rec.id), ValidationError, `${label} は直接取消できないはず`);
  }
});
