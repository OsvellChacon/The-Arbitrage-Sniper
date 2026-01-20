const socket = io({
  transports: ['websocket'],
  upgrade: false,
  rememberUpgrade: false
});

const state = {
  binance: { bid: 0, ask: 0, prevBid: 0, prevAsk: 0 },
  kraken: { bid: 0, ask: 0, prevBid: 0, prevAsk: 0 },
  stats: {
    signalsCount: 0,
    ordersCount: 0,
    totalProfit: 0,
    spreads: [],
    maxSpread: 0,
    avgLatency: 0
  },
  chartRange: 60,
  isConnected: false,
  pendingUpdate: false,
  lastPriceUpdate: 0
};

const UI_UPDATE_INTERVAL = 50; // 50ms = 20 actualizaciones por segundo máximo

const elements = {
  binBid: document.getElementById('bin-bid'),
  binAsk: document.getElementById('bin-ask'),
  binBidChange: document.getElementById('bin-bid-change'),
  binAskChange: document.getElementById('bin-ask-change'),
  kraBid: document.getElementById('kra-bid'),
  kraAsk: document.getElementById('kra-ask'),
  kraBidChange: document.getElementById('kra-bid-change'),
  kraAskChange: document.getElementById('kra-ask-change'),
  spread: document.getElementById('spread'),
  spreadDescription: document.getElementById('spread-description'),
  signalList: document.getElementById('signal-list'),
  ordersList: document.getElementById('orders-list'),
  signalsCount: document.getElementById('signals-count'),
  ordersCount: document.getElementById('orders-count'),
  totalProfit: document.getElementById('total-profit'),
  avgLatency: document.getElementById('avg-latency'),
  avgSpread: document.getElementById('avg-spread'),
  maxSpread: document.getElementById('max-spread'),
  lastUpdate: document.getElementById('last-update'),
  statusIndicator: document.getElementById('status-indicator'),
  connectionStatus: document.getElementById('connection-status')
};

