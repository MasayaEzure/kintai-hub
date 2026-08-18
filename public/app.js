// 勤怠ハブ UI。素の JS(ビルドなし)。サーバーの API をポーリングして描画する。
const TOKEN = document.querySelector('meta[name="kintai-token"]').content;
const $ = (id) => document.getElementById(id);

const KIND_LABELS = { vacation: 'お休み', late: '遅参', early: '早帰り', custom: '時間変更' };
const TF_BADGES = {
  none: ['未申請', 'bg-amber-100 text-amber-800'],
  submitting: ['送信中', 'bg-blue-100 text-blue-800'],
  submitted: ['申請済み', 'bg-emerald-100 text-emerald-800'],
  failed: ['申請失敗', 'bg-rose-100 text-rose-800'],
  unknown: ['送達不明', 'bg-purple-100 text-purple-800'],
};
const CAL_BADGES = {
  none: ['カレンダー未登録', 'bg-slate-100 text-slate-600'],
  registered: ['カレンダー登録済み', 'bg-emerald-100 text-emerald-800'],
  failed: ['カレンダー失敗', 'bg-rose-100 text-rose-800'],
};
const ACTION_BADGES = {
  fill: ['入力', 'bg-blue-100 text-blue-800'],
  match: ['一致', 'bg-emerald-100 text-emerald-800'],
  skip: ['空欄', 'bg-slate-100 text-slate-500'],
  mismatch: ['不一致', 'bg-rose-100 text-rose-800'],
  absent: ['行なし', 'bg-slate-100 text-slate-400'],
};
// Excel取込の分類ラベル(プレビュー表示専用。送信値は Excel の値を素通し)
const EXCEL_KIND_BADGES = {
  '通常': 'bg-slate-100 text-slate-600',
  '休日': 'bg-slate-100 text-slate-400',
  '終日休暇': 'bg-indigo-100 text-indigo-800',
  '午前休暇': 'bg-indigo-100 text-indigo-800',
  '午後休暇': 'bg-indigo-100 text-indigo-800',
  '遅刻': 'bg-amber-100 text-amber-800',
  '早退': 'bg-amber-100 text-amber-800',
  '中抜け': 'bg-amber-100 text-amber-800',
  '⚠空欄平日': 'bg-amber-100 text-amber-800',
  '⚠要確認': 'bg-rose-100 text-rose-800',
};

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-kintai-token': TOKEN },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error ?? `API エラー (${res.status})`);
    err.code = data.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const badge = ([label, cls]) => `<span class="inline-block rounded-full px-2 py-0.5 text-xs font-medium ${cls}">${label}</span>`;
