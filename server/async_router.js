"use strict";
// express4 不会捕获 async handler 的异常（请求会挂起）：统一包一层 .catch(next)，错误中间件（4 个参数）不包
function wrapAsync(router, methods) {
  for (const m of methods) {
    const orig = router[m].bind(router);
    router[m] = (routePath, ...handlers) => orig(routePath, ...handlers.map((h) =>
      (typeof h === "function" && h.length < 4)
        ? function (req, res, next) { return Promise.resolve(h(req, res, next)).catch(next); }
        : h
    ));
  }
  return router;
}

module.exports = { wrapAsync };
