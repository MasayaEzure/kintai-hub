// カレンダーアダプタ(PoC 05 流用): ローカル → GAS Web App への HTTP POST。
// 冪等(タグで重複検出)なので再実行自由。ブラウザ不要のためジョブキュー外でも実行可。
import { audit } from '../audit.mjs';

// records → GAS イベント配列(custom は申請・登録対象外)
// id(レコード UUID)は GAS 側の重複検出タグに使う(§3-1)
function toEvents(records) {
  return records
    .filter((r) => r.kind !== 'custom')
    .map((r) => ({ id: r.id, date: r.date, kind: r.kind, time: r.time ?? undefined, endDate: r.endDate ?? undefined }));
}

// 戻り値: GAS のレスポンス({ ok, dryRun, results: [{date, kind, status, ...}] })
export async function syncCalendar(config, records, { commit = false } = {}) {
  const events = toEvents(records);
  if (events.length === 0) return { ok: true, dryRun: !commit, results: [] };

  const payload = { secret: config.calendar.sharedSecret, dryRun: !commit, events };
  // Content-Type は text/plain(GAS の定番)、302 リダイレクトに追従必須
  const res = await fetch(config.calendar.webAppUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000), // GAS 無応答でジョブが無限に待たないように(P2-4)
  });
  if (!res.ok) {
    throw new Error(`GAS が HTTP ${res.status} を返しました(デプロイ URL と公開設定を確認してください)`);
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `GAS から JSON 以外の応答が返りました(デプロイ設定の「アクセスできるユーザー: 全員」と新バージョン再デプロイを確認)。応答冒頭: ${text.slice(0, 200)}`
    );
  }
  if (!data.ok) throw new Error(`GAS 側エラー: ${data.error}`);
  if (data.timeZone && data.timeZone !== 'Asia/Tokyo') {
    throw new Error(`GAS のタイムゾーンが Asia/Tokyo ではありません(${data.timeZone})。予定日がずれるため中断しました`);
  }
  if (commit) audit('calendar.sync', { events, results: data.results });
  return data;
}

// 1レコードを実登録し、ストアのカレンダー状態を更新して返す
export async function registerRecordToCalendar(config, store, record, log = () => {}) {
  try {
    const data = await syncCalendar(config, [record], { commit: true });
    const result = data.results[0];
    if (!result || result.status === 'error') {
      throw new Error(result?.error ?? 'GAS から結果が返りませんでした');
    }
    log(`カレンダー: ${result.date} ${result.status}(${result.title ?? ''} ${result.time ?? ''})`);
    store.setCalendar(record.id, 'registered'); // created / skipped(既登録) いずれも登録済み
    return { status: 'registered', detail: result.status };
  } catch (err) {
    log(`カレンダー登録に失敗: ${err.message}`);
    store.setCalendar(record.id, 'failed');
    return { status: 'failed', error: err.message };
  }
}
