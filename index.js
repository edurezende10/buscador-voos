require('dotenv').config();
const express = require('express');
const botController = require('./src/controllers/botController');
const { monitorarViagens } = require('./src/services/scraperService');

const app = express();
const PORT = process.env.PORT || 3000;

// Init Bot Interactions
botController.init();

// Web Server
app.get('/', (req, res) => res.send('🤖 Bot de Passagens (SQLite/Modular) ONLINE.'));

// Trigger Monitoring Manually
app.get('/rodar', async (req, res) => {
    res.send('Processo disparado em background.');
    monitorarViagens();
});

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
console.log('✅ Sistema modularizado iniciado.');