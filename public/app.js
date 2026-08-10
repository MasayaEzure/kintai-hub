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
let editingCustomId = null;
let jobTimer = null;
const watchedJobs = new Set(); // 完了ジョブを再監視して無限ループしないためのガード

// ---- 状態の取得と全体描画 --------------------------------------------------
async function refresh() {
  state = await api('/api/state');
  if (!$('f1-month').value) $('f1-month').value = state.defaultMonth;
  if (!$('f1-start').value) $('f1-start').value = state.workHours.start;
  if (!$('f1-end').value) $('f1-end').value = state.workHours.end;
  if (!$('f1-rest').value) $('f1-rest').value = state.workHours.rest;

  const problems = $('config-problems');
  if (state.problems?.length) {
    problems.classList.remove('hidden');
    problems.innerHTML = `<strong>設定の確認が必要です:</strong><ul class="mt-1 list-disc pl-5">${state.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`;
  } else {
    problems.classList.add('hidden');
  }

  renderRecords();
  renderLastRun();
  await renderPlan();
  if (state.job && ['running', 'awaiting_confirmation'].includes(state.job.state)) watchJob(state.job.id);
  else renderJob(state.job);
  renderLogin(state.login);
}

// ---- フロー①: 計画プレビュー ----
async function renderPlan() {
  const month = $('f1-month').value;
  if (!month) return;
  const q = new URLSearchParams({ month, start: $('f1-start').value, end: $('f1-end').value, rest: $('f1-rest').value });
  let plan;
  try {
    plan = await api(`/api/plan?${q}`);
  } catch (err) {
    $('f1-plan').innerHTML = `<p class="text-sm text-rose-600">${esc(err.message)}</p>`;
    return;
  }
  const special = plan.days.filter((d) => d.kind);
  const normal = plan.days.filter((d) => !d.kind).length;
  const rows = special
    .filter((d) => d.kind !== 'weekend')
    .map((d) => {
      const v = d.expected.start ? `${d.expected.start}-${d.expected.end} 休憩 ${d.expected.rest}` : '勤怠は空欄';
      const warn = d.unsubmitted ? ` ${badge(['未申請', 'bg-amber-100 text-amber-800'])}` : '';
      return `<tr class="border-b border-slate-100 last:border-0">
        <td class="py-1 pr-3 whitespace-nowrap">${d.label}(${d.dowLabel})</td>
        <td class="py-1 pr-3">${esc(d.note)}${warn}</td>
        <td class="py-1 text-slate-500">${v}</td>
      </tr>`;
    })
    .join('');
  $('f1-plan').innerHTML = `
    <div class="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
      <p class="text-slate-600">通常勤務 ${normal} 日(${esc(plan.workHours.start)}-${esc(plan.workHours.end)} 休憩 ${esc(plan.workHours.rest)})+ 下記の例外・祝日。土日は空欄のまま。</p>
      ${rows ? `<table class="mt-2 w-full text-left">${rows}</table>` : '<p class="mt-1 text-slate-400">例外日・祝日はありません。</p>'}
    </div>`;
}

function renderLastRun() {
  const month = $('f1-month').value;
  const run = state.levtechRuns?.[month];
  $('f1-lastrun').textContent = run
    ? `この月の直近実行: ${run.at.slice(0, 16).replace('T', ' ')}(${run.filledDays} 日 / ${run.totalHours})`
    : '';
}

// ---- ジョブパネル ----
function watchJob(jobId, { once = false } = {}) {
  if (once && watchedJobs.has(jobId)) return;
  watchedJobs.add(jobId);
  clearInterval(jobTimer);
  const poll = async () => {
    let job;
    try {
      job = await api(`/api/jobs/${jobId}`);
    } catch {
      clearInterval(jobTimer);
      return;
    }
    renderJob(job);
    if (!['running', 'awaiting_confirmation'].includes(job.state)) {
      clearInterval(jobTimer);
      const st = await api('/api/state');
      state = st;
      renderRecords();
      renderLastRun();
      renderPlan();
      renderLogin(st.login);
    }
  };
  jobTimer = setInterval(poll, 1200);
  poll();
}

