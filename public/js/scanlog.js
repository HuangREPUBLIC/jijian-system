"use strict";
// 打点记录：按天看全员（或自己）的打点流水。

/* ---- 进页面前拉数据 ---- */
LOADERS.scanlog = async () => {
  const r = await api("GET", "/scan-all?date=" + state.slog.date);
  state.slog.records = r.records || [];
  state.slog.scope = r.scope || "mine";
};

/* ---- 页面渲染 ---- */
function slogRowHtml(r, withWho) {
  // 扫扎打点带得出扎号/菲票/颜色尺码；自由打点这些都是空的，那一行就只剩工序名
  const where = [
    r.bundle_no ? `扎号 ${r.bundle_no}` : "",
    r.ticket_no ? `菲票 ${r.ticket_no}` : "",
    r.color || "", r.size || ""
  ].filter(Boolean).join(" · ");
  const styleTag = r.style_code || r.style_name
    ? `<span class="tag">${esc(r.style_code || r.style_name)}${r.bed_no ? ` · 床次${r.bed_no}` : ""}</span>` : "";
  return `<div class="slog-item">
    ${withWho ? `<span class="avatar mini">${esc(shortName(r.user_name))}</span>` : ""}
    <div class="slog-main">
      <div class="slog-top">
        ${withWho ? `<span class="slog-who">${esc(r.user_name)}</span>` : ""}
        <span class="slog-proc">${esc(r.process_name)}</span>${styleTag}
      </div>
      ${where ? `<div class="slog-sub">${esc(where)}</div>` : ""}
      <div class="slog-time">${HHMM(r.created_at)}</div>
    </div>
    <div class="slog-right">
      <div class="slog-qty num">${num(r.qty)}<span class="slog-unit">件</span></div>
      ${r.amount === null || r.amount === undefined ? "" : `<div class="slog-amt num">¥${num(r.amount)}</div>`}
    </div>
  </div>`;
}

function vScanlog() {
  const sl = state.slog, all = sl.records, seeAll = sl.scope === "all";
  const head = `<section class="group"><div class="card">
    <label class="field"><span>日期</span>${dateFieldHtml("sl-date", sl.date, "A.setSlogDate(this.value)")}</label>
  </div></section>`;
  if (all === null) return head + skeletonHtml(4);
  // 人员筛选只列当天真打过点的人，不拉整张员工表——没打点的人摆在这里只会碍事
  const people = [];
  for (const r of all) if (!people.some(x => x.id === r.user_id)) people.push({ id: r.user_id, name: r.user_name });
  const who = people.some(x => x.id === sl.who) ? sl.who : "";
  const recs = who ? all.filter(r => r.user_id === who) : all;

  const qty = recs.reduce((n, r) => n + (Number(r.qty) || 0), 0);
  const amt = recs.reduce((n, r) => n + (Number(r.amount) || 0), 0);
  const hasAmt = recs.some(r => r.amount !== null && r.amount !== undefined);

  return head + `
  <section class="group"><div class="sum-bar">
    <div class="sum-item"><div class="sum-num num">${num(qty)}</div><div class="sum-label">打点件数</div></div>
    <div class="sum-item"><div class="sum-num num">${seeAll && !who ? people.length : recs.length}</div>
      <div class="sum-label">${seeAll && !who ? "打点人数" : "打点笔数"}</div></div>
    <div class="sum-item"><div class="sum-num num">${hasAmt ? num(amt) : "—"}</div><div class="sum-label">计件金额（元）</div></div>
  </div></section>

  ${seeAll && people.length > 1 ? `<section class="group">
    <div class="chiprow">
      <button class="chip${who ? "" : " on"}" onclick="A.setSlogWho('')">全部</button>
      ${people.map(x => `<button class="chip${who === x.id ? " on" : ""}"
        onclick="A.setSlogWho('${x.id}')">${esc(x.name)}</button>`).join("")}
    </div>
  </section>` : ""}

  <section class="group">
    <div class="group-title">${seeAll ? (who ? esc((people.find(x => x.id === who) || {}).name) + " 的打点" : "全员打点") : "我的打点"}
      · ${esc(fmtDate(sl.date))}${recs.length ? ` · ${recs.length} 笔` : ""}</div>
    <div class="card">${recs.length ? recs.map(r => slogRowHtml(r, seeAll && !who)).join("")
      : emptyHtml(seeAll ? "这天还没有人打点" : "这天你还没有打点记录", "scanlog")}</div>
  </section>`;
}

/* ---- 按钮动作（onclick 里的 A.xxx） ---- */
Object.assign(A, {
  setSlogDate(v) { if (!v) return; state.slog.date = v; state.slog.records = null; state.slog.who = ""; go("scanlog"); },
  // 人员筛选是纯前端的：记录已经全在手上，不用为了切人再跑一趟接口
  setSlogWho(id) { state.slog.who = state.slog.who === id ? "" : id; render(); },
});
