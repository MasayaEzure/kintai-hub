// 送信済み台帳ストア(MVP_SPEC.md §3)。
// 月末一括フローが Typeform へ送った(送ろうとした)申請を「日付+種別」で記録し、
// 再実行時の送信済みスキップ(二重申請の構造的防止)の照合元になる。
// JSON ファイル永続化: tmp 書き込み → rename の原子的書き込み+世代バックアップ。
// ステータスはブールではなくステートマシンとして遷移を強制する。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from './config.mjs';

const BACKUP_KEEP = 30;

export const KINDS = ['vacation', 'late', 'early'];
export const KIND_LABELS = { vacation: 'お休み', late: '遅参', early: '早帰り' };

// Typeform ステータス遷移(§3-3)。unknown からの遷移は API 層で「到達確認チェック」を要求する
const TF_TRANSITIONS = {
  none: ['submitting'],
  submitting: ['submitted', 'failed', 'unknown'],
  failed: ['submitting'],
  unknown: ['submitting', 'submitted'],
  submitted: [],
};

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
  // dataDir はテストから一時ディレクトリを注入できるようにする(既定は従来どおり data/)
  constructor(dataDir = DATA_DIR) {
    this.storePath = path.join(dataDir, 'store.json');
    this.backupDir = path.join(dataDir, 'backups');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(this.backupDir, { recursive: true });
    if (fs.existsSync(this.storePath)) {
      this.data = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
      this.#recoverStuckSubmitting();
    } else {
      this.data = { exceptions: [], levtechRuns: {} };
      this.#persist();
    }
  }

  // クラッシュ復旧(P1-1): submitting のままプロセスが終了したレコードは、遷移を起こす主体
  // (実行中ジョブ)が消えているため出口がない。送信結果を確定できない状態なので unknown へ
  // 回復し、到達確認つきの resolve-unknown 導線に合流させる(§3-3「確定できない場合は unknown」)
  #recoverStuckSubmitting() {
    let changed = false;
    for (const rec of this.data.exceptions) {
      if (rec.statuses?.typeform === 'submitting') {
        rec.statuses.typeform = 'unknown';
        rec.updatedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) this.#persist();
  }

  #persist() {
    if (fs.existsSync(this.storePath)) {
      const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
      fs.copyFileSync(this.storePath, path.join(this.backupDir, `store-${stamp}-${randomUUID().slice(0, 4)}.json`));
      const backups = fs.readdirSync(this.backupDir).filter((f) => f.startsWith('store-')).sort();
      for (const old of backups.slice(0, Math.max(0, backups.length - BACKUP_KEEP))) {
        fs.unlinkSync(path.join(this.backupDir, old));
      }
    }
    const tmp = this.storePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n');
    fs.renameSync(tmp, this.storePath);
  }

  list() {
    return this.data.exceptions;
  }

  get(id) {
    const rec = this.data.exceptions.find((r) => r.id === id);
    if (!rec) throw new ValidationError(`レコードが見つかりません: ${id}`);
    return rec;
  }

  #validate(input) {
    const { kind, date, endDate, time } = input;
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
    if (!input.reason) throw new ValidationError('申請には理由が必要です');
    // 同一日に矛盾するレコード(重複含む)はエラー
    const from = date;
    const to = endDate ?? date;
    const conflict = this.data.exceptions.find(
      (r) => !r.cancelled && r.date <= to && from <= (r.endDate ?? r.date)
    );
    if (conflict) {
      throw new ValidationError(
        `${conflict.date} に既存のレコード(${KIND_LABELS[conflict.kind] ?? conflict.kind})と重なっています。先に取り消してください`
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
      reason: input.reason,
      reasonDetail: input.reasonDetail || null,
      contacted: input.contacted ?? null,
      statuses: { typeform: 'none' },
      snapshot: null,
      cancelled: false,
      createdAt: now,
      updatedAt: now,
    };
    this.data.exceptions.push(rec);
    this.#persist();
    return rec;
  }

  transitionTypeform(id, next) {
    const rec = this.get(id);
    if (rec.cancelled) throw new ValidationError('取消済みレコードのステータスは変更できません');
    const cur = rec.statuses.typeform;
    if (!(TF_TRANSITIONS[cur] ?? []).includes(next)) {
      throw new ValidationError(`Typeform ステータス遷移が不正です: ${cur} → ${next}`);
    }
    rec.statuses.typeform = next;
    rec.updatedAt = new Date().toISOString();
    this.#persist();
    return rec;
  }

  setSnapshot(id, snapshot) {
    const rec = this.get(id);
    rec.snapshot = snapshot;
    rec.updatedAt = new Date().toISOString();
    this.#persist();
  }

  // 申請が成立していない(none / failed)レコードの取り消し(論理削除。P1-3)。
  // 送信済み(submitted)の台帳整理は cancelSubmitted(手動連絡済みの宣言つき)で行う
  cancelDirect(id) {
    const rec = this.get(id);
    if (rec.cancelled) throw new ValidationError('すでに取り消し済みです');
    if (!['none', 'failed'].includes(rec.statuses.typeform)) {
      throw new ValidationError('送信済み・送信中・送達不明のレコードは取り消せません(取り消しは Typeform から手動で連絡してください)');
    }
    rec.cancelled = true;
    rec.updatedAt = new Date().toISOString();
    this.#persist();
    return rec;
  }

  // 送信済み(submitted)レコードの台帳整理(論理削除)。
  // Typeform への取り消し連絡そのものは自動化できないため、手動で連絡を送った後に
  // 台帳側を取消済みへ揃え、以後の照合(⚠食い違い)から外すための操作。
  // 取消すと同じ日付が再び自動送信の対象に戻るため、API 層で連絡済みチェック(verified)を必須にする。
  // submitting / unknown は送達が未確定のため対象外(unknown は resolve-unknown で確定させてから)
  cancelSubmitted(id) {
    const rec = this.get(id);
    if (rec.cancelled) throw new ValidationError('すでに取り消し済みです');
    if (rec.statuses.typeform !== 'submitted') {
      throw new ValidationError(`台帳から取り消せるのは送信済み(submitted)のみです(現在: ${rec.statuses.typeform})`);
    }
    rec.cancelled = true;
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