function renderJob(job) {
  const panel = $('job-panel');
  if (!job) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  const stateLabel = {
    running: badge(['実行中', 'bg-blue-100 text-blue-800']),
    awaiting_confirmation: badge(['確認待ち', 'bg-amber-100 text-amber-800']),
    succeeded: badge(['成功', 'bg-emerald-100 text-emerald-800']),
    failed: badge(['失敗', 'bg-rose-100 text-rose-800']),
    cancelled: badge(['中止', 'bg-slate-100 text-slate-600']),
  }[job.state];
  const typeLabel = { 'levtech-fill': '月末勤怠入力', request: '例外日の申請・登録', 'typeform-retry': 'Typeform 再送信', 'session-check': 'セッションチェック' }[job.type] ?? job.type;
  const log = job.log.slice(-8).map((l) => `<div>${esc(l.msg)}</div>`).join('');

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
    <div class="mt-2 max-h-32 overflow-y-auto rounded bg-slate-50 p-2 font-mono text-xs text-slate-600">${log || '...'}</div>
    ${extra}`;
  bindPreviewHandlers(job);
}

function renderLevtechPreview(job) {
  const p = job.preview;
  const rows = p.rows
    .map((r) => {
      const cls = r.action === 'mismatch' ? 'bg-rose-50 text-rose-700' : r.action === 'fill' ? '' : 'text-slate-400';
      const exp = r.expected.start ? `${r.expected.start}-${r.expected.end}/${r.expected.rest}` : '空欄';
      const cur = r.existing ? (r.existing.start ? `${r.existing.start}-${r.existing.end}/${r.existing.rest}` : '空欄') : '—';
      const check = r.action === 'mismatch'
        ? `<input type="checkbox" class="approve-overwrite rounded border-rose-300" data-date="${r.date}" />`
        : '';
      const warn = r.unsubmitted ? ` ${badge(['未申請', 'bg-amber-100 text-amber-800'])}` : '';
      return `<tr class="border-b border-slate-100 last:border-0 ${cls}">
        <td class="py-0.5 pr-2 whitespace-nowrap">${r.label}(${r.dowLabel})</td>
        <td class="py-0.5 pr-2">${badge(ACTION_BADGES[r.action])}</td>
        <td class="py-0.5 pr-2 whitespace-nowrap">${cur}</td>
        <td class="py-0.5 pr-2 whitespace-nowrap">${exp}</td>
        <td class="py-0.5 pr-2">${esc(r.note)}${warn}</td>
        <td class="py-0.5 text-center">${check}</td>
      </tr>`;
    })
    .join('');
  return `
    <div class="mt-3 rounded-lg border border-slate-200 p-3">
      <p class="text-sm font-medium">保存前プレビュー(${esc(p.month)}): 入力 ${p.counts.fill} 日 / 一致 ${p.counts.match} 日 / <span class="${p.counts.mismatch ? 'text-rose-600 font-semibold' : ''}">不一致 ${p.counts.mismatch} 日</span></p>
      ${p.counts.mismatch ? '<p class="mt-1 text-xs text-rose-600">不一致の行は現状維持が既定です。期待値で上書きする行のみ右端をチェックしてください。</p>' : ''}
      <div class="mt-2 max-h-72 overflow-y-auto">
        <table class="w-full text-left text-xs">
          <thead class="sticky top-0 bg-white text-slate-400"><tr>
            <th class="py-1 pr-2 font-normal">日付</th><th class="py-1 pr-2 font-normal">判定</th>
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
  if (job.type === 'levtech-fill') {
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
  if (login.checkJobId) watchJob(login.checkJobId, { once: true });
}

// ---- 例外日一覧 ----
function renderRecords() {
  const showCancelled = $('list-show-cancelled').checked;
  const records = [...state.exceptions]
    .filter((r) => showCancelled || !r.cancelled)
    .sort((a, b) => b.date.localeCompare(a.date));
  const box = $('record-list');
  if (records.length === 0) {
    box.innerHTML = '<p class="text-sm text-slate-400">例外日はまだありません。</p>';
    return;
  }
  box.innerHTML = records.map(renderRecord).join('');
  box.querySelectorAll('[data-act]').forEach((btn) => (btn.onclick = () => handleRecordAction(btn)));
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
  const editable = !rec.cancelled && rec.statuses.typeform === 'none' && rec.statuses.calendar === 'none';
  if (editable && rec.kind === 'custom') actions.push(['edit-custom', '編集', 'border-slate-300']);
  if (editable) actions.push(['cancel-direct', '取消', 'border-slate-300']);
  if (!rec.cancelled) {
    const tfTarget = rec.cancellation && rec.cancellation.typeform !== 'none' ? rec.cancellation.typeform : rec.statuses.typeform;
    if (tfTarget === 'failed') actions.push(['retry-typeform', '申請を再送信', 'border-rose-300 text-rose-700']);
    if (rec.statuses.calendar === 'failed') actions.push(['retry-calendar', 'カレンダー再実行', 'border-rose-300 text-rose-700']);
    if (rec.statuses.typeform === 'submitted' && (!rec.cancellation || rec.cancellation.typeform === 'none')) {
      actions.push(['cancel-request', '取り消し申請', 'border-slate-300']);
    }
  }

  const actionsHtml = actions
    .map(([act, label, cls]) => `<button data-act="${act}" data-id="${rec.id}" class="rounded-lg border ${cls} px-2.5 py-1 text-xs hover:bg-slate-50">${label}</button>`)
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
          <button data-act="unknown-confirm" data-id="${rec.id}" class="rounded border border-purple-300 px-2 py-1 hover:bg-purple-100">届いていた → 申請済みにする</button>
          <button data-act="unknown-resubmit" data-id="${rec.id}" class="rounded border border-purple-300 px-2 py-1 hover:bg-purple-100">届いていない → 再送信</button>
        </div>
      </div>`;
  }

  // 取消済みでカレンダー登録が残っている場合のチェックリスト
  let cleanupUi = '';
  if (rec.cancelled && rec.cancellation && rec.statuses.calendar === 'registered' && !rec.cancellation.calendarCleanupDone) {
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
      openConfirm('レコードの取消', `<p>${fmtDate(rec)} の「${KIND_LABELS[rec.kind]}」を取り消します。どこにも反映されていないため申請は不要です。</p>`, async () => {
        await api(`/api/exceptions/${id}/cancel-direct`, { method: 'POST' });
        await refresh();
      });
    } else if (act === 'edit-custom') {
      editingCustomId = id;
      $('custom-date').value = rec.date;
      $('custom-start').value = rec.start;
      $('custom-end').value = rec.end;
      $('custom-rest').value = rec.rest;
      $('custom-add').textContent = '更新';
      $('custom-cancel-edit').classList.remove('hidden');
      $('custom-date').closest('details').open = true;
    } else if (act === 'retry-typeform') {
      openConfirm('申請の再送信', `<p>${fmtDate(rec)} の申請を Typeform へ再送信します。送信後は取り下げできません。</p>`, async () => {
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
      const action = act === 'unknown-confirm' ? 'confirm-submitted' : 'resubmit';
      const res = await api(`/api/exceptions/${id}/resolve-unknown`, { method: 'POST', body: { action, verified: true } });
      if (res.job) watchJob(res.job.id);
      else {
        toast('申請済みとして確定しました');
        await refresh();
      }
    } else if (act === 'cleanup-done') {
      await api(`/api/exceptions/${id}/cleanup-done`, { method: 'POST', body: { done: true } });
      await refresh();
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

// ---- フロー① 操作 ----
for (const id of ['f1-month', 'f1-start', 'f1-end', 'f1-rest']) {
  $(id).addEventListener('change', () => {
    renderPlan();
    renderLastRun();
  });
}

$('custom-add').onclick = async () => {
  const body = {
    kind: 'custom',
    date: $('custom-date').value,
    start: $('custom-start').value,
    end: $('custom-end').value,
    rest: $('custom-rest').value,
  };
  try {
    if (editingCustomId) {
      await api(`/api/exceptions/${editingCustomId}`, { method: 'PUT', body });
      toast('更新しました');
    } else {
      await api('/api/exceptions', { method: 'POST', body });
      toast('追加しました');
    }
    resetCustomForm();
    await refresh();
  } catch (err) {
    toast(err.message, true);
  }
};
$('custom-cancel-edit').onclick = resetCustomForm;
function resetCustomForm() {
  editingCustomId = null;
  for (const id of ['custom-date', 'custom-start', 'custom-end', 'custom-rest']) $(id).value = '';
  $('custom-add').textContent = '追加';
  $('custom-cancel-edit').classList.add('hidden');
}

$('f1-run').onclick = () => {
  const month = $('f1-month').value;
  const workHours = { start: $('f1-start').value, end: $('f1-end').value, rest: $('f1-rest').value };
  const manualUrl = $('f1-manual-url').value.trim();
  openConfirm('月末勤怠入力の開始', `
    <p><strong>${month}</strong> の作業報告に入力します(基本 ${workHours.start}-${workHours.end} 休憩 ${workHours.rest})。</p>
    <p class="mt-2 text-xs text-slate-500">この時点では何も書き込みません。スキャン後に保存前プレビューが表示され、承認した場合のみ入力・保存します。</p>
    ${manualUrl ? `<p class="mt-1 text-xs text-slate-500">手動 URL: ${esc(manualUrl)}</p>` : ''}`, async () => {
    const { job } = await api('/api/levtech/run', { method: 'POST', body: { month, workHours, manualUrl } });
    watchJob(job.id);
  });
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
