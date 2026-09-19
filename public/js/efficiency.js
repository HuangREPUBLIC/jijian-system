"use strict";
// 效率看板：员工月度效率汇总。

/* ---- 进页面前拉数据 ---- */
LOADERS.efficiency = async () => {
  state.eff.list = (await api("GET", "/efficiency/summary?month=" + state.eff.month)).list || [];
};

/* ---- 页面渲染 ---- */
/* ---------- 效率看板：完成度 = 时效小时 / 出勤小时；没考勤的人单独列出，不当 0% ---------- */
function effBarPct(p) { return Math.max(0, Math.min(100, Math.round((p || 0) * 100))); }
function effTone(p) { return p >= 1 ? "ok" : p >= 0.8 ? "warn" : "bad"; }

function vEfficiency() {
  const raw = state.eff.list;
  const head = `<section class="group"><div class="card">
    <label class="field"><span>月份</span>${monthFieldHtml("ef-month", state.eff.month, "A.setEffMonth(this.value)")}</label>
  </div></section>`;
  if (raw === null) return head + skeletonHtml(4);

  // 这个月完全没动静的人（没打点也没考勤）不占榜单位置
  const list = raw.filter(x => x.qty > 0 || x.attendanceHours > 0);
  const rated = list.filter(x => x.percent !== null).sort((a, b) => b.percent - a.percent);
  const unrated = list.filter(x => x.percent === null).sort((a, b) => (b.qty || 0) - (a.qty || 0));

  const totalQty = list.reduce((n, x) => n + (Number(x.qty) || 0), 0);
  const totalAtt = list.reduce((n, x) => n + (Number(x.attendanceHours) || 0), 0);
  const totalEff = rated.reduce((n, x) => n + (Number(x.effectiveHours) || 0), 0);
  const avg = totalAtt > 0 ? totalEff / totalAtt : null;

  const card = (x, rank) => {
    const p = x.percent;
    const tone = p === null ? "none" : effTone(p);
    return `<div class="rank-item">
      <span class="rank-no${rank !== null && rank <= 3 ? " top" + rank : ""}">${rank === null ? "—" : rank}</span>
      <div class="rank-main">
        <div class="rank-top">
          <span class="rank-name">${esc(x.name)}</span>
          <span class="tag role">${esc(x.roleLabel || "")}</span>
        </div>
        <div class="pbar lg"><i class="${tone}" style="width:${p === null ? 0 : effBarPct(p)}%"></i></div>
        <div class="rank-sub">打点 ${num(x.qty)} 件 · 出勤 ${num(x.attendanceHours)} 小时 · 时效 ${num(x.effectiveHours)} 小时</div>
      </div>
      <div class="rank-right">
        <div class="rank-pct num ${tone}">${p === null ? "—" : pctText(p)}</div>
        <div class="rank-pct-l">${p === null ? "缺考勤" : "完成度"}</div>
      </div>
    </div>`;
  };

  return head + `
  <section class="group"><div class="sum-bar">
    <div class="sum-item"><div class="sum-num num">${num(totalQty)}</div><div class="sum-label">打点件数</div></div>
    <div class="sum-item"><div class="sum-num num">${num(totalAtt)}</div><div class="sum-label">出勤小时</div></div>
    <div class="sum-item"><div class="sum-num num ${avg === null ? "" : effTone(avg)}">${avg === null ? "—" : pctText(avg)}</div>
      <div class="sum-label">整体完成度</div></div>
  </div></section>

  <section class="group">
    <div class="group-title">完成度排行 · ${esc(fmtMonth(state.eff.month))}</div>
    <div class="card">${rated.length ? rated.map((x, i) => card(x, i + 1)).join("")
      : emptyHtml("这个月还没有能算完成度的人（要先录考勤）", "efficiency")}</div>
  </section>

  ${unrated.length ? `<section class="group">
    <div class="group-title">缺考勤，算不出完成度</div>
    <div class="card">${unrated.map(x => card(x, null)).join("")}</div>
    <div class="pe-hint">完成度 = 时效小时 ÷ 出勤小时，这些人本月没有考勤记录，
      去「考勤录入」补上工时就能进排行。</div>
  </section>` : ""}`;
}

/* ---- 按钮动作（onclick 里的 A.xxx） ---- */
Object.assign(A, {
  setEffMonth(v) { if (!v) return; state.eff.month = v; state.eff.list = null; go("efficiency"); },
});
