// 勤怠ハブ UI。素の JS(ビルドなし)。サーバーの API をポーリングして描画する。
const TOKEN = document.querySelector('meta[name="kintai-token"]').content;
const $ = (id) => document.getElementById(id);

const KIND_LABELS = { vacation: 'お休み', late: '遅参', early: '早帰り' };
const REASONS = ['私用', 'ご体調不良', 'その他'];
const TF_BADGES = {
  none: ['未申請', 'bg-amber-100 text-amber-800'],
  submitting: ['送信中', 'bg-blue-100 text-blue-800'],
  submitted: ['申請済み', 'bg-emerald-100 text-emerald-800'],
  failed: ['申請失敗', 'bg-rose-100 text-rose-800'],
  unknown: ['送達不明', 'bg-purple-100 text-purple-800'],
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
  $('f1-file').disabled = busy; // キーボード経由(label + sr-only input)の起動も塞ぐ
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
  const typeLabel = { 'levtech-import': '月末一括(勤怠入力+Typeform申請)', 'typeform-retry': 'Typeform 再送信', 'session-check': 'セッションチェック' }[job.type] ?? job.type;

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
      // 現在値はレバテック画面からスクレイプした文字列(外部由来)のため必ず esc する
      const exp = r.expected.start ? esc(`${r.expected.start}-${r.expected.end}/${r.expected.rest}`) : '空欄';
      const cur = r.existing ? (r.existing.start ? esc(`${r.existing.start}-${r.existing.end}/${r.existing.rest}`) : '空欄') : '—';
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
      ${renderApplicationsPreview(p)}
      ${(p.applications?.planned?.length ?? 0) > 0 ? '<p class="mt-3 text-sm font-medium text-rose-700">チェック済みの申請は承認と同時に Typeform へ送信されます。送信後は取り下げできません(取り消しは Typeform から手動連絡)。</p>' : ''}
      <div class="mt-3 flex justify-end gap-2">
        <button id="job-abort" class="rounded-lg border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50">中止(何も保存・送信しない)</button>
        <button id="job-approve" class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">${approveLabel(p)}</button>
      </div>
    </div>`;
}

// 承認ボタンの文言。sendCount(送信チェック済みの件数)を渡すと件数を確定表示する
function approveLabel(p, sendCount) {
  const total = p.applications?.planned?.length ?? 0;
  if (total === 0) return '承認して入力・保存';
  const n = sendCount ?? total;
  const sendPart = n > 0 ? `申請 ${n} 件を送信` : '申請は送信しない(0 件)';
  return p.levtechNeeded === false ? sendPart : `承認して入力・保存し、${sendPart}`;
}

// Typeform 申請一覧(送信予定・送信済みスキップ・⚠食い違い・対象外)のプレビュー。
// 理由は 1 件ずつ修正でき、送信チェックを外した申請は送られない
function renderApplicationsPreview(p) {
  const a = p.applications;
  if (!a) return '';
  const reasonOptions = (sel) => REASONS.map((r) => `<option${r === sel ? ' selected' : ''}>${esc(r)}</option>`).join('');
  const appLine = (app) => `${esc(app.dateText)} ${esc(app.type)}${app.time ? ` ${esc(app.time)}` : ''}`;
  const entryLine = (e) => `${esc(e.date)}${e.endDate ? `〜${esc(e.endDate)}` : ''} ${esc(e.type)}${e.time ? ` ${esc(e.time)}` : ''}`;

  let html = `<div class="mt-4 border-t border-slate-200 pt-3">
    <p class="text-sm font-medium">Typeform 申請: 送信予定 ${a.planned.length} 件 / 送信済みスキップ ${a.skipped.length} 件${a.mismatched.length + a.orphans.length ? ` / <span class="text-rose-600 font-semibold">⚠食い違い ${a.mismatched.length + a.orphans.length} 件</span>` : ''} / 対象外 ${a.excluded.length} 件</p>`;

  if (a.planned.length > 0) {
    const rows = a.planned.map((app) => `
      <tr class="border-b border-slate-100 last:border-0">
        <td class="py-1 pr-2 whitespace-nowrap">${esc(app.dateText)}</td>
        <td class="py-1 pr-2 whitespace-nowrap">${esc(app.type)}</td>
        <td class="py-1 pr-2 whitespace-nowrap">${app.time ? esc(app.time) : '—'}</td>
        <td class="py-1 pr-2"><select class="app-reason rounded border border-slate-300 px-1 py-0.5" data-index="${app.index}">${reasonOptions(app.reason)}</select></td>
        <td class="py-1 pr-2 text-slate-500">${esc(app.note)}</td>
        <td class="py-1 text-center"><input type="checkbox" class="app-send rounded border-slate-300" data-index="${app.index}" checked /></td>
      </tr>`).join('');
    html += `
      <p class="mt-1 text-xs text-slate-500">詳細欄は空欄で送信されます(備考は表示のみ)。連絡済みは「はい」で送信されます。</p>
      <div class="mt-2 max-h-56 overflow-y-auto">
        <table class="w-full text-left text-xs">
          <thead class="sticky top-0 bg-white text-slate-400"><tr>
            <th class="py-1 pr-2 font-normal">日にち</th><th class="py-1 pr-2 font-normal">種別</th>
            <th class="py-1 pr-2 font-normal">時刻</th><th class="py-1 pr-2 font-normal">理由(修正可)</th>
            <th class="py-1 pr-2 font-normal">備考(送信されません)</th><th class="py-1 font-normal">送信</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  if (a.skipped.length > 0) {
    html += `<div class="mt-2 rounded-lg bg-slate-50 p-2 text-xs text-slate-500">
      <p class="font-medium">送信済みスキップ(台帳と完全一致)</p>
      ${a.skipped.map((s) => `<div>${appLine(s.app)}${s.entry.status === 'unknown' ? ' <span class="text-purple-700">⚠送達不明のまま(台帳の導線で到達確認してください)</span>' : ''}</div>`).join('')}
    </div>`;
  }
  if (a.mismatched.length > 0) {
    html += `<div class="mt-2 rounded-lg border border-rose-200 bg-rose-50 p-2 text-xs text-rose-700">
      <p class="font-medium">⚠食い違い — 自動送信しません。取り消しの連絡は Typeform から手動で送り、送信済み台帳の「取消(連絡済み)」で台帳を整理してから再実行してください</p>
      ${a.mismatched.map((m) => `<div>Excel: ${appLine(m.app)} ≠ 送信済み: ${m.entries.map(entryLine).join(' / ')}</div>`).join('')}
    </div>`;
  }
  if (a.orphans.length > 0) {
    html += `<div class="mt-2 rounded-lg border border-rose-200 bg-rose-50 p-2 text-xs text-rose-700">
      <p class="font-medium">⚠食い違い — 送信済みだが Excel に見当たらない日(Excel 側で消えたか内容が変わっています)。取り消す場合は Typeform から手動で連絡し、送信済み台帳の「取消(連絡済み)」で整理してください</p>
      ${a.orphans.map((e) => `<div>${entryLine(e)}</div>`).join('')}
    </div>`;
  }
  if (a.excluded.length > 0) {
    html += `<div class="mt-2 rounded-lg bg-slate-50 p-2 text-xs text-slate-500">
      <p class="font-medium">申請対象外</p>
      ${a.excluded.map((x) => `<div>${esc(x.date)}: ${esc(x.why)}${x.note ? `(備考: ${esc(x.note)})` : ''}</div>`).join('')}
    </div>`;
  }
  return html + '</div>';
}

