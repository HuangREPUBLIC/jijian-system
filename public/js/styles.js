"use strict";
// 款式管理：款式列表、新建 / 修改款式（含图片和工序）、修改工序页、同步工序到裁床单。

/* ---- 进页面前拉数据 ---- */
LOADERS.styles = async () => {
  const [s, o, p, w] = await Promise.all([
    api("GET", "/styles"), api("GET", "/style-options").catch(() => ({})), api("GET", "/processes"),
    getDailyWage()
  ]);
  state.dailyWage = w.value || 100;
  state.styles = s.styles || []; state.processes = p.processes || [];
  setStyleOptions(o);
  backfillThumbs();
};
LOADERS.styleprocs = async () => {
  const [r, roleRes, w] = await Promise.all([
    api("GET", `/styles/${route.id}/processes`),
    api("GET", "/roles").catch(() => ({ roles: [] })),  // 普通员工没有管理权限，取不到岗位列表就留空，不阻塞页面
    getDailyWage()
  ]);
  state.dailyWage = w.value || 100;
  if (!state.styles) state.styles = (await api("GET", "/styles")).styles || [];
  const style = state.styles.find((s) => s.id === route.id) || {};
  state.pe = {
    styleId: route.id,
    mode: (r.list[0] && r.list[0].price_mode) || "default",
    sizes: String(style.size || "").split(",").filter(Boolean),
    roles: roleRes.roles || [],
    items: r.list.map((x) => ({
      name: x.name, unitPrice: x.unit_price, prices: x.prices || {},
      showPrice: x.show_price !== false, visibleRoles: x.visible_roles || []
    }))
  };
};

/* ---- 页面渲染 ---- */
function vStyles() {
  if (styleForm) return vStyleForm();
  const list = state.styles;
  const kw = state.styleKw || "";
  // 搜索放在前端做：款式总量是几十到几百条，一次拉全再本地过滤，比每敲一个字打一次接口跟手。
  // 按相关度排序：款号完全相同的排第一，其次款号开头、款号包含、款名/客户包含
  const shown = list === null ? null : rankFilter(list, kw, s => [s.code, s.name, s.customer]);
  return `${searchbarHtml("st-kw", kw, "搜款号 / 款名 / 客户，空格隔开可组合", "A.setStyleKw")}
  ${list && list.length ? `<div class="list-meta">${normText(kw) ? `找到 ${shown.length} 个款式` : `共 ${list.length} 个款式`}</div>` : ""}

  ${shown === null ? skeletonHtml(4)
      : shown.length ? shown.map(s => {
        return `<section class="group"><div class="card style-card">
        <div class="sc-head">
          <span class="sc-thumb-wrap">${styleThumbHtml(s.id, s.image, s.image_count)}
            ${s.image_count > 1 ? `<span class="sc-imgn num" aria-label="共 ${s.image_count} 张图">${s.image_count}</span>` : ""}</span>
          <div class="sc-info">
            <div class="sc-title">款号 ${hl(s.code || "—", kw)}</div>
            <div class="sc-grid">
              ${kv("款名", hl(s.name || "—", kw))}
              ${kv("工序", `${num(s.process_count || 0)} 道`)}
              ${kv("工价", `¥${Number(s.total_price || 0).toFixed(4)}`)}
              ${kv("是否裁床", s.has_cutting === 0 ? "否" : "是")}
            </div>
          </div>
          <button class="sc-del" title="删除款式" aria-label="删除款式"
            onclick="A.delStyle('${s.id}')">${icon("trash")}</button>
        </div>
        <div class="sc-acts">
          <button onclick="A.editStyle('${s.id}')">编辑款式</button>
          <button onclick="go('cutform','${s.id}')">裁床编菲</button>
          <button onclick="go('styleprocs','${s.id}')">修改工序</button>
          <button onclick="A.openSyncProcs('${s.id}')">同步工序</button>
        </div>
      </div></section>`;
      }).join("")
      : `<section class="group"><div class="card">${normText(kw)
        ? emptyHtml(`没有找到「${kw.trim()}」相关的款式，换个关键词试试`, "search")
        : emptyHtml("还没有款式，点下面「新建款式」加第一个", "styles")}</div></section>`}

  <section class="group"><div class="btn-row" style="padding-left:0;padding-right:0">
    <button class="btn block" onclick="A.newStyle()">新建款式</button></div></section>`;
}

