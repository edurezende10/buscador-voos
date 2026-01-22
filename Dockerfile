# Usa Node 18 (que tem suporte nativo para ARM64)
FROM node:18-slim

# 1. Instala o CHROMIUM (navegador open source compatível com ARM)
# e as dependências de fonte para renderizar a página corretamente
RUN apt-get update \
  && apt-get install -y chromium \
  fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

# 2. Configurações de Ambiente
# Pula o download do Chromium do Puppeteer (vamos usar o do sistema)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
  PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .

CMD [ "node", "index.js" ]