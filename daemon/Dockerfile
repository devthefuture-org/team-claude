FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache tini \
    && addgroup -g 1000 daemon-app \
    && adduser -D -u 1000 -G daemon-app daemon-app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
USER daemon-app
EXPOSE 7000
ENTRYPOINT ["/sbin/tini", "--", "node", "src/server.js"]