function vStyleForm() {
  const f = styleForm;
  return `<section class="group">
    <div class="group-title">基础信息</div>
    <div class="card">
      <div class="field"><span>款式图片</span>${photoPicker("style")}</div>
      <label class="field"><span>款号<span class="req">*</span></span>
        <input class="in ${f.err.code ? "bad" : ""}" id="sf-code" value="${esc(f.code)}" placeholder="请输入款号">
        ${f.err.code ? `<div class="field-err">${esc(f.err.code)}</div>` : ""}</label>
      <label class="field"><span>款式名称<span class="req">*</span></span>
        <input class="in ${f.err.name ? "bad" : ""}" id="sf-name" value="${esc(f.name)}" placeholder="请输入款式名称">
        ${f.err.name ? `<div class="field-err">${esc(f.err.name)}</div>` : ""}</label>
      ${optPickerHtml("size")}
      ${optPickerHtml("color")}
      ${optPickerHtml("customer")}
    </div>
  </section>

  <section class="group">
    <div class="group-title">生产工序</div>
    ${procEditorHtml()}
  </section>

  <section class="group"><div class="btn-row" style="padding-left:0;padding-right:0">
    <button class="btn block" onclick="A.saveStyle()">提交</button>
    <button class="btn ghost block" onclick="A.cancelStyle()">取消</button></div></section>`;
}
function vStyleProcs() {
  // go() 切路由后会先同步 render() 一次，这时 loadView 还没跑完，state.pe 可能还是上一个页面
  // 留下的 null（或者上一个款式的数据）——不判空直接调用 procEditorHtml() 会当场报错。
  if (!state.pe || state.pe.styleId !== route.id) return skeletonHtml(4);
  return procEditorHtml() + `<section class="group"><div class="btn-row" style="padding-left:0;padding-right:0">
    <button class="btn block" onclick="A.peSubmit()">保存</button>
    <button class="btn ghost block" onclick="go('styles')">取消</button></div></section>`;
}