function bindPreviewHandlers(job) {
  const approve = $('job-approve');
  const abort = $('job-abort');
  if (approve) {
    approve.onclick = async () => {
      const approvedDates = [...document.querySelectorAll('.approve-overwrite:checked')].map((el) => el.dataset.date);
      // 申請ごとの決定(理由の修正・送信除外)。省略された申請は原案どおり送信される
      const applications = [...document.querySelectorAll('.app-send')].map((el) => ({
        index: Number(el.dataset.index),
        exclude: !el.checked,
        reason: document.querySelector(`.app-reason[data-index="${el.dataset.index}"]`)?.value ?? null,
      }));
      approve.disabled = true;
      try {
        await api(`/api/jobs/${job.id}/confirm`, { method: 'POST', body: { approve: true, data: { approvedDates, applications } } });
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
  // 送信チェックの増減を承認ボタンの件数表示へ即時反映する(押す直前に「何件送るか」を確定表示)
  if (approve && job.preview?.kind === 'levtech-plan') {
    const updateLabel = () =>
      (approve.textContent = approveLabel(job.preview, document.querySelectorAll('.app-send:checked').length));
    document.querySelectorAll('.app-send').forEach((el) => (el.onchange = updateLabel));
  }
}

function renderJobResult(job) {
  const r = job.result;
  if (job.type === 'levtech-import') {
    const levtech = r.saved
      ? `保存成功: ${r.summary.days} 日 / 合計 ${r.summary.hours}(新規入力 ${r.applied} 行)。「更新しました。」を確認済み。`
      : esc(r.message);
    const tf = r.typeform
      ? r.typeform.planned > 0
        ? ` Typeform 申請: ${r.typeform.sent}/${r.typeform.planned} 件を送信しました。`
        : ' 送信すべき Typeform 申請はありませんでした。'
      : '';
    return `<div class="mt-2 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">${levtech}${tf}</div>`;
  }
  if (job.type === 'typeform-retry') {
    const tf = r.typeform ? badge(TF_BADGES[r.typeform] ?? [r.typeform, 'bg-slate-100']) : '';
    return `<div class="mt-2 flex items-center gap-2 rounded-lg bg-slate-50 p-3 text-sm">結果: ${tf}</div>`;
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

// ---- 送信済み台帳 ----
function renderRecords() {
  const showCancelled = $('list-show-cancelled').checked;
  const records = [...state.exceptions]
    .filter((r) => showCancelled || !r.cancelled)
    .sort((a, b) => b.date.localeCompare(a.date));
  const box = $('record-list');
  if (records.length === 0) {
    box.innerHTML = '<p class="text-sm text-slate-400">送信済みの申請はまだありません。月末一括の実行時にここへ記録されます。</p>';
    return;
  }
  box.innerHTML = records.map(renderRecord).join('');
  box.querySelectorAll('[data-act]').forEach((btn) => (btn.onclick = () => handleRecordAction(btn)));
  applyBusyToRecordActions();
}

function renderRecord(rec) {
  const badges = [badge(TF_BADGES[rec.statuses.typeform] ?? [rec.statuses.typeform, 'bg-slate-100'])];
  if (rec.cancelled) badges.push(badge(['取消済み', 'bg-slate-200 text-slate-600']));

  const time = rec.time ? ` ${rec.time}` : '';
  const actions = [];
  // 直接取消は「申請が成立していない(none / failed)」レコードなら可(P1-3)。
  // 送信済みの取り消しは Typeform を手動で開いて連絡する(台帳整理もそのときに)
  if (!rec.cancelled && ['none', 'failed'].includes(rec.statuses.typeform)) {
    actions.push(['cancel-direct', '取消', 'border-slate-300']);
    if (rec.statuses.typeform === 'failed') actions.push(['retry-typeform', '申請を再送信', 'border-rose-300 text-rose-700']);
    // none のまま残ったレコード(クリック前失敗など)は未送信確定なので通常導線で送信できる(P1-2)
    else actions.push(['retry-typeform', '申請を送信', 'border-amber-300 text-amber-800']);
  } else if (!rec.cancelled && rec.statuses.typeform === 'submitted') {
    // 送信済みの台帳整理: Typeform への取り消し連絡(手動)を済ませた後に台帳側を取消済みへ揃える
    actions.push(['cancel-submitted', '取消(連絡済み)', 'border-slate-300']);
  }

  const actionsHtml = actions
    .map(([act, label, cls]) => `<button data-act="${act}" data-id="${rec.id}" class="rounded-lg border ${cls} px-2.5 py-1 text-xs hover:bg-slate-50 disabled:opacity-50">${label}</button>`)
    .join('');

  // unknown 解決導線(§3-3: 到達確認チェック付きの別導線)
  let unknownUi = '';
  if (!rec.cancelled && rec.statuses.typeform === 'unknown') {
    unknownUi = `
      <div class="mt-2 rounded-lg border border-purple-200 bg-purple-50 p-2.5 text-xs text-purple-800">
        <p>申請の送達が確認できていません。メール通知等で実際の到達状況を確認してから操作してください。</p>
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

  return `
    <div class="rounded-lg border border-slate-200 p-3 ${rec.cancelled ? 'opacity-60' : ''}">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="text-sm ${rec.cancelled ? 'line-through' : ''}">
          <span class="font-medium">${fmtDate(rec)}</span>
          <span class="ml-2">${KIND_LABELS[rec.kind] ?? rec.kind}${esc(time)}</span>
          ${rec.reason ? `<span class="ml-2 text-slate-500">${esc(rec.reason)}${rec.reasonDetail ? `(${esc(rec.reasonDetail)})` : ''}</span>` : ''}
        </div>
        <div class="flex flex-wrap items-center gap-1.5">${badges.join('')}</div>
      </div>
      ${actionsHtml ? `<div class="mt-2 flex flex-wrap gap-1.5">${actionsHtml}</div>` : ''}
      ${unknownUi}
    </div>`;
}

async function handleRecordAction(btn) {
  const id = btn.dataset.id;
  const act = btn.dataset.act;
  const rec = state.exceptions.find((r) => r.id === id);
  try {
    if (act === 'cancel-direct') {
      const tfNote = rec.statuses.typeform === 'failed'
        ? '<p class="mt-1 text-xs text-slate-500">申請は送信されていない(失敗)ため、取り消しの連絡は不要です。</p>'
        : '<p class="mt-1 text-xs text-slate-500">申請前のレコードのため、取り消しの連絡は不要です。</p>';
      openConfirm('台帳レコードの取消', `<p>${fmtDate(rec)} の「${KIND_LABELS[rec.kind] ?? rec.kind}」を台帳から取り消します(論理削除)。</p>${tfNote}`, async () => {
        await api(`/api/exceptions/${id}/cancel-direct`, { method: 'POST' });
        await refresh();
      });
    } else if (act === 'cancel-submitted') {
      openConfirm('送信済み申請の台帳取消', `
        <p>${fmtDate(rec)} の「${KIND_LABELS[rec.kind] ?? rec.kind}」を台帳から取り消します(論理削除)。</p>
        <p class="mt-1 text-xs text-rose-700">この申請は Typeform へ送信済みです。取り消しの連絡は自動化できないため、先に Typeform から手動で送ってください。台帳から取り消すと、この日付は再び自動送信の対象に戻ります。</p>
        <label class="mt-2 flex items-center gap-1.5 text-sm">
          <input type="checkbox" id="cancel-submitted-verified" class="rounded border-slate-300" />
          Typeform から取り消しの連絡を手動で送りました
        </label>`, async () => {
        if (!$('cancel-submitted-verified')?.checked) {
          toast('取り消しの連絡を手動で送った旨のチェックが必要です', true);
          return;
        }
        await api(`/api/exceptions/${id}/cancel-submitted`, { method: 'POST', body: { verified: true } });
        toast('台帳から取り消しました');
        await refresh();
      });
    } else if (act === 'retry-typeform') {
      const verb = rec.statuses.typeform === 'failed' ? '再送信' : '送信';
      openConfirm(`申請の${verb}`, `<p>${fmtDate(rec)} の申請を Typeform へ${verb}します。送信後は取り下げできません。</p>`, async () => {
        const { job } = await api(`/api/exceptions/${id}/retry-typeform`, { method: 'POST' });
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
        const time = rec.time ? ` ${rec.time}` : '';
        openConfirm('送達不明の申請を再送信', `
          <p class="text-xs text-rose-700">初回の送信が実際には届いていた場合、この操作で<strong>同じ申請が二重に送信</strong>されます。送信後は取り下げできません。</p>
          <dl class="mt-2 grid grid-cols-3 gap-1 text-sm">
            <dt class="text-slate-500">対象</dt><dd class="col-span-2">${fmtDate(rec)} ${KIND_LABELS[rec.kind] ?? rec.kind}${esc(time)}</dd>
            ${rec.reason ? `<dt class="text-slate-500">理由</dt><dd class="col-span-2">${esc(rec.reason)}${rec.reasonDetail ? `(${esc(rec.reasonDetail)})` : ''}</dd>` : ''}
          </dl>`, () => resolveUnknown('resubmit'));
      }
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
  $('f1-problems').classList.add('hidden'); // 前回のパース失敗表示は次の取込開始でリセット
  const manualUrl = $('f1-manual-url').value.trim();
  const q = manualUrl ? `?manualUrl=${encodeURIComponent(manualUrl)}` : '';
  try {
    const res = await fetch(`/api/levtech/import${q}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'x-kintai-token': TOKEN },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error ?? `API エラー (${res.status})`);
      err.code = data.code;
      throw err;
    }
    toast(`${data.month} の作業実績表を読み取りました。スキャンを開始します`);
    watchJob(data.job.id);
  } catch (err) {
    // パース失敗は複数行の診断(直すべき箇所の一覧)になるため、消えるトーストではなく常設表示にする
    if (err.code === 'excel-parse') showImportProblems(err.message);
    else toast(err.message, true);
  }
}

function showImportProblems(message) {
  const box = $('f1-problems');
  const [head, ...rest] = String(message).split('\n');
  const items = rest.map((l) => l.replace(/^\s*-\s*/, '')).filter(Boolean);
  box.innerHTML = `<strong>${esc(head.replace(/:\s*$/, ''))}</strong>` +
    (items.length ? `<ul class="mt-1 list-disc pl-5">${items.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : '');
  box.classList.remove('hidden');
}

// クリックは label(for="f1-file")がネイティブにファイル選択を開くため JS 不要
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

// ---- ログイン操作 ----
$('login-start').onclick = async () => {
  try {
    await api('/api/login/start', { method: 'POST' });
    let pollFailures = 0;
    const timer = setInterval(async () => {
      // 一時的な通信断(サーバー再起動等)では止めない。連続失敗のみ明示的に停止する(watchJob と同方針)
      try {
        const login = await api('/api/login/status');
        pollFailures = 0;
        renderLogin(login);
        if (login.phase === 'idle') clearInterval(timer);
      } catch (err) {
        pollFailures++;
        if (pollFailures >= 5) {
          clearInterval(timer);
          toast(`ログイン状態を取得できません: ${err.message}。ページを再読み込みしてください`, true);
        }
      }
    }, 2000);
    renderLogin(await api('/api/login/status'));
  } catch (err) {
    toast(err.message, true);
  }
};

$('list-show-cancelled').onchange = renderRecords;

refresh().catch((err) => toast(err.message, true));
