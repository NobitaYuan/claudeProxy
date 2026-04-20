FROM node:20-slim
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod
COPY dist/ ./dist/
RUN mkdir -p data
EXPOSE 3000
CMD ["node", "dist/index.js"]