// Utilidades
function formatPrice(price) {
  return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function getPriceChangeIndicator(current, previous) {
  if (current === previous || previous === 0) return '';
  const diff = ((current - previous) / previous) * 100;
  if (Math.abs(diff) < 0.001) return '';
  const icon = current > previous ? '▲' : '▼';
  const className = current > previous ? 'text-success' : 'text-danger';
  return `<span class="${className}">${icon}</span>`;
}

function updateLastUpdate() {
  const now = new Date();
  elements.lastUpdate.textContent = now.toLocaleTimeString('es-ES');
}

function calculateSpread() {
  if (!state.binance.ask || !state.kraken.bid || state.binance.ask === 0 || state.kraken.bid === 0) {
    return { value: 0, profitable: false };
  }
  
  const spread = ((state.kraken.bid - state.binance.ask) / state.binance.ask) * 100;
  const profitable = spread > 0.1;
  
  return { value: Math.abs(spread), profitable };
}

function updateStats(spreadValue) {

  state.stats.spreads.push(spreadValue);
  if (state.stats.spreads.length > 1000) {
    state.stats.spreads.shift();
  }
  
  const avgSpread = state.stats.spreads.reduce((a, b) => a + b, 0) / state.stats.spreads.length;
  state.stats.maxSpread = Math.max(state.stats.maxSpread, spreadValue);
  
  elements.avgSpread.textContent = avgSpread.toFixed(3) + '%';
  elements.maxSpread.textContent = state.stats.maxSpread.toFixed(3) + '%';
}

// Conexión Socket.IO
socket.on('connect', () => {
  state.isConnected = true;
  elements.statusIndicator.className = 'status-indicator status-connected';
  elements.connectionStatus.textContent = 'Conectado';
  console.log('✓ Conectado al servidor');
});

socket.on('disconnect', () => {
  state.isConnected = false;
  elements.statusIndicator.className = 'status-indicator status-disconnected';
  elements.connectionStatus.textContent = 'Desconectado';
  console.log('✗ Desconectado del servidor');
});

socket.on('price-update', (data) => {
  // Actualizar estado inmediatamente
  if (data.exchange === 'binance') {
    state.binance.prevBid = state.binance.bid;
    state.binance.prevAsk = state.binance.ask;
    state.binance.bid = data.bid;
    state.binance.ask = data.ask;
  } else if (data.exchange === 'kraken') {
    state.kraken.prevBid = state.kraken.bid;
    state.kraken.prevAsk = state.kraken.ask;
    state.kraken.bid = data.bid;
    state.kraken.ask = data.ask;
  }

  // Throttle de actualizaciones DOM
  const now = Date.now();
  if (state.pendingUpdate || now - state.lastPriceUpdate < UI_UPDATE_INTERVAL) {
    return;
  }
  
  state.pendingUpdate = true;
  state.lastPriceUpdate = now;
  
  requestAnimationFrame(() => {
    // Actualizar UI de Binance
    if (state.binance.bid > 0) {
      elements.binBid.textContent = formatPrice(state.binance.bid);
      elements.binAsk.textContent = formatPrice(state.binance.ask);
      elements.binBidChange.innerHTML = getPriceChangeIndicator(state.binance.bid, state.binance.prevBid);
      elements.binAskChange.innerHTML = getPriceChangeIndicator(state.binance.ask, state.binance.prevAsk);
    }
    
    // Actualizar UI de Kraken
    if (state.kraken.bid > 0) {
      elements.kraBid.textContent = formatPrice(state.kraken.bid);
      elements.kraAsk.textContent = formatPrice(state.kraken.ask);
      elements.kraBidChange.innerHTML = getPriceChangeIndicator(state.kraken.bid, state.kraken.prevBid);
      elements.kraAskChange.innerHTML = getPriceChangeIndicator(state.kraken.ask, state.kraken.prevAsk);
    }

    // Calcular y mostrar spread
    const { value: spreadValue, profitable } = calculateSpread();
    elements.spread.textContent = spreadValue.toFixed(3) + '%';
    
    if (profitable) {
      elements.spread.classList.add('spread-profitable');
      elements.spreadDescription.innerHTML = '<i class="bi bi-check-circle-fill text-success"></i> Oportunidad detectada';
    } else {
      elements.spread.classList.remove('spread-profitable');
      elements.spreadDescription.textContent = spreadValue > 0.05 ? 'Spread moderado' : 'Spread bajo';
    }
    
    updateStats(spreadValue);
    updateLastUpdate();
    
    // Actualizar gráfico
    if (data.exchange === 'binance') {
      updateChartData('binance', data);
    } else if (data.exchange === 'kraken') {
      updateChartData('kraken', data);
    }
    
    state.pendingUpdate = false;
  });
});

// Señales de arbitraje
socket.on('signal', (data) => {
  let time = '';
  let message = '';
  
  if (typeof data === 'string') {
    message = data;
    time = new Date().toLocaleTimeString('es-ES');
  } else {
    message = data.message || '';
    time = data.time ? new Date(data.time).toLocaleTimeString('es-ES') : new Date().toLocaleTimeString('es-ES');
  }

  // Remover estado vacío si existe
  const emptyState = elements.signalList.querySelector('.empty-state');
  if (emptyState) {
    emptyState.remove();
  }

  const signalItem = document.createElement('div');
  
  // Parsear la señal para extraer información
  let buyExchange = '';
  let sellExchange = '';
  let profitEstimate = '';
  let isProfitable = false;
  let buyPrice = '';
  let sellPrice = '';
  let spread = '';
  
  const arrowMatch = message.match(/(\w+)\s*→\s*(\w+)/);
  if (arrowMatch) {
    buyExchange = arrowMatch[1];
    sellExchange = arrowMatch[2];
  }
  
  const profitMatch = message.match(/Si ejecutas ahora:\s*([+\-]\$[\d.]+)/);
  if (profitMatch) {
    profitEstimate = profitMatch[1];
    isProfitable = profitEstimate.startsWith('+');
  }
  
  const buyPriceMatch = message.match(/Compra:\s*\$([0-9,]+\.\d+)/);
  const sellPriceMatch = message.match(/Venta:\s*\$([0-9,]+\.\d+)/);
  const spreadMatch = message.match(/Spread:\s*([\d.]+)%/);
  
  if (buyPriceMatch) buyPrice = buyPriceMatch[1];
  if (sellPriceMatch) sellPrice = sellPriceMatch[1];
  if (spreadMatch) spread = spreadMatch[1];
  
  signalItem.className = `signal-item ${isProfitable ? 'signal-profitable' : 'signal-loss'}`;
  
  // Extraer información de la señal para el botón
  const signalData = {
    message: message,
    time: time,
    buyExchange: buyExchange,
    sellExchange: sellExchange
  };
  
  // HTML simplificado y más directo
  signalItem.innerHTML = `
    <div class="signal-profit-badge ${isProfitable ? 'profit-positive' : 'profit-negative'}">
      ${profitEstimate}
    </div>
    <div class="signal-content">
      <div class="signal-header">
        <span class="signal-route">${buyExchange} → ${sellExchange}</span>
        <span class="signal-time">${time}</span>
      </div>
      <div class="signal-details">
        <span>Compra: $${buyPrice}</span>
        <span>Venta: $${sellPrice}</span>
        <span>Spread: ${spread}%</span>
      </div>
    </div>
    <button class="btn-execute ${!isProfitable ? 'btn-disabled' : ''}" 
            data-signal='${JSON.stringify(signalData)}'
            ${!isProfitable ? 'disabled' : ''}>
      <i class="bi bi-${isProfitable ? 'play-circle' : 'x-circle'}"></i> 
      ${isProfitable ? 'Ejecutar' : 'No Rentable'}
    </button>
  `;
  
  // Agregar event listener al botón
  const executeBtn = signalItem.querySelector('.btn-execute');
  executeBtn.addEventListener('click', function() {
    executeSignal(JSON.parse(this.dataset.signal), signalItem);
  });
  
  elements.signalList.insertBefore(signalItem, elements.signalList.firstChild);
  
  while (elements.signalList.children.length > 50) {
    elements.signalList.removeChild(elements.signalList.lastChild);
  }
  
  state.stats.signalsCount++;
  elements.signalsCount.textContent = state.stats.signalsCount;
});

// Órdenes ejecutadas
socket.on('order-executed', (order) => {
  console.log('Orden recibida:', order);
  
  const emptyState = elements.ordersList.querySelector('.empty-state');
  if (emptyState) {
    emptyState.remove();
  }

  const orderItem = document.createElement('div');
  orderItem.className = 'order-item';
  
  const route = `${order.buy_exchange.toUpperCase()} → ${order.sell_exchange.toUpperCase()}`;
  const profitClass = order.net_profit > 0 ? 'text-success' : 'text-danger';
  
  orderItem.innerHTML = `
    <div class="order-badge">EJECUTADA</div>
    <div class="order-details">
      <div class="order-route">
        <strong>${route}</strong> | Compra: $${order.buy_price.toLocaleString()} | Venta: $${order.sell_price.toLocaleString()}
      </div>
      <div class="order-profit">
        Cantidad: ${order.amount} BTC | Fees: $${order.fees.toFixed(2)} | ROI: ${order.profit_pct}%
      </div>
    </div>
    <div class="order-metrics">
      <div class="profit ${profitClass}">$${order.net_profit.toFixed(2)}</div>
      <div>${order.execution_time_ms}ms</div>
    </div>
  `;
  
  elements.ordersList.insertBefore(orderItem, elements.ordersList.firstChild);
  
  while (elements.ordersList.children.length > 30) {
    elements.ordersList.removeChild(elements.ordersList.lastChild);
  }
  
  state.stats.ordersCount++;
  state.stats.totalProfit += parseFloat(order.net_profit);
  
  elements.ordersCount.textContent = state.stats.ordersCount;
  elements.totalProfit.textContent = '$' + state.stats.totalProfit.toFixed(2);
  
  if (state.stats.totalProfit > 0) {
    elements.totalProfit.style.color = '#3fb950';
  } else if (state.stats.totalProfit < 0) {
    elements.totalProfit.style.color = '#f85149';
  }
  
  console.log('Contadores actualizados - Órdenes:', state.stats.ordersCount, 'Ganancia:', state.stats.totalProfit);
});

// Métricas de rendimiento
socket.on('metrics-update', (metrics) => {
  console.log('Métricas recibidas:', metrics);
  
  if (metrics.avg_latency_ms !== undefined) {
    state.stats.avgLatency = metrics.avg_latency_ms;
    elements.avgLatency.textContent = metrics.avg_latency_ms.toFixed(2) + 'ms';
    
    if (metrics.avg_latency_ms < 5) {
      elements.avgLatency.style.color = '#3fb950';
    } else if (metrics.avg_latency_ms < 10) {
      elements.avgLatency.style.color = '#d29922';
    } else {
      elements.avgLatency.style.color = '#f85149';
    }
  }
  
});

const canvas = document.getElementById('priceChart');
const ctx = canvas.getContext('2d', { alpha: false });

const dpr = window.devicePixelRatio || 1;
function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  canvas.style.width = rect.width + 'px';
  canvas.style.height = rect.height + 'px';
}
resizeCanvas();