const fmtDate = (rec) => rec.endDate ? `${rec.date} 〜 ${rec.endDate}` : rec.date;
const toast = (msg, isError = false) => {
  const el = document.createElement('div');
  el.className = `fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg px-4 py-2 text-sm text-white shadow-lg ${isError ? 'bg-rose-600' : 'bg-slate-800'}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), isError ? 6000 : 3000);
};

let state = null;
let jobTimer = null;
let lastJobRender = null; // 直近に全描画したジョブの { id, state }。確認待ち中の再描画抑制に使う
const watchedJobs = new Set(); // 完了ジョブを再監視して無限ループしないためのガード

// ジョブ実行中(running / awaiting_confirmation)は新規投入系の操作を無効化する(P2-1、§6)。
// サーバー側の 409 に頼らず、UI でも構造的に押せなくする
let jobBusy = false;
function setBusy(busy) {
  jobBusy = busy;
  $('f1-drop').classList.toggle('pointer-events-none', busy);
  $('f1-drop').classList.toggle('opacity-50', busy);
  $('f2-submit').disabled = busy;
  applyBusyToRecordActions();
}
function applyBusyToRecordActions() {
  document.querySelectorAll('#record-list [data-act]').forEach((el) => (el.disabled = jobBusy));
}

// ---- 状態の取得と全体描画 --------------------------------------------------
async function refresh() {
  state = await api('/api/state');

  const problems = $('config-problems');
  if (state.problems?.length) {
    problems.classList.remove('hidden');
    problems.innerHTML = `<strong>設定の確認が必要です:</strong><ul class="mt-1 list-disc pl-5">${state.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`;
  } else {
    problems.classList.add('hidden');
  }

  renderRecords();
  renderLastRun();
  if (state.job && ['running', 'awaiting_confirmation'].includes(state.job.state)) watchJob(state.job.id);
  else renderJob(state.job);
  renderLogin(state.login);
}

// ---- フロー①: 直近実行 ----
// 対象月は Excel から自動判定されるため、月を問わず最新の実行を表示する
function renderLastRun() {
  const runs = Object.entries(state.levtechRuns ?? {});
  if (runs.length === 0) {
    $('f1-lastrun').textContent = '';
    return;
  }
  const [month, run] = runs.sort((a, b) => (b[1].at ?? '').localeCompare(a[1].at ?? ''))[0];
  $('f1-lastrun').textContent =
    `直近の入力: ${month}(${run.at.slice(0, 16).replace('T', ' ')} / ${run.filledDays} 日 / ${run.totalHours})`;
}

// ---- ジョブパネル ----
function watchJob(jobId, { once = false } = {}) {
  if (once && watchedJobs.has(jobId)) return;
  watchedJobs.add(jobId);
  clearInterval(jobTimer);
  let pollFailures = 0;
  const poll = async () => {
    let job;
    try {
      job = await api(`/api/jobs/${jobId}`);
      pollFailures = 0;
    } catch (err) {
      // 一時的な通信断では止めない(P1-5)。404(ジョブ消失)と連続失敗のみ明示的に停止する
      pollFailures++;
      if (err.status === 404) {
        clearInterval(jobTimer);
        toast('ジョブが見つかりません。サーバーが再起動した可能性があります。ページを再読み込みしてください', true);
      } else if (pollFailures >= 5) {
        clearInterval(jobTimer);
        toast('ジョブの進捗を取得できません。ページを再読み込みしてください', true);
      }
      return;
    }
    renderJob(job);
    if (!['running', 'awaiting_confirmation'].includes(job.state)) {
      clearInterval(jobTimer);
      try {
        const st = await api('/api/state');
        state = st;
        renderRecords();
        renderLastRun();
        renderLogin(st.login);
      } catch (err) {
        toast(`最新状態の取得に失敗しました: ${err.message}`, true);
      }
    }
  };
  jobTimer = setInterval(poll, 1200);
  poll();
}

function renderJob(job) {
  const panel = $('job-panel');
  setBusy(!!job && ['running', 'awaiting_confirmation'].includes(job.state));
  if (!job) {
    panel.classList.add('hidden');
    lastJobRender = null;
    return;
  }
  panel.classList.remove('hidden');
  const log = job.log.slice(-8).map((l) => `<div>${esc(l.msg)}</div>`).join('');
  // 確認待ち中の再描画はログのみ更新する。全再構築すると上書き承認チェック・スクロール位置が
  // ポーリングのたびに失われ、承認したつもりの行が未承認のまま保存される(§F1 手順5)。
  if (job.state === 'awaiting_confirmation' && lastJobRender?.id === job.id && lastJobRender.state === job.state && $('job-log')) {
    $('job-log').innerHTML = log || '...';
    return;
  }
  const stateLabel = {
    running: badge(['実行中', 'bg-blue-100 text-blue-800']),
    awaiting_confirmation: badge(['確認待ち', 'bg-amber-100 text-amber-800']),
    succeeded: badge(['成功', 'bg-emerald-100 text-emerald-800']),
    failed: badge(['失敗', 'bg-rose-100 text-rose-800']),
    cancelled: badge(['中止', 'bg-slate-100 text-slate-600']),
  }[job.state];
  const typeLabel = { 'levtech-fill': '月末勤怠入力', 'levtech-import': '月末勤怠入力(Excel取込)', request: '例外日の申請・登録', 'typeform-retry': 'Typeform 再送信', 'session-check': 'セッションチェック' }[job.type] ?? job.type;

  let extra = '';
  if (job.state === 'awaiting_confirmation' && job.preview?.kind === 'levtech-plan') {
    extra = renderLevtechPreview(job);
  } else if (job.state === 'succeeded' && job.result) {
    extra = renderJobResult(job);
  } else if (job.state === 'failed') {
    const hint =
      job.errorCode === 'session-expired' ? 'ログイン導線からセッションを回復してください。'
      : job.errorCode === 'url-unresolved' ? '「URL 自動解決に失敗した場合」から手動で URL を指定して再実行できます。'
      : job.errorCode === 'profile-locked' ? 'ログイン用の Chrome が開いたままです。完全終了(Cmd+Q)してから再実行してください。'
      : '';
    extra = `<div class="mt-2 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">${esc(job.error)}${hint ? `<div class="mt-1 text-rose-600">${esc(hint)}</div>` : ''}</div>`;
    if (job.screenshots.length) {
      extra += `<p class="mt-1 text-xs text-slate-500">スクリーンショット: ${job.screenshots.map(esc).join(' , ')}</p>`;
    }
  }

  panel.innerHTML = `
    <div class="flex items-center justify-between">
      <h2 class="font-semibold">ジョブ: ${esc(typeLabel)} <span class="text-xs text-slate-400">${esc(job.id)}</span></h2>
      ${stateLabel}
    </div>
    <div id="job-log" class="mt-2 max-h-32 overflow-y-auto rounded bg-slate-50 p-2 font-mono text-xs text-slate-600">${log || '...'}</div>
    ${extra}`;
  bindPreviewHandlers(job);
  lastJobRender = { id: job.id, state: job.state };
}

function renderLevtechPreview(job) {
  const p = job.preview;
  const isExcel = p.source === 'excel';
  const rows = p.rows
    .map((r) => {
      const cls = r.action === 'mismatch' ? 'bg-rose-50 text-rose-700' : r.action === 'fill' ? '' : 'text-slate-400';
      const exp = r.expected.start ? `${r.expected.start}-${r.expected.end}/${r.expected.rest}` : '空欄';
      const cur = r.existing ? (r.existing.start ? `${r.existing.start}-${r.existing.end}/${r.existing.rest}` : '空欄') : '—';
      const check = r.action === 'mismatch'
        ? `<input type="checkbox" class="approve-overwrite rounded border-rose-300" data-date="${r.date}" />`
        : '';
      const warn = r.unsubmitted ? ` ${badge(['未申請', 'bg-amber-100 text-amber-800'])}` : '';
      // Excel取込: 分類ラベル列と、⚠付きの警告(空欄平日・整合チェック等)を表示する
      const kindCell = isExcel
        ? `<td class="py-0.5 pr-2 whitespace-nowrap">${r.excelKind ? badge([esc(r.excelKind), EXCEL_KIND_BADGES[r.excelKind] ?? 'bg-slate-100 text-slate-600']) : ''}</td>`
        : '';
      const warnings = (r.warnings ?? []).map((w) => `<div class="text-amber-700">⚠ ${esc(w)}</div>`).join('');
      return `<tr class="border-b border-slate-100 last:border-0 ${cls}">
        <td class="py-0.5 pr-2 whitespace-nowrap">${r.label}(${r.dowLabel})</td>
        ${kindCell}
        <td class="py-0.5 pr-2">${badge(ACTION_BADGES[r.action])}</td>
        <td class="py-0.5 pr-2 whitespace-nowrap">${cur}</td>
        <td class="py-0.5 pr-2 whitespace-nowrap">${exp}</td>
        <td class="py-0.5 pr-2">${esc(r.note)}${warn}${warnings}</td>
        <td class="py-0.5 text-center">${check}</td>
      </tr>`;
    })
    .join('');
  const warningCount = p.rows.reduce((n, r) => n + (r.warnings?.length ?? 0), 0);
  return `
    <div class="mt-3 rounded-lg border border-slate-200 p-3">
      <p class="text-sm font-medium">保存前プレビュー(${esc(p.month)}${isExcel ? '・Excel取込' : ''}): 入力 ${p.counts.fill} 日 / 一致 ${p.counts.match} 日 / <span class="${p.counts.mismatch ? 'text-rose-600 font-semibold' : ''}">不一致 ${p.counts.mismatch} 日</span>${isExcel && warningCount ? ` / <span class="text-amber-700 font-semibold">⚠警告 ${warningCount} 件</span>` : ''}</p>
      ${p.counts.mismatch ? '<p class="mt-1 text-xs text-rose-600">不一致の行は現状維持が既定です。期待値で上書きする行のみ右端をチェックしてください。</p>' : ''}
      ${isExcel && warningCount ? '<p class="mt-1 text-xs text-amber-700">⚠の行(空欄平日・要確認など)は Excel の内容をよく確認してから承認してください。空欄の行はスキップされます。</p>' : ''}
      <div class="mt-2 max-h-72 overflow-y-auto">
        <table class="w-full text-left text-xs">
          <thead class="sticky top-0 bg-white text-slate-400"><tr>
            <th class="py-1 pr-2 font-normal">日付</th>${isExcel ? '<th class="py-1 pr-2 font-normal">分類</th>' : ''}<th class="py-1 pr-2 font-normal">判定</th>
            <th class="py-1 pr-2 font-normal">現在値</th><th class="py-1 pr-2 font-normal">期待値</th>
            <th class="py-1 pr-2 font-normal">備考</th><th class="py-1 font-normal">上書き承認</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="mt-3 flex justify-end gap-2">
        <button id="job-abort" class="rounded-lg border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50">中止(何も保存しない)</button>
        <button id="job-approve" class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">承認して入力・保存</button>
      </div>
    </div>`;
}

function bindPreviewHandlers(job) {
  const approve = $('job-approve');
  const abort = $('job-abort');
  if (approve) {
    approve.onclick = async () => {
      const approvedDates = [...document.querySelectorAll('.approve-overwrite:checked')].map((el) => el.dataset.date);
      approve.disabled = true;
      try {
        await api(`/api/jobs/${job.id}/confirm`, { method: 'POST', body: { approve: true, data: { approvedDates } } });
      } catch (err) {
        toast(err.message, true);
        approve.disabled = false; // 確認待ち中は再描画しないため、失敗時はここで復帰させる
      }
    };
  }
  if (abort) {
    abort.onclick = async () => {
      try {
        await api(`/api/jobs/${job.id}/confirm`, { method: 'POST', body: { approve: false } });
      } catch (err) {
        toast(err.message, true);
      }
    };
  }
}

function renderJobResult(job) {
  const r = job.result;
  if (job.type === 'levtech-fill' || job.type === 'levtech-import') {
    return r.saved
      ? `<div class="mt-2 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">保存成功: ${r.summary.days} 日 / 合計 ${r.summary.hours}(新規入力 ${r.applied} 行)。「更新しました。」を確認済み。</div>`
      : `<div class="mt-2 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">${esc(r.message)}</div>`;
  }
  if (job.type === 'request' || job.type === 'typeform-retry') {
    const tf = r.typeform ? badge(TF_BADGES[r.typeform] ?? [r.typeform, 'bg-slate-100']) : '';
    const cal = r.calendar ? badge(CAL_BADGES[r.calendar] ?? [r.calendar, 'bg-slate-100']) : '';
    return `<div class="mt-2 flex items-center gap-2 rounded-lg bg-slate-50 p-3 text-sm">結果: ${cal} ${tf}</div>`;
  }
  if (job.type === 'session-check') {
    return r.session === 'ok'
      ? '<div class="mt-2 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">セッション回復を確認しました。</div>'
      : '<div class="mt-2 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">まだログインできていません。もう一度ログインをやり直してください。</div>';
  }
  return '';
}

// ---- ログイン導線 ----
function renderLogin(login) {
  const card = $('login-card');
  const lastFailedSession = state.job?.state === 'failed' && state.job?.errorCode === 'session-expired';
  const active = login.phase !== 'idle' || !!login.message;
  if (lastFailedSession || active) {
    card.classList.remove('hidden');
    $('login-message').textContent = login.message ?? '';
    $('login-start').disabled = login.phase === 'chrome-running';
  } else {
    card.classList.add('hidden');
  }
  // 実行中ジョブの監視をセッションチェックの監視で乗っ取らない(P1-6)。
  // グローバルのポーリングタイマーは1本のため、別ジョブが動いている間は checkJobId を見ない
  if (login.checkJobId) {
    const busyWithOther =
      state?.job && state.job.id !== login.checkJobId && ['running', 'awaiting_confirmation'].includes(state.job.state);
    if (!busyWithOther) watchJob(login.checkJobId, { once: true });
  }
}

// ---- 例外日一覧 ----
// 取消済みでもカレンダーの手動削除が未完了なら残作業として表示する(P1-4)
const needsCalendarCleanup = (r) =>
  r.cancelled && r.cancellation && r.statuses.calendar === 'registered' && !r.cancellation.calendarCleanupDone;

function renderRecords() {
  const showCancelled = $('list-show-cancelled').checked;
  const records = [...state.exceptions]
    .filter((r) => showCancelled || !r.cancelled || needsCalendarCleanup(r))
    .sort((a, b) => b.date.localeCompare(a.date));
  const box = $('record-list');
  if (records.length === 0) {
    box.innerHTML = '<p class="text-sm text-slate-400">例外日はまだありません。</p>';
    return;
  }
  box.innerHTML = records.map(renderRecord).join('');
  box.querySelectorAll('[data-act]').forEach((btn) => (btn.onclick = () => handleRecordAction(btn)));
  applyBusyToRecordActions();
}

function renderRecord(rec) {
  const badges = [];
  if (rec.kind === 'custom') badges.push(badge(['申請不要', 'bg-slate-100 text-slate-600']));
  else {
    badges.push(badge(TF_BADGES[rec.statuses.typeform]));
    badges.push(badge(CAL_BADGES[rec.statuses.calendar]));
  }
  if (rec.cancellation) {
    const c = rec.cancellation.typeform;
    if (rec.cancelled) badges.push(badge(['取消済み', 'bg-slate-200 text-slate-600']));
    else if (c !== 'none') badges.push(badge([`取消申請: ${TF_BADGES[c]?.[0] ?? c}`, 'bg-purple-100 text-purple-800']));
  }

  const time = rec.time ? ` ${rec.time}` : rec.kind === 'custom' ? ` ${rec.start}-${rec.end}/${rec.rest}` : '';
  const actions = [];
  // 直接取消は「申請が成立していない(none / failed)」レコードなら可(P1-3。カレンダー登録済みでも可逆なので可)
  const canDirectCancel = !rec.cancelled && !rec.cancellation && ['none', 'failed'].includes(rec.statuses.typeform);
  if (canDirectCancel) actions.push(['cancel-direct', '取消', 'border-slate-300']);
  if (!rec.cancelled) {
    // 取り消し申請の再送は本申請の再送と別物なので、ボタン文言でも区別する(P2-7)
    const isCancelTarget = !!rec.cancellation && rec.cancellation.typeform !== 'none';
    const tfTarget = isCancelTarget ? rec.cancellation.typeform : rec.statuses.typeform;
    if (tfTarget === 'failed') actions.push(['retry-typeform', isCancelTarget ? '取り消し申請を再送信' : '申請を再送信', 'border-rose-300 text-rose-700']);
    // none のまま残った要申請レコード(クリック前失敗など)は未送信確定なので通常導線で送信できる(P1-2)
    else if (tfTarget === 'none' && rec.kind !== 'custom') actions.push(['retry-typeform', '申請を送信', 'border-amber-300 text-amber-800']);
    if (rec.statuses.calendar === 'failed') actions.push(['retry-calendar', 'カレンダー再実行', 'border-rose-300 text-rose-700']);
    if (rec.statuses.typeform === 'submitted' && (!rec.cancellation || rec.cancellation.typeform === 'none')) {
      actions.push(['cancel-request', '取り消し申請', 'border-slate-300']);
    }
  }

  const actionsHtml = actions
    .map(([act, label, cls]) => `<button data-act="${act}" data-id="${rec.id}" class="rounded-lg border ${cls} px-2.5 py-1 text-xs hover:bg-slate-50 disabled:opacity-50">${label}</button>`)
    .join('');

  // unknown 解決導線(§3-3: 到達確認チェック付きの別導線)
  let unknownUi = '';
  const unknownTarget = !rec.cancelled && (
    rec.cancellation?.typeform === 'unknown' ? '取消申請' : rec.statuses.typeform === 'unknown' ? '申請' : null
  );
  if (unknownTarget) {
    unknownUi = `
      <div class="mt-2 rounded-lg border border-purple-200 bg-purple-50 p-2.5 text-xs text-purple-800">
        <p>${unknownTarget}の送達が確認できていません。メール通知等で実際の到達状況を確認してから操作してください。</p>
        <label class="mt-1.5 flex items-center gap-1.5">
          <input type="checkbox" class="unknown-verified rounded border-purple-300" data-id="${rec.id}" />
          メール通知等で到達状況を目視確認しました
        </label>
        <div class="mt-1.5 flex gap-2">
          <button data-act="unknown-confirm" data-id="${rec.id}" class="rounded border border-purple-300 px-2 py-1 hover:bg-purple-100 disabled:opacity-50">届いていた → 申請済みにする</button>
          <button data-act="unknown-resubmit" data-id="${rec.id}" class="rounded border border-rose-300 bg-rose-50 px-2 py-1 text-rose-700 hover:bg-rose-100 disabled:opacity-50">届いていない → 再送信</button>
        </div>
      </div>`;
  }

  // 取消済みでカレンダー登録が残っている場合のチェックリスト
  let cleanupUi = '';
  if (needsCalendarCleanup(rec)) {
    cleanupUi = `
      <div class="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-800">
        <label class="flex items-center gap-1.5">
          <input type="checkbox" data-act="cleanup-done" data-id="${rec.id}" class="rounded border-amber-300" />
          カレンダー「勤怠ハブ」からこの日の予定を手動削除しました(差分同期はスコープ外のため手動です)
        </label>
      </div>`;
  }

  return `
    <div class="rounded-lg border border-slate-200 p-3 ${rec.cancelled ? 'opacity-60' : ''}">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="text-sm ${rec.cancelled ? 'line-through' : ''}">
          <span class="font-medium">${fmtDate(rec)}</span>
          <span class="ml-2">${KIND_LABELS[rec.kind]}${esc(time)}</span>
          ${rec.reason ? `<span class="ml-2 text-slate-500">${esc(rec.reason)}${rec.reasonDetail ? `(${esc(rec.reasonDetail)})` : ''}</span>` : ''}
        </div>
        <div class="flex flex-wrap items-center gap-1.5">${badges.join('')}</div>
      </div>
      ${actionsHtml ? `<div class="mt-2 flex flex-wrap gap-1.5">${actionsHtml}</div>` : ''}
      ${unknownUi}${cleanupUi}
    </div>`;
}

async function handleRecordAction(btn) {
  const id = btn.dataset.id;
  const act = btn.dataset.act;
  const rec = state.exceptions.find((r) => r.id === id);
  try {
    if (act === 'cancel-direct') {
      const tfNote = rec.statuses.typeform === 'failed'
        ? '<p class="mt-1 text-xs text-slate-500">申請は送信されていない(失敗)ため、取り消し申請は不要です。</p>'
        : '<p class="mt-1 text-xs text-slate-500">申請前のレコードのため、取り消し申請は不要です。</p>';
      const calNote = rec.statuses.calendar === 'registered'
        ? '<p class="mt-2 text-xs text-amber-700">カレンダーには登録済みです。取消後に予定の手動削除が必要です(チェックリストが出ます)。</p>'
        : '';
      openConfirm('レコードの取消', `<p>${fmtDate(rec)} の「${KIND_LABELS[rec.kind]}」を取り消します。</p>${tfNote}${calNote}`, async () => {
        await api(`/api/exceptions/${id}/cancel-direct`, { method: 'POST' });
        await refresh();
      });
    } else if (act === 'retry-typeform') {
      // 取り消し申請の再送はダイアログでも本申請と区別する(P2-7)
      const isCancellation = !!rec.cancellation && rec.cancellation.typeform !== 'none';
      const label = isCancellation ? '取り消し申請' : '申請';
      const isResend = (isCancellation ? rec.cancellation.typeform : rec.statuses.typeform) === 'failed';
      const verb = isResend ? '再送信' : '送信';
      openConfirm(`${label}の${verb}`, `<p>${fmtDate(rec)} の${label}を Typeform へ${verb}します。送信後は取り下げできません。</p>`, async () => {
        const { job } = await api(`/api/exceptions/${id}/retry-typeform`, { method: 'POST' });
        watchJob(job.id);
      });
    } else if (act === 'retry-calendar') {
      await api(`/api/exceptions/${id}/retry-calendar`, { method: 'POST' });
      toast('カレンダー登録を再実行しました');
      await refresh();
    } else if (act === 'cancel-request') {
      const detail = prompt('取り消しの背景(Typeform に送信されます)', `${fmtDate(rec)} の${KIND_LABELS[rec.kind]}のご連絡を取り消します`);
      if (detail == null) return;
      openConfirm('取り消し申請の送信', `
        <p>Typeform で「前回ご連絡の取り消し」を送信します。送信後は取り下げできません。</p>
        <dl class="mt-2 grid grid-cols-3 gap-1 text-sm"><dt class="text-slate-500">対象</dt><dd class="col-span-2">${fmtDate(rec)} ${KIND_LABELS[rec.kind]}</dd>
        <dt class="text-slate-500">背景</dt><dd class="col-span-2">${esc(detail)}</dd></dl>
        <p class="mt-2 text-xs text-amber-700">送信後、カレンダーの予定は手動削除が必要です(完了後にチェックリストが出ます)。</p>`, async () => {
        const { job } = await api(`/api/exceptions/${id}/cancel-request`, { method: 'POST', body: { detail } });
        watchJob(job.id);
      });
    } else if (act === 'unknown-confirm' || act === 'unknown-resubmit') {
      const verified = btn.closest('div.rounded-lg').querySelector('.unknown-verified').checked;
      if (!verified) {
        toast('到達状況を目視確認した旨のチェックが必要です', true);
        return;
      }
      const resolveUnknown = async (action) => {
        const res = await api(`/api/exceptions/${id}/resolve-unknown`, { method: 'POST', body: { action, verified: true } });
        if (res.job) watchJob(res.job.id);
        else {
          toast('申請済みとして確定しました');
          await refresh();
        }
      };
      if (act === 'unknown-confirm') {
        await resolveUnknown('confirm-submitted');
      } else {
        const target = rec.cancellation?.typeform === 'unknown' ? '取消申請' : '申請';
        const time = rec.time ? ` ${rec.time}` : '';
        openConfirm(`送達不明の${target}を再送信`, `
          <p class="text-xs text-rose-700">初回の送信が実際には届いていた場合、この操作で<strong>同じ${target}が二重に送信</strong>されます。送信後は取り下げできません。</p>
          <dl class="mt-2 grid grid-cols-3 gap-1 text-sm">
            <dt class="text-slate-500">対象</dt><dd class="col-span-2">${fmtDate(rec)} ${KIND_LABELS[rec.kind]}${esc(time)}</dd>
            ${rec.reason ? `<dt class="text-slate-500">理由</dt><dd class="col-span-2">${esc(rec.reason)}${rec.reasonDetail ? `(${esc(rec.reasonDetail)})` : ''}</dd>` : ''}
          </dl>`, () => resolveUnknown('resubmit'));
      }
    } else if (act === 'cleanup-done') {
      // 誤クリックの即確定を防ぐ(P2-8): チェックを一旦戻し、確認された場合のみ確定する
      btn.checked = false;
      openConfirm('カレンダー手動削除の確定', `
        <p>${fmtDate(rec)} の予定をカレンダー「勤怠ハブ」から<strong>削除済み</strong>として確定します。</p>
        <p class="mt-2 text-xs text-slate-500">確定するとこの残作業チェックリストは一覧から消えます。まだ削除していない場合は「やめる」を押してください。</p>`, async () => {
        await api(`/api/exceptions/${id}/cleanup-done`, { method: 'POST', body: { done: true } });
        await refresh();
      });
    }
  } catch (err) {
    toast(err.message, true);
  }
}

// ---- 確認ダイアログ ----
let confirmAction = null;
function openConfirm(title, bodyHtml, onYes) {
  $('confirm-title').textContent = title;
  $('confirm-body').innerHTML = bodyHtml;
  confirmAction = onYes;
  $('confirm-dialog').showModal();
}
$('confirm-no').onclick = () => $('confirm-dialog').close();
$('confirm-yes').onclick = async () => {
  const fn = confirmAction;
  $('confirm-dialog').close();
  if (fn) {
    try {
      await fn();
    } catch (err) {
      toast(err.message, true);
    }
  }
};

// ---- フロー① 操作: Excel ドラッグ&ドロップ → 取込ジョブ開始 ----
// アップロード=ジョブ開始。年月はファイル(D2/F2)から自動判定され、承認するまで何も書き込まない
async function startImport(file) {
  if (!file) return;
  if (jobBusy) return toast('別のジョブが実行中です。完了後にやり直してください', true);
  if (!/\.xls$/i.test(file.name)) return toast('.xls ファイル(作業実績表)を指定してください', true);
  const manualUrl = $('f1-manual-url').value.trim();
  const q = manualUrl ? `?manualUrl=${encodeURIComponent(manualUrl)}` : '';
  try {
    const res = await fetch(`/api/levtech/import${q}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'x-kintai-token': TOKEN },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `API エラー (${res.status})`);
    toast(`${data.month} の作業実績表を読み取りました。スキャンを開始します`);
    watchJob(data.job.id);
  } catch (err) {
    toast(err.message, true);
  }
}

