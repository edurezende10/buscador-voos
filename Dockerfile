# Usa a imagem oficial do Puppeteer
# Ela já vem com o Node.js e o Google Chrome instalado corretamente
FROM ghcr.io/puppeteer/puppeteer:21.5.0

# Configura variáveis para o Puppeteer usar o Chrome da imagem
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

WORKDIR /usr/src/app

# Copia os arquivos de definição de dependências
COPY package*.json ./

# Troca para o usuário ROOT temporariamente para instalar as dependências
# (Isso evita erros de permissão de pasta no Render)
USER root
RUN npm install

# Volta para o usuário seguro do Puppeteer (pptruser)
# O Chrome não gosta de rodar como root
USER pptruser

# Copia o resto dos arquivos do projeto
COPY . .

# Expõe a porta 3000 para o servidor Express
EXPOSE 3000

# Comando para iniciar o bot
CMD [ "node", "index.js" ]