window.addEventListener('resize', () => {
  resizeCanvas();
  drawChart();
});

// Datos del gráfico
let chartDataBinance = [];
let chartDataKraken = [];
const chartUpdateInterval = 500; // Actualizar cada 500ms
let lastChartUpdate = 0;
let needsRedraw = false;

const chartColors = {
  background: '#1f2937',
  grid: 'rgba(48, 54, 61, 0.5)',
  text: '#8b949e',
  binance: '#f0b90b',
  kraken: '#5741d9'
};

function drawChart() {
  if (chartDataBinance.length === 0 && chartDataKraken.length === 0) {
    ctx.fillStyle = chartColors.background;
    ctx.fillRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    ctx.fillStyle = chartColors.text;
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Esperando datos...', canvas.width / (2 * dpr), canvas.height / (2 * dpr));
    return;
  }

  const width = canvas.width / dpr;
  const height = canvas.height / dpr;
  const padding = { top: 20, right: 50, bottom: 30, left: 50 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  ctx.fillStyle = chartColors.background;
  ctx.fillRect(0, 0, width, height);

  const allData = [...chartDataBinance, ...chartDataKraken];
  if (allData.length === 0) return;

  const allValues = allData.map(d => d.value);
  const minPrice = Math.min(...allValues);
  const maxPrice = Math.max(...allValues);
  const priceRange = maxPrice - minPrice || 1;

  const maxPoints = state.chartRange;
  const timeStep = chartWidth / Math.max(maxPoints - 1, 1);

  const scaleY = (value) => {
    return padding.top + chartHeight - ((value - minPrice) / priceRange) * chartHeight;
  };

  ctx.strokeStyle = chartColors.grid;
  ctx.lineWidth = 1;
  
  for (let i = 0; i <= 5; i++) {
    const y = padding.top + (chartHeight / 5) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();

    // Etiquetas de precio
    const price = maxPrice - (priceRange / 5) * i;
    ctx.fillStyle = chartColors.text;
    ctx.font = '11px monospace';
    ctx.textAlign = 'right';
    ctx.fillText('$' + price.toFixed(2), padding.left - 5, y + 4);
  }

  const step = Math.max(Math.floor(maxPoints / 10), 1);
  for (let i = 0; i < maxPoints; i += step) {
    const x = padding.left + i * timeStep;
    ctx.beginPath();
    ctx.moveTo(x, padding.top);
    ctx.lineTo(x, height - padding.bottom);
    ctx.stroke();
  }

  // Función para dibujar línea
  function drawLine(data, color) {
    if (data.length === 0) return;

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();

    data.forEach((point, i) => {
      const x = padding.left + i * timeStep;
      const y = scaleY(point.value);

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });

    ctx.stroke();

    if (data.length > 0) {
      const lastPoint = data[data.length - 1];
      const x = padding.left + (data.length - 1) * timeStep;
      const y = scaleY(lastPoint.value);

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = chartColors.text;
      ctx.font = 'bold 12px monospace';
      ctx.textAlign = 'left';
      ctx.fillText('$' + lastPoint.value.toFixed(2), width - padding.right + 5, y + 4);
    }
  }

  drawLine(chartDataBinance, chartColors.binance);
  drawLine(chartDataKraken, chartColors.kraken);

  needsRedraw = false;
}

function updateChartData(exchange, data) {
  const now = Date.now();
  
  if (exchange === 'binance') {
    chartDataBinance.push({ value: data.ask, time: now });
    if (chartDataBinance.length > state.chartRange) {
      chartDataBinance.shift();
    }
  } else if (exchange === 'kraken') {
    chartDataKraken.push({ value: data.bid, time: now });
    if (chartDataKraken.length > state.chartRange) {
      chartDataKraken.shift();
    }
  }

  needsRedraw = true;

  if (now - lastChartUpdate > chartUpdateInterval) {
    lastChartUpdate = now;
    requestAnimationFrame(drawChart);
  }
}

function renderLoop() {
  if (needsRedraw) {
    drawChart();
  }
  requestAnimationFrame(renderLoop);
}
renderLoop();

document.querySelectorAll('.btn-chart[data-range]').forEach(btn => {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.btn-chart[data-range]').forEach(b => b.classList.remove('active'));
    this.classList.add('active');
    const newRange = parseInt(this.dataset.range);
    state.chartRange = newRange;
    
    if (chartDataBinance.length > newRange) {
      chartDataBinance = chartDataBinance.slice(-newRange);
    }
    if (chartDataKraken.length > newRange) {
      chartDataKraken = chartDataKraken.slice(-newRange);
    }
    
    drawChart();
  });
});