$('f1-drop').onclick = () => $('f1-file').click();
$('f1-file').onchange = () => {
  startImport($('f1-file').files[0]);
  $('f1-file').value = ''; // 同じファイルの再選択でも change が発火するように
};
$('f1-drop').ondragover = (e) => {
  e.preventDefault();
  $('f1-drop').classList.add('border-indigo-400', 'bg-indigo-50/40');
};
$('f1-drop').ondragleave = () => $('f1-drop').classList.remove('border-indigo-400', 'bg-indigo-50/40');
$('f1-drop').ondrop = (e) => {
  e.preventDefault();
  $('f1-drop').classList.remove('border-indigo-400', 'bg-indigo-50/40');
  startImport(e.dataTransfer.files?.[0]);
};

// ---- フロー② 操作 ----
function syncF2Visibility() {
  const kind = $('f2-kind').value;
  $('f2-range-row').style.display = kind === 'vacation' ? '' : 'none';
  $('f2-time-row').style.display = kind === 'vacation' ? 'none' : '';
  $('f2-time-label').textContent = kind === 'late' ? '出社時刻(目途)' : '退社時刻(目途)';
}
$('f2-kind').onchange = syncF2Visibility;
$('f2-range').onchange = () => ($('f2-enddate').disabled = !$('f2-range').checked);
syncF2Visibility();