/* ---- 按钮动作（onclick 里的 A.xxx） ---- */
Object.assign(A, {
  newStyle() {
    clearPhotoDraft(); photoDraft.style = [];
    styleForm = { id: "", name: "", code: "", customer: "", size: {}, color: {}, err: {}, origImages: [] };
    state.pe = { styleId: null, mode: "default", sizes: [], roles: [], items: [], loaded: true };
    formSnap.base = formSnap();
    render(); window.scrollTo(0, 0);
    // 新建款式也可能要按岗位设可见性，异步把岗位列表补上（普通员工没有权限就留空，不阻塞表单）
    api("GET", "/roles").then(r => { if (state.pe) { state.pe.roles = r.roles || []; render(); } }).catch(() => {});
  },
  // 编辑款式：工序和原图分开取。工序没取到之前不许提交（否则会用空列表把库里的工序整套覆盖掉）；
  // 原图没取到时图片区锁住并给"重新加载"，保存时不带图片字段
  async editStyle(id) {
    const s = (state.styles || []).find(x => x.id === id); if (!s) return;
    const size = {}, color = {};
    String(s.size || "").split(",").forEach(x => { if (x) size[x] = true; });
    String(s.color || "").split(",").forEach(x => { if (x) color[x] = true; });
    clearPhotoDraft();
    styleForm = { id: s.id, name: s.name, code: s.code || "", customer: s.customer || "", size, color, err: {}, origImages: null, imageCount: s.image_count || 0 };
    state.pe = { styleId: s.id, mode: "default", sizes: String(s.size || "").split(",").filter(Boolean), roles: [], items: [], loaded: false };
    formSnap.base = null;
    A.loadStyleImages();
    render(); window.scrollTo(0, 0);
    try {
      const [r, roleRes] = await Promise.all([
        api("GET", `/styles/${id}/processes`),
        api("GET", "/roles").catch(() => ({ roles: [] }))
      ]);
      if (!styleForm || styleForm.id !== id) return;          // 等的时候已经退出了编辑
      state.pe = {
        styleId: s.id, loaded: true,
        mode: (r.list[0] && r.list[0].price_mode) || "default",
        sizes: String(s.size || "").split(",").filter(Boolean),
        roles: roleRes.roles || [],
        items: r.list.map((x) => ({
          name: x.name, unitPrice: x.unit_price, dailyQuota: x.daily_quota,
          prices: x.prices || {}, showPrice: x.show_price !== false, visibleRoles: x.visible_roles || []
        }))
      };
      formSnap.base = formSnap();
      render();
    } catch (e) { render(); toast(((e && e.error) || "加载失败") + "，工序没取到，请返回重新打开"); }
  },
  // 取编辑中款式的原图（失败可重试）；取回之前按张数摆占位
  async loadStyleImages() {
    const f = styleForm; if (!f || !f.id) return;
    f.imagesLocked = false;
    photoDraft.style = Array.from({ length: f.imageCount }, () => ({ key: "p" + (++photoSeq), src: "", data: "", status: "processing" }));
    refreshPicker("style");
    try {
      const full = await api("GET", "/styles/" + f.id);
      if (styleForm !== f) return;
      const imgs = styleImages(full.style || {});
      cacheFullImgs(f.id, imgs.filter(showable));
      f.origImages = imgs;
      photoDraft.style = imgs.map(photoItem);
      if (formSnap.base && state.pe && state.pe.loaded) formSnap.base = formSnap();
    } catch (e) {
      if (styleForm !== f) return;
      photoDraft.style = []; f.imagesLocked = true;
      toast((e && e.error) || "原图没加载出来");
    }
    refreshPicker("style");
  },
  cancelStyle() { styleForm = null; state.pe = null; clearPhotoDraft(); formSnap.base = null; render(); },
  // 表单里有多处操作会触发重绘（选尺码/颜色、加工序…），重绘前先把输入框里的内容存回 styleForm
  syncStyleForm() {
    if (!styleForm) return;
    if ($("sf-name")) styleForm.name = val("sf-name");
    if ($("sf-code")) styleForm.code = val("sf-code");
  },

  setStyleKw: debouncedSearch("_stT", "st-kw", 250, (v) => { state.styleKw = v; }),

  // 同步工序：裁床单的工序是下单时的快照（改价不追溯历史工资），要生效得在这里选单同步
  async openSyncProcs(styleId) {
    let r;
    try { r = await api("GET", `/styles/${styleId}/syncable-orders`); }
    catch (e) { return toast((e && e.error) || "取裁床单失败"); }
    const list = r.list || [];
    if (!list.length) return toast("这个款式还没有裁床单，不需要同步");
    state.syncPick = new Set(list.map(o => o.id));   // 默认全选，跟参考系统一致
    state.syncList = list;
    state.syncStyleId = styleId;
    A.renderSyncModal();
  },
  renderSyncModal() {
    const html = `<div class="card" style="margin-top:0">${state.syncList.map(o => `
      <label class="row-item sync-row">
        <input type="checkbox" ${state.syncPick.has(o.id) ? "checked" : ""}
          onchange="A.toggleSyncPick('${o.id}',this.checked)">
        <div class="row-main">
          <div class="row-label">床次：${o.bed_no}</div>
          <div class="row-sub">制单号 ${esc(o.doc_no || "—")} · 工序数 ${o.process_count} · 工价 ${num(o.total_price)}</div>
          <div class="row-sub">裁单日期 ${esc(o.cut_date || "—")} · 已完成件数 ${num(o.completed_qty)}</div>
          <div class="pbar"><i style="width:${o.percent}%"></i></div>
        </div>
      </label>`).join("")}</div>`;
    modal({
      title: "选择需要同步的裁床单", html, okText: "同步", onOk: () => {
        const ids = [...state.syncPick];
        if (!ids.length) { toast("至少选一张裁床单"); return false; }
        run(() => api("POST", `/styles/${state.syncStyleId}/processes/sync`, { orderIds: ids }), `已同步 ${ids.length} 张裁床单`);
        return true;
      }
    });
  },
  toggleSyncPick(id, on) { if (on) state.syncPick.add(id); else state.syncPick.delete(id); },

  saveStyle() {
    return guard("saveStyle", async () => {
      A.syncStyleForm();
      const f = styleForm;
      if (!f) return;
      f.err = {};
      if (!f.name) f.err.name = "请填写款式名称";
      if (!f.code) f.err.code = "请填写款号";
      if (f.err.name || f.err.code) {
        render();
        // 滚到第一个出错的输入框并聚焦，别让人在长表单里自己找
        const bad = document.querySelector(".in.bad"); if (bad) { bad.scrollIntoView({ block: "center" }); bad.focus(); }
        return;
      }
      if (!state.pe || !state.pe.loaded) return toast("工序还没加载出来，不能提交，请返回重新打开");
      const draft = photoDraft.style || [];
      if (draft.some(p => p.status === "processing")) return toast("图片还在处理，请稍等几秒再提交");
      if (draft.some(p => p.status === "error")) return toast("有图片处理失败了，点它重试或者删掉再提交");
      const images = draft.map(p => p.data);
      const body = {
        name: f.name, code: f.code,
        size: Object.keys(f.size).join(","), color: Object.keys(f.color).join(","), customer: f.customer
      };
      // 图片没动过就不带图片字段，避免改个款名也要把几 MB 的图原样再传一遍
      const same = f.origImages && f.origImages.length === images.length && f.origImages.every((u, k) => u === images[k]);
      if (!f.imagesLocked && !(f.id && same)) {
        body.images = images; body.image = images[0] || "";
        if (images[0]) { try { body.thumb = await makeThumb(images[0]); } catch (e) { } }
      }
      try {
        toast("保存中…", true);
        const r = await api(f.id ? "PATCH" : "POST", f.id ? "/styles/" + f.id : "/styles", body);
        const styleId = f.id || (r.style && r.style.id);
        state.pe.styleId = styleId;
        await api("PUT", `/styles/${styleId}/processes`, { items: A.peCollect() });
        if (body.images) cacheFullImgs(styleId, images.filter(showable));
        styleForm = null; state.pe = null; clearPhotoDraft(); formSnap.base = null;
        await loadView("styles"); render(); toast("已保存");
      } catch (e) { toast((e && e.error) || "保存失败"); }
    });
  },
  delStyle(id) {
    modal({
      title: "删除款式", body: "确定删除这个款式吗？", danger: true, okText: "删除",
      onOk: () => run(() => api("DELETE", "/styles/" + id), "已删除")
    });
  },
});
