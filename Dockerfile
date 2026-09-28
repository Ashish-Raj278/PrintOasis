FROM node:24-slim

ENV NODE_ENV=production
ENV DATA_DIR=/var/data

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /var/data

EXPOSE 3000

CMD ["node", "server.js"]
