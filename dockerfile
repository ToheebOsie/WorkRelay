FROM node:22-slim
WORKDIR /app
COPY . .
CMD ["node", "src/app-server.js"]