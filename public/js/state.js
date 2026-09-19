"use strict";
// 全局状态：state 存页面数据，route 是当前页面；A 是所有 onclick 处理函数的汇总（各功能文件用 Object.assign(A, {…}) 往里加）。
// 计件跟踪前端（无构建的原生 JS PWA）：state 存数据，go(view,id) 切页，A.* 是 onclick 处理，v* 函数返回 HTML。
// 权限由服务端校验，这里只管隐藏入口；token 存 localStorage，只有 401 或主动退出才清掉。
// 代码按功能拆在 public/js/ 下，加载顺序见 index.html；想改某个页面，看 docs/前端结构.md。

// 所有 onclick="A.xxx()" 调用的处理函数都挂在这个对象上，各功能文件各加各的
const A = {};

const TOKEN_KEY = "jj_token";

let state = {
  token: localStorage.getItem(TOKEN_KEY) || null,
  me: null,
  users: null, roles: null,
  processes: null, styles: null,
  dailyWage: 100,
  tplList: null, tplEditing: null,   // 工序模板（整套工序清单） styleOptions: null, styleKw: "",
  // 生产管理页：range 是概览卡的今日/昨日/本月；tab 是"按裁床单看/按款看"；from/to 是明细的日期区间
  co: { range: "today", tab: "sheet", kw: "", from: "", to: "", dateOpen: false, overview: null, list: null, byStyle: null },
  // 裁床编菲表单。colors/sizes 的顺序就是矩阵的行列顺序，也就是扎号编号的遍历顺序，
  // 所以是按点选先后入列的数组，不是集合。
  cf: null,
  cv: null,   // 查看裁床单：{ order, bundles, processes, summary }
  pg: null, pgKw: "",  // 生产进度（按扎）
  pr: null,            // 工序进展
  bp: null,            // 生产进度详情（一扎的每道工序）
  cp: null,            // 打印菲票设置
  home: { today: 0, mgr: null, emp: null },
  // 扫菲打点：ticketInput 是手输/扫出来的扎号或菲票号，bundle/bundleOrder/bundleProcs 是查到的那一扎
  scan: { date: todayStr(), records: null, eff: null,
    ticketInput: "", bundle: null, bundleOrder: null, bundleProcs: null, camOn: false, camMsg: "" },
  att: { userId: "", date: todayStr(), records: null },
  eff: { month: monthStr(), list: null },
  // 打点记录：scope 是后端按岗位定的范围（mine=只有自己 / all=全员），who 是管理层加的人员筛选
  slog: { date: todayStr(), records: null, scope: "mine", who: "" },
  pay: { month: monthStr(), list: null, mine: null, editing: "" },
  empKw: "", empPage: 1,
  pushOn: false,
  notif: { unread: 0, list: null, recent: null },   // list：通知页/铃铛面板；recent：首页"最近动态"
  // 尺码/颜色/客户三个选项控件各自的展开状态与搜索词。桌面端展开是下拉面板，手机端是底部弹层。
  optUI: { size: { open: false, kw: "" }, color: { open: false, kw: "" }, customer: { open: false, kw: "" } },
  // 工序编辑器：款式表单里的「生产工序」段落和款式列表的「修改工序」页共用这份状态
  pe: null
};
const EMP_PAGE_SIZE = 10;       // 管理页员工列表每页条数
let route = { v: "home", id: null };
let showWelcome = false;        // 打开 App 时短暂展示的欢迎界面（logo/公司名称/计件跟踪）
let modalState = null;
let deferredInstall = null;     // 安卓/桌面 Chrome 的原生安装事件
let notifPanelOpen = false;     // 桌面端顶部铃铛下拉面板是否展开
let styleForm = null;           // 款式表单

const isMobileDevice = () => /iPhone|iPad|iPod|Android|Mobile|HarmonyOS/i.test(navigator.userAgent || "")
  || (navigator.maxTouchPoints > 1 && window.matchMedia && window.matchMedia("(pointer:coarse)").matches);
const isStandalone = () => (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches)
  || window.navigator.standalone === true;

let bootTarget = null;   // 没登录时从深链接 / 推送进来的目标页，登录后直接去
let bootError = "";      // 启动时连不上服务器（不是登录失效），显示重试页而不是把人踢回登录
