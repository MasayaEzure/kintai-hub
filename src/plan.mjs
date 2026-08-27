// 時刻ユーティリティと対象月の既定値。
// (旧: ストアからの月次計画 buildMonthPlan は Excel 唯一情報源化に伴い廃止。
//  期待値照合の基準は excel.mjs toPlanDays が組み立てる)
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

// 対象月のデフォルト: 月初5日までは前月、それ以降は当月(F1)
export function defaultTargetMonth(now = new Date()) {
  const base = new Date(now.getFullYear(), now.getMonth(), 1);
  if (now.getDate() <= 5) base.setMonth(base.getMonth() - 1);
  return `${base.getFullYear()}-${pad2(base.getMonth() + 1)}`;
}
