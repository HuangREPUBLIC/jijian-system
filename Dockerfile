FROM node:22-slim
WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY server ./server
# 前端(PWA)也要进镜像：server/index.js 用 express.static 从 ../public 提供前端，
# 只拷 server/ 的话容器里没有 public/，起来只有 API、页面打不开。
# （目前生产是 systemd 直接跑 node，不走这个 Dockerfile；留着是为了它别是错的。）
COPY public ./public

# 容器监听 80 端口。数据在 MySQL（连接信息走环境变量
# MYSQL_HOST/MYSQL_PORT/MYSQL_USER/MYSQL_PASSWORD/MYSQL_DATABASE，
# 并设固定 JWT_SECRET 让"保持登录"跨部署有效）。DATA_DIR 仅存款式图上传。
ENV PORT=80
ENV DATA_DIR=/app/data
# 第二道保险：日期计算已经用固定 UTC+8 偏移算（server/daytime.js），不依赖这个变量；
# 但万一有遗漏的地方用了本地时间 API，把容器时区显式设成中国时区兜底。
ENV TZ=Asia/Shanghai
EXPOSE 80

CMD ["node", "server/index.js"]
