FROM node:22-slim
WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY server ./server

# 云托管容器监听 80 端口。数据已迁到云托管 Serverless MySQL（连接信息走环境变量，
# 在「服务设置 → 环境变量」里配 MYSQL_HOST/MYSQL_PORT/MYSQL_USER/MYSQL_PASSWORD/MYSQL_DATABASE，
# 并设固定 JWT_SECRET 让"保持登录"跨部署有效）。DATA_DIR 仅存款式图上传（临时）。
ENV PORT=80
ENV DATA_DIR=/app/data
# 第二道保险：日期计算已经用固定 UTC+8 偏移算（server/daytime.js），不依赖这个变量；
# 但万一有遗漏的地方用了本地时间 API，把容器时区显式设成中国时区兜底。
ENV TZ=Asia/Shanghai
EXPOSE 80

CMD ["node", "server/index.js"]
