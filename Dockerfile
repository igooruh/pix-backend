FROM node:24-alpine

WORKDIR /app

COPY . .

RUN npm i

ENV PORT=3000
EXPOSE 3000

CMD ["node", "src/server.js"]
