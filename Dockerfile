FROM node:22-alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production CRM_DB=/data/crm.db
VOLUME /data
EXPOSE 3000 3001
HEALTHCHECK --interval=30s CMD wget -qO- http://127.0.0.1:${PORT:-3000}/health || exit 1
CMD ["node", "server.js"]
