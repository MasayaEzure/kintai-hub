// 月次計画: ストア+祝日データから、レバテック各行の「期待値」を計算する(MVP_SPEC.md §5)。
// 期待値照合方式(F1 手順4)の基準となる唯一の変換表。
import holidayJp from '@holiday-jp/holiday_jp';
import { KIND_LABELS, REQUEST_KINDS } from './store.mjs';

const DOW_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

export function toMinutes(hhmm) {
  if (!hhmm || !hhmm.trim()) return null;
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hhmm.trim());
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function sameTime(a, b) {
  const ma = toMinutes(a);
  const mb = toMinutes(b);
  return ma === mb; // 両方 null(空欄)も一致扱い
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

// month: 'YYYY-MM' / workHours: { start, end, rest }
// 戻り値: { month, days: [{ date, label, dow, dowLabel, expected: {start,end,rest},
//           note, kind, recordId, unsubmitted }] }
export function buildMonthPlan(month, workHours, store) {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw Object.assign(new Error(`month は YYYY-MM 形式で指定してください: ${month}`), { status: 400 });
  const year = Number(m[1]);
  const mon = Number(m[2]);
  const daysInMonth = new Date(year, mon, 0).getDate();

  const holidays = new Map(
    holidayJp
      .between(new Date(year, mon - 1, 1), new Date(year, mon - 1, daysInMonth))
      .map((h) => [h.date.toISOString().slice(0, 10), h.name])
  );

  const days = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${year}-${pad2(mon)}-${pad2(d)}`;
    const label = `${pad2(mon)}/${pad2(d)}`; // レバテック行の日付表記
    const dow = new Date(year, mon - 1, d).getDay();
    const empty = { start: '', end: '', rest: '' };
    const day = { date, label, dow, dowLabel: DOW_LABELS[dow], expected: { ...empty }, note: '', kind: null, recordId: null, unsubmitted: false };

    const holidayName = holidays.get(date);
    const records = store.activeOn(date); // バリデーションにより高々1件
    const rec = records[0] ?? null;

    if (rec) {
      day.kind = rec.kind;
      day.recordId = rec.id;
      // 「未申請バッジ=異常」(§3-1): 要申請 kind なのに submitted でないものを警告
      day.unsubmitted = REQUEST_KINDS.includes(rec.kind) && rec.statuses.typeform !== 'submitted';
      if (rec.kind === 'vacation') {
        day.note = `休暇${rec.endDate ? `(${rec.date}〜${rec.endDate})` : ''}`;
      } else if (rec.kind === 'late') {
        day.expected = { start: rec.time, end: workHours.end, rest: workHours.rest };
        day.note = `遅参(${rec.time} 出社)`;
      } else if (rec.kind === 'early') {
        // time ≤ 13:00 なら休憩なし、それ以外は基本休憩(§5。暫定ルール)
        const rest = toMinutes(rec.time) <= toMinutes('13:00') ? '00:00' : workHours.rest;
        day.expected = { start: workHours.start, end: rec.time, rest };
        day.note = `早帰り(${rec.time} 退社)`;
      } else if (rec.kind === 'custom') {
        day.expected = { start: rec.start, end: rec.end, rest: rec.rest };
        day.note = '時間変更';
      }
    } else if (holidayName) {
      day.note = `祝日(${holidayName})`;
      day.kind = 'holiday';
    } else if (dow === 0 || dow === 6) {
      day.note = '土日';
      day.kind = 'weekend';
    } else {
      day.expected = { ...workHours };
    }
    days.push(day);
  }
  return { month, workHours, days };
}

// 対象月のデフォルト: 月初5日までは前月、それ以降は当月(F1)
export function defaultTargetMonth(now = new Date()) {
  const base = new Date(now.getFullYear(), now.getMonth(), 1);
  if (now.getDate() <= 5) base.setMonth(base.getMonth() - 1);
  return `${base.getFullYear()}-${pad2(base.getMonth() + 1)}`;
}

export function kindLabel(kind) {
  return KIND_LABELS[kind] ?? kind;
}
