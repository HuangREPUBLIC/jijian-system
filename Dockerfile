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
EXPOSE 80

CMD ["node", "server/index.js"]
