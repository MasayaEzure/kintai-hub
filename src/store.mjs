// 例外日ストア(MVP_SPEC.md §3)。
// JSON ファイル永続化: tmp 書き込み → rename の原子的書き込み+世代バックアップ。
// ステータスはブールではなくステートマシンとして遷移を強制する。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from './config.mjs';

const STORE_PATH = path.join(DATA_DIR, 'store.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_KEEP = 30;

export const KINDS = ['vacation', 'late', 'early', 'custom'];
export const REQUEST_KINDS = ['vacation', 'late', 'early']; // 要申請(フロー②)
export const KIND_LABELS = { vacation: 'お休み', late: '遅参', early: '早帰り', custom: '時間変更' };

// Typeform ステータス遷移(§3-3)。unknown からの遷移は API 層で「到達確認チェック」を要求する
const TF_TRANSITIONS = {
  none: ['submitting'],
  submitting: ['submitted', 'failed', 'unknown'],
  failed: ['submitting'],
  unknown: ['submitting', 'submitted'],
  submitted: [],
};
const CAL_STATES = ['none', 'registered', 'failed'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

function isRealDate(iso) {
  if (!DATE_RE.test(iso)) return false;
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

export class Store {
  constructor() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    if (fs.existsSync(STORE_PATH)) {
      this.data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    } else {
      this.data = { exceptions: [], levtechRuns: {} };
      this.#persist();
    }
  }

  #persist() {
    if (fs.existsSync(STORE_PATH)) {
      const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
      fs.copyFileSync(STORE_PATH, path.join(BACKUP_DIR, `store-${stamp}-${randomUUID().slice(0, 4)}.json`));
      const backups = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('store-')).sort();
      for (const old of backups.slice(0, Math.max(0, backups.length - BACKUP_KEEP))) {
        fs.unlinkSync(path.join(BACKUP_DIR, old));
      }
    }
    const tmp = STORE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n');
    fs.renameSync(tmp, STORE_PATH);
  }

  list() {
    return this.data.exceptions;
  }

  get(id) {
    const rec = this.data.exceptions.find((r) => r.id === id);
    if (!rec) throw new ValidationError(`レコードが見つかりません: ${id}`);
    return rec;
  }

  // 有効(取消されていない)レコードのうち、指定日をカバーするもの
  activeOn(dateIso) {
    return this.data.exceptions.filter(
      (r) => !r.cancelled && r.date <= dateIso && dateIso <= (r.endDate ?? r.date)
    );
  }

  #validate(input, { selfId = null } = {}) {
    const { kind, date, endDate, time, start, end, rest } = input;
    if (!KINDS.includes(kind)) throw new ValidationError(`kind が不正です: ${kind}`);
    if (!isRealDate(date)) throw new ValidationError(`date は YYYY-MM-DD 形式で指定してください: ${date}`);
    if (endDate != null && endDate !== '') {
      if (kind !== 'vacation') throw new ValidationError('期間指定(endDate)は連続休暇のみ使えます');
      if (!isRealDate(endDate)) throw new ValidationError(`endDate は YYYY-MM-DD 形式で指定してください: ${endDate}`);
      if (endDate <= date) throw new ValidationError('endDate は date より後の日付を指定してください');
    }
    if (kind === 'late' || kind === 'early') {
      if (!TIME_RE.test(time ?? '')) throw new ValidationError(`${KIND_LABELS[kind]}には時刻(HH:MM)が必要です`);
    }
    if (kind === 'custom') {
      for (const [k, v] of Object.entries({ start, end, rest })) {
        if (!TIME_RE.test(v ?? '')) throw new ValidationError(`custom には ${k}(HH:MM)が必要です`);
      }
    }
    if (REQUEST_KINDS.includes(kind) && !input.reason) {
      throw new ValidationError('申請には理由が必要です');
    }
    // 同一日に矛盾するレコード(重複含む)はエラー
    const from = date;
    const to = endDate ?? date;
    const conflict = this.data.exceptions.find(
      (r) => !r.cancelled && r.id !== selfId && r.date <= to && from <= (r.endDate ?? r.date)
    );
    if (conflict) {
      throw new ValidationError(
        `${conflict.date} に既存の例外日(${KIND_LABELS[conflict.kind]})と重なっています。先に取り消してください`
      );
    }
  }

  create(input) {
    this.#validate(input);
    const now = new Date().toISOString();
    const rec = {
      id: randomUUID(),
      kind: input.kind,
      date: input.date,
      endDate: input.endDate || null,
      time: input.time || null,
      start: input.start || null,
      end: input.end || null,
      rest: input.rest || null,
      reason: input.reason || null,
      reasonDetail: input.reasonDetail || null,
      contacted: input.contacted ?? null,
      statuses: { typeform: 'none', calendar: 'none' },
      snapshot: null,
      cancellation: null, // { typeform, detail, snapshot, calendarCleanupDone }
      cancelled: false,
      createdAt: now,
      updatedAt: now,
    };
    this.data.exceptions.push(rec);
    this.#persist();
    return rec;
  }

  // 編集可能なのは「どこにも反映されていない」レコードのみ(§3-2)
  isEditable(rec) {
    return !rec.cancelled && rec.statuses.typeform === 'none' && rec.statuses.calendar === 'none';
  }

  update(id, input) {
    const rec = this.get(id);
    if (!this.isEditable(rec)) {
      throw new ValidationError('申請済み・登録済みのレコードは編集できません(取り消し→新規作成してください)');
    }
    const merged = { ...rec, ...input };
    this.#validate(merged, { selfId: id });
    Object.assign(rec, {
      kind: merged.kind,
      date: merged.date,
      endDate: merged.endDate || null,
      time: merged.time || null,
      start: merged.start || null,
      end: merged.end || null,
      rest: merged.rest || null,
      reason: merged.reason || null,
      reasonDetail: merged.reasonDetail || null,
      contacted: merged.contacted ?? rec.contacted,
      updatedAt: new Date().toISOString(),
    });
    this.#persist();
    return rec;
  }

  // Typeform ステータス遷移(本申請 target='request' / 取り消し申請 target='cancellation')
  transitionTypeform(id, next, { target = 'request' } = {}) {
    const rec = this.get(id);
    const holder = target === 'cancellation' ? rec.cancellation : rec.statuses;
    if (!holder) throw new ValidationError('取り消し申請が開始されていません');
    const cur = holder.typeform;
    if (!(TF_TRANSITIONS[cur] ?? []).includes(next)) {
      throw new ValidationError(`Typeform ステータス遷移が不正です: ${cur} → ${next}`);
    }
    holder.typeform = next;
    rec.updatedAt = new Date().toISOString();
    this.#persist();
    return rec;
  }

  setSnapshot(id, snapshot, { target = 'request' } = {}) {
    const rec = this.get(id);
    if (target === 'cancellation') rec.cancellation.snapshot = snapshot;
    else rec.snapshot = snapshot;
    rec.updatedAt = new Date().toISOString();
    this.#persist();
  }

  setCalendar(id, state) {
    if (!CAL_STATES.includes(state)) throw new ValidationError(`カレンダー状態が不正です: ${state}`);
    const rec = this.get(id);
    rec.statuses.calendar = state;
    rec.updatedAt = new Date().toISOString();
    this.#persist();
    return rec;
  }

  // 取り消しフロー(§3-2)
  beginCancellation(rec, detail) {
    if (rec.cancelled) throw new ValidationError('すでに取り消し済みです');
    if (!rec.cancellation) {
      rec.cancellation = { typeform: 'none', detail: detail ?? null, snapshot: null, calendarCleanupDone: false };
    } else if (detail) {
      rec.cancellation.detail = detail;
    }
    rec.updatedAt = new Date().toISOString();
    this.#persist();
    return rec;
  }

  markCancelled(id) {
    const rec = this.get(id);
    rec.cancelled = true;
    rec.updatedAt = new Date().toISOString();
    this.#persist();
    return rec;
  }

  // どこにも反映されていないレコードは取り消し申請なしで直接取り消せる
  cancelDirect(id) {
    const rec = this.get(id);
    if (rec.cancelled) throw new ValidationError('すでに取り消し済みです');
    if (!this.isEditable(rec)) {
      throw new ValidationError('申請済み・登録済みのレコードは取り消し申請が必要です');
    }
    rec.cancelled = true;
    rec.updatedAt = new Date().toISOString();
    this.#persist();
    return rec;
  }

  setCalendarCleanupDone(id, done) {
    const rec = this.get(id);
    if (!rec.cancellation) throw new ValidationError('取り消しされていないレコードです');
    rec.cancellation.calendarCleanupDone = !!done;
    rec.updatedAt = new Date().toISOString();
    this.#persist();
    return rec;
  }

  recordLevtechRun(month, entry) {
    this.data.levtechRuns[month] = { ...entry, at: new Date().toISOString() };
    this.#persist();
  }

  levtechRuns() {
    return this.data.levtechRuns;
  }
}
