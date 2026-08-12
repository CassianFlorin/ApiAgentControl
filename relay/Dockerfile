# 中继零依赖，用官方精简镜像即可，不需要 npm install
FROM node:22-alpine

WORKDIR /app
COPY server.js ./

# 平台注入的 PORT 优先；RELAY_SECRET 用来做准入校验
ENV PORT=8080
EXPOSE 8080

# 用 sh -c 以便展开环境变量
CMD sh -c 'node server.js --port "$PORT" ${RELAY_SECRET:+--secret "$RELAY_SECRET"}'
