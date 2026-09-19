"use strict";
// 生产进度：按扎看进度、按工序看进展、单扎详情，以及改扎件数 / 删扎。

/* ---- 进页面前拉数据 ---- */
LOADERS.cutprogress = async () => {
  state.pg = await api("GET", `/cut-orders/${route.id}/progress`);
  state.pgKw = state.pgKw || "";
};
LOADERS.bundleprogress = async () => {
  state.bp = await api("GET", "/bundles/" + route.id);
};
LOADERS.procprogress = async () => {
  state.pr = await api("GET", `/cut-orders/${route.id}/process-progress`);
};

/* ---- 页面渲染 ---- */
/* ---------- 生产进度（按扎） ---------- */
// 已完成数 = 各工序完成件数的最小值（能出货的）；进度条 = 工序件数 / 总工作量；x/y 道 = 整扎做完的工序数
function vCutProgress() {
  const d = state.pg;
  if (!d) return skeletonHtml(4);
  const o = d.order, procs = d.processes;
  const kw = (state.pgKw || "").trim();
  const list = rankFilter(d.bundles, kw, b => [b.bundle_no, b.ticket_no, b.color, b.size]);
  const pct = d.work_percent || 0;                              // 进度条：工序件数进度
  const shipPct = o.total_qty > 0 ? Math.round((d.completed_qty / o.total_qty) * 100) : 0;  // 能出货的件数占比
  return `<section class="group"><div class="card style-card">
      ${orderHeadHtml(o, kv("床次", o.bed_no) + kv("件数", num(o.total_qty))
        + kv("客户", esc(o.customer || "—")) + kv("工序", `${procs.length} 道`) + datesCell(o))}
      ${progRowHtml(pct)}
      <div class="cc-note">已做 ${num(d.work_done)} / ${num(d.work_total)} 工序件
        · 全工序做完 ${num(d.completed_qty)} 件（${shipPct}%）</div>
    </div></section>

    <section class="group"><div class="card">
      <button class="row-item tap w-row" onclick="go('procprogress','${o.id}')">
        <div class="row-main"><div class="row-label">查看工序进展</div>
          <div class="row-sub">每道工序做了多少、还剩多少，按颜色尺码分解</div></div>
        <span class="chev">›</span></button>
    </div></section>

    <section class="group">
      <div class="group-title">每扎进展</div>
      ${searchbarHtml("pg-kw", state.pgKw, "扎号 / 菲票号 / 颜色 / 尺码", "A.setPgKw")}
      ${list.length ? list.map(b => `<div class="card bundle-card">
        <button class="row-item tap w-row" onclick="go('bundleprogress','${b.id}')">
          <div class="row-main">
            <div class="row-label">扎号：${b.bundle_no}</div>
            <div class="sc-grid" style="margin-top:4px">
              ${kv("菲票ID", b.ticket_no)}${bundleCells(b)}
            </div>
            <div class="cc-prog" style="padding:8px 0 0">
              <span class="cc-prog-t">已完成数 ${num(b.done)}</span>
              <div class="pbar"><i style="width:${b.percent}%"></i></div>
              <span class="cc-pct num">${b.percent}%</span>
              <span class="cc-pct cc-pct-sub">${b.finished_procs}/${procs.length} 道</span></div>
          </div><span class="chev">›</span></button>
        ${isManager() ? `<div class="qty-edit-row">
          <button class="act-btn" onclick="A.editBundleQty('${b.id}',${b.qty})">修改裁床件数</button>
          <button class="act-btn danger" onclick="A.delBundle('${b.id}',${b.bundle_no},${b.qty})">删除这一扎</button></div>` : ""}
      </div>`).join("") : `<div class="card">${kw ? emptyHtml("没有匹配的扎号", "search") : emptyHtml("这张单还没有菲票", "cutting")}</div>`}
    </section>`;
}

