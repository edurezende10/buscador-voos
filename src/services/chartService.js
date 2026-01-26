const QuickChart = require('quickchart-js');

async function generatePriceChart(labels, data, title) {
    const chart = new QuickChart();
    chart.setConfig({
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Preço (R$)',
                data: data,
                fill: false,
                borderColor: 'rgb(75, 192, 192)',
                tension: 0.1
            }]
        },
        options: {
            title: {
                display: true,
                text: title
            }
        }
    });
    chart.setWidth(800).setHeight(400);
    return await chart.getShortUrl();
}

module.exports = { generatePriceChart };