document.getElementById('clear-chart').addEventListener('click', () => {
  chartDataBinance = [];
  chartDataKraken = [];
  drawChart();
});

document.getElementById('clear-signals').addEventListener('click', () => {
  elements.signalList.innerHTML = `
    <div class="empty-state">
      <i class="bi bi-inbox"></i>
      <p>No hay señales. Esperando oportunidades de arbitraje...</p>
    </div>
  `;
  state.stats.signalsCount = 0;
  elements.signalsCount.textContent = '0';
});

document.getElementById('clear-orders').addEventListener('click', () => {
  elements.ordersList.innerHTML = `
    <div class="empty-state">
      <i class="bi bi-inbox"></i>
      <p>No hay órdenes ejecutadas. Esperando oportunidades...</p>
    </div>
  `;
});

function executeSignal(signalData, signalElement) {
  socket.emit('execute-manual-order', signalData);
  
  if (signalElement) {
    signalElement.style.opacity = '0.5';
    signalElement.style.pointerEvents = 'none';
    const badge = signalElement.querySelector('.signal-badge');
    if (badge) {
      badge.textContent = 'EJECUTADO';
      badge.classList.remove('bg-success', 'bg-warning');
      badge.classList.add('bg-secondary');
    }
    const btn = signalElement.querySelector('.btn-execute');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="bi bi-check-circle"></i> Ejecutado';
      btn.style.opacity = '0.5';
    }
  }
  
  const notification = document.createElement('div');
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: var(--success);
    color: white;
    padding: 1rem 1.5rem;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    z-index: 9999;
    animation: slideIn 0.3s ease;
  `;
  notification.innerHTML = `
    <strong><i class="bi bi-check-circle"></i> Orden Enviada</strong><br>
    <small>${signalData.message}</small>
  `;
  document.body.appendChild(notification);
  
  setTimeout(() => {
    notification.style.animation = 'slideOut 0.3s ease';
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}