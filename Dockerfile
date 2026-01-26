FROM node:18-slim

# 1. Instala o Chromium compatível com ARM e fontes para não dar erro de texto
RUN apt-get update && apt-get install -y \
  chromium \
  fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

# 2. Variáveis de Ambiente OBRIGATÓRIAS para ARM
# Impede o Puppeteer de baixar o Chrome de Intel (que travaria)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
# Aponta para o Chromium de ARM que acabamos de instalar
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
COPY prisma/schema.prisma ./schema.prisma
RUN npx prisma generate

EXPOSE 3000

# Confirme se seu arquivo principal é index.js mesmo, senão mude aqui
CMD ["npm", "start"]