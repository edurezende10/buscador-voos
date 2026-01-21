# Usa uma imagem leve do Node.js
FROM node:18-slim

# 1. Instala dependências do sistema e o Google Chrome Estável
# Isso é essencial para o Puppeteer rodar no Linux (Koyeb/Docker)
RUN apt-get update \
    && apt-get install -y wget gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# 2. Configura variáveis de ambiente para o Puppeteer
# Diz para NÃO baixar o Chromium (usaremos o Chrome instalado acima)
# Diz onde o Chrome está instalado
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# 3. Define pasta de trabalho
WORKDIR /usr/src/app

# 4. Copia os arquivos de dependência e instala
COPY package*.json ./
RUN npm install

# 5. Copia o restante do código
COPY . .

# 6. Comando para iniciar o robô
CMD [ "node", "index.js" ]