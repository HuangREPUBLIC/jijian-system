"use strict";
// 接口汇总：路径和权限都写在各业务文件里，这里只负责挂到 /api 下。想改某个接口，按业务找文件：
//   users 账号与员工 · processes 工序与模板 · styles 款式 · scan 打点 · wages 考勤/效率/工资
//   ../routes_cutting.js 裁床与生产进度 · notifications 通知与推送
const express = require("express");
const { wrapAsync } = require("../async_router");

const router = express.Router();
wrapAsync(router, ["get", "post", "put", "patch", "delete", "all"]);

router.use(require("./users"));
router.use(require("./processes"));
router.use(require("./styles"));
router.use(require("./scan"));
router.use(require("./wages"));
router.use(require("../routes_cutting").router);
router.use(require("./notifications"));

module.exports = router;