/* ---------- 生产进度详情：一扎的每道工序 ---------- */
function vBundleProgress() {
  const d = state.bp;
  if (!d) return skeletonHtml(4);
  const b = d.bundle, o = d.order, procs = d.processes;
  const doneProcs = d.finished_procs, pct = d.work_percent || 0;
  return `<section class="group"><div class="card">
      <div class="row-item"><div class="row-main">
        <div class="row-label">扎号：${b.bundle_no}</div>
        <div class="sc-grid" style="margin-top:6px">
          ${kv("菲票号", b.ticket_no)}${bundleCells(b)}
        </div>
        ${progRowHtml(pct, "padding:10px 0 0")}
        <div class="cc-note">已做 ${num(d.work_done)} / ${num(d.work_total)} 工序件
          · 整扎做完 ${doneProcs} / ${procs.length} 道 · 全工序做完 ${num(d.done)} 件</div>
      </div></div>
    </div></section>

    <section class="group">
      <div class="group-title">每道工序进展</div>
      <div class="card">
        ${isManager() ? `<div class="qty-edit-row">
          <button class="act-btn" onclick="A.editBundleQty('${b.id}',${b.qty})">修改裁床件数</button>
          <button class="act-btn danger" onclick="A.delBundle('${b.id}',${b.bundle_no},${b.qty},'${o.id}')">删除这一扎</button></div>` : ""}
        ${procs.map(p => `<div class="row-item">
          <div class="row-main"><div class="row-label">${esc(p.name)}</div>
            <div class="pbar" style="margin-top:6px"><i style="width:${b.qty > 0 ? Math.round(p.done / b.qty * 100) : 0}%"></i></div></div>
          <div class="row-value">已完成${num(p.done)}件，剩余${num(p.remaining)}件</div>
        </div>`).join("")}
      </div>
      <div class="btn-row" style="padding-left:0;padding-right:0">
        <button class="btn ghost block" onclick="go('cutprogress','${o.id}')">返回该单进度</button></div>
    </section>`;
}

/* ---------- 工序进展：每道工序 + 颜色尺码分解 ---------- */
function vProcProgress() {
  const d = state.pr;
  if (!d) return skeletonHtml(4);
  return d.processes.length ? d.processes.map(p => `<section class="group">
      <div class="group-title">${esc(p.name)}</div>
      <div class="card">
        <div class="ring-wrap">
          <div class="ring" style="--p:${p.percent}"><span>${p.percent}%</span></div>
          <div class="ring-nums">
            <div class="rn"><div class="rn-v num">${num(p.total)}</div><div class="rn-l">工序总数</div></div>
            <div class="rn"><div class="rn-v num">${num(p.done)}</div><div class="rn-l">完成</div></div>
            <div class="rn"><div class="rn-v num">${num(p.remaining)}</div><div class="rn-l">余数</div></div>
          </div>
        </div>
        <div class="tbl-wrap"><table class="tbl">
          <tr><th>颜色</th><th>尺寸</th><th>工序总数</th><th>完成</th><th>余数</th></tr>
          ${p.breakdown.map(x => `<tr><td>${esc(x.color)}</td><td>${esc(x.size)}</td>
            <td class="num">${num(x.total)}</td><td class="num">${num(x.done)}</td><td class="num">${num(x.remaining)}</td></tr>`).join("")}
        </table></div>
      </div>
    </section>`).join("") : `<section class="group"><div class="card">${emptyHtml("这张单还没有工序", "processes")}</div></section>`;
}

/* ---- 按钮动作（onclick 里的 A.xxx） ---- */
Object.assign(A, {
  setPgKw: debouncedSearch("_pgT", "pg-kw", 250, (v) => { state.pgKw = v; }),
  // 删掉裁床单里单独的一扎：排错了一扎、或某个颜色尺码不做了，不用整张单重排。
  // 已经打过点的扎后端会拒（那等于把工人做过的活连工资一起抹掉）。
  delBundle(id, bundleNo, qty, backToOrderId) {
    modal({
      title: "删除这一扎", danger: true, okText: "删除",
      body: `确定删掉扎号 ${bundleNo}（${num(qty)} 件）吗？这张菲票作废，裁床单的总扎数和总件数会跟着减少。`,
      onOk: () => {
        (async () => {
          try {
            await api("DELETE", "/bundles/" + id);
            toast("已删除");
            // 详情页删完就没东西可看了，退回该单的进度页
            if (backToOrderId) go("cutprogress", backToOrderId);
            else { await loadView(route.v); render(); }
          } catch (e) { toast((e && e.error) || "删除失败"); }
        })();
        return true;
      }
    });
  },

  // 改的是"这一扎裁了多少件"（分母），不碰打点记录（分子）。
  // 改到比已完成数还小会造出"做了12件却只裁了3件"的鬼数据，后端会拦，这里把它的提示原样弹出来。
  editBundleQty(id, curQty) {
    modal({
      title: "修改裁床件数", input: true, value: String(curQty), okText: "保存",
      onOk: (v) => {
        const qty = Number(v);
        if (!(qty > 0)) { toast("件数要大于 0"); return false; }
        run(() => api("PATCH", "/bundles/" + id, { qty }), "已修改");
        return true;
      }
    });
  },
});
