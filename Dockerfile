FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
COPY docs ./docs
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json README.md LICENSE THIRD_PARTY_NOTICES.md ./
COPY webui ./webui
COPY docs ./docs
COPY dytranob.config.example.json ./
RUN mkdir /app/data && chown node:node /app/data
USER node
EXPOSE 5088
CMD ["node", "dist/cli.js", "--config", "/app/dytranob.config.json"]