$('f2-submit').onclick = () => {
  const kind = $('f2-kind').value;
  const body = {
    kind,
    date: $('f2-date').value,
    endDate: kind === 'vacation' && $('f2-range').checked ? $('f2-enddate').value : null,
    time: kind === 'vacation' ? null : $('f2-time').value,
    reason: $('f2-reason').value,
    reasonDetail: $('f2-detail').value.trim() || null,
    contacted: $('f2-contacted').value === 'true',
  };
  if (!body.date) return toast('対象日を入力してください', true);
  // 連続休暇チェック ON なのに終了日が空欄のまま送ると単日休暇として申請されてしまう(P2-5)
  if (kind === 'vacation' && $('f2-range').checked && !body.endDate) {
    return toast('連続休暇の終了日を入力してください', true);
  }
  if (kind !== 'vacation' && !body.time) return toast('時刻を入力してください', true);

  const dateText = body.endDate ? `${body.date} 〜 ${body.endDate}` : body.date;
  openConfirm('申請内容の確認', `
    <p class="text-amber-700 text-xs">Typeform への申請は送信後に取り下げできません。内容をよく確認してください。</p>
    <dl class="mt-2 grid grid-cols-3 gap-1">
      <dt class="text-slate-500">種別</dt><dd class="col-span-2">${KIND_LABELS[kind]}</dd>
      <dt class="text-slate-500">日にち</dt><dd class="col-span-2">${dateText}</dd>
      ${body.time ? `<dt class="text-slate-500">${kind === 'late' ? '開始時刻' : '終了時刻'}</dt><dd class="col-span-2">${body.time}</dd>` : ''}
      <dt class="text-slate-500">理由</dt><dd class="col-span-2">${esc(body.reason)}${body.reasonDetail ? `(${esc(body.reasonDetail)})` : ''}</dd>
      <dt class="text-slate-500">連絡済み</dt><dd class="col-span-2">${body.contacted ? 'はい' : 'いいえ'}</dd>
    </dl>
    <p class="mt-2 text-xs text-slate-500">実行順: ① カレンダー登録(冪等)→ ② Typeform 送信。</p>`, async () => {
    const { job } = await api('/api/requests', { method: 'POST', body });
    $('f2-date').value = '';
    $('f2-detail').value = '';
    watchJob(job.id);
    await refresh();
  });
};

// ---- ログイン操作 ----
$('login-start').onclick = async () => {
  try {
    await api('/api/login/start', { method: 'POST' });
    const timer = setInterval(async () => {
      const login = await api('/api/login/status');
      renderLogin(login);
      if (login.phase === 'idle') clearInterval(timer);
    }, 2000);
    renderLogin(await api('/api/login/status'));
  } catch (err) {
    toast(err.message, true);
  }
};

$('list-show-cancelled').onchange = renderRecords;

refresh().catch((err) => toast(err.message, true));
