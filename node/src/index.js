require('dotenv').config();

const WebSocket = require('ws');
const zmq = require('zeromq');
const http = require('http');
const express = require('express');
const path = require('path');
const { Server } = require('socket.io');
const Redis = require('ioredis');

// Configuración
const ZMQ_PUSH_ADDRESS = 'tcp://python:5555';
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const PORT = 3000;

const redis = new Redis({ host: REDIS_HOST }); 
const redisPub = new Redis({ host: REDIS_HOST });

const pushSocket = new zmq.Push();
const dns = require('dns').promises;

const zmqQueue = [];
let zmqSending = false;

async function sendToZMQ(data) {
  return new Promise((resolve, reject) => {
    zmqQueue.push({ data, resolve, reject });
    processZMQQueue();
  });
}

async function processZMQQueue() {
  if (zmqSending || zmqQueue.length === 0) return;
  
  zmqSending = true;
  const { data, resolve, reject } = zmqQueue.shift();
  
  try {
    await pushSocket.send(JSON.stringify(data));
    resolve();
  } catch (err) {
    console.error('✗ ZMQ error:', err.message);
    reject(err);
  } finally {
    zmqSending = false;
    if (zmqQueue.length > 0) {
      setImmediate(() => processZMQQueue());
    }
  }
}

async function initPushSocket() {
  const m = /^tcp:\/\/([^:\/]+):(\d+)$/.exec(ZMQ_PUSH_ADDRESS);
  if (!m) {
    pushSocket.connect(ZMQ_PUSH_ADDRESS);
    console.log('ZeroMQ PUSH conectado a', ZMQ_PUSH_ADDRESS);
    return;
  }

  const host = m[1];
  const port = m[2];
  let connectHost = host;

  try {
    await dns.lookup(host);
  } catch (err) {
    console.warn(`No se resolvió host '${host}', usando 127.0.0.1 como fallback.`);
    connectHost = '127.0.0.1';
  }

  const connectAddress = `tcp://${connectHost}:${port}`;
  try {
    pushSocket.connect(connectAddress);
    console.log('ZeroMQ PUSH conectado a', connectAddress);
  } catch (err) {
    console.error('Error conectando ZeroMQ PUSH:', err);
  }
}

initPushSocket().catch(err => console.error('initPushSocket error:', err));

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket'],
  allowUpgrades: false,
  perMessageDeflate: {
    threshold: 1024
  },
  httpCompression: {
    threshold: 1024
  }
});

let connectedClients = 0;
let totalMessages = 0;
let lastMetrics = {
  avg_latency_ms: 0,
  total_orders: 0,
  total_profit: 0
};

io.on('connection', (socket) => {
  connectedClients++;
  const clientId = socket.id.substring(0, 8);
  console.log(`Cliente conectado [${clientId}] - Total: ${connectedClients}`);
  
  socket.emit('message', {
    type: 'welcome',
    text: 'Conectado al Arbitrage Sniper',
    timestamp: Date.now()
  });

  socket.on('disconnect', () => {
    connectedClients--;
    console.log(`Cliente desconectado [${clientId}] - Total: ${connectedClients}`);
  });

  socket.on('error', (err) => {
    console.error(`Socket error [${clientId}]:`, err.message);
  });
  
  socket.on('execute-manual-order', (signalData) => {
    console.log(`Orden manual solicitada por [${clientId}]:`, signalData.message);
    
    const timestamp = Date.now();
    
    const buyMatch = signalData.message.match(/Compra: \$(\d+(?:,\d+)*(?:\.\d+)?)/i);
    const sellMatch = signalData.message.match(/Venta: \$(\d+(?:,\d+)*(?:\.\d+)?)/i);
    const exchangeMatch = signalData.message.match(/(\w+)\s*→\s*(\w+)/);
    
    if (buyMatch && sellMatch && exchangeMatch) {
      const buyPrice = parseFloat(buyMatch[1].replace(/,/g, ''));
      const sellPrice = parseFloat(sellMatch[1].replace(/,/g, ''));
      const buyExchange = exchangeMatch[1].toLowerCase();
      const sellExchange = exchangeMatch[2].toLowerCase();
      const amount = 0.01;
      
      const buyCost = buyPrice * amount;
      const sellRevenue = sellPrice * amount;
      const grossProfit = sellRevenue - buyCost;
      const fees = (buyCost + sellRevenue) * 0.001;
      const netProfit = grossProfit - fees;
      const profitPct = (netProfit / buyCost) * 100;
      
      const isBinanceBuy = buyExchange === 'binance';
      
      const order = {
        id: `ORD-MANUAL-${timestamp}`,
        timestamp: timestamp,
        buy_exchange: buyExchange,
        sell_exchange: sellExchange,
        buy_price: buyPrice,
        sell_price: sellPrice,
        amount: amount,
        gross_profit: parseFloat(grossProfit.toFixed(2)),
        fees: parseFloat(fees.toFixed(2)),
        net_profit: parseFloat(netProfit.toFixed(2)),
        profit_pct: parseFloat(profitPct.toFixed(3)),
        execution_time_ms: parseFloat((1 + Math.random() * 2).toFixed(2)),
        status: 'EXECUTED',
        manual: true
      };
      
      io.emit('order-executed', order);
      console.log(`Orden manual ejecutada: ${order.id} | Ganancia: $${order.net_profit}`);
    } else {
      console.error('No se pudieron extraer precios de la señal:', signalData.message);
    }
  });
});

// Función para normalizar datos
function normalizeData(raw, exchange) {
  return {
    exchange,
    timestamp: Date.now(),
    bid: parseFloat(raw.b || raw.bidPrice || 0),  // Adaptar según exchange
    ask: parseFloat(raw.a || raw.askPrice || 0),
    bidQty: parseFloat(raw.B || raw.bidQty || 0),
    askQty: parseFloat(raw.A || raw.askQty || 0),
  };
}

// ---------------------
// BINANCE WebSocket
// ---------------------
const binanceWsUrl = 'wss://data-stream.binance.vision:443/ws/btcusdt@bookTicker';

function createBinanceWs() {
  const ws = new WebSocket(binanceWsUrl);

  ws.on('open', () => {
    console.log('Conectado a Binance WebSocket');
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.s === 'BTCUSDT') {
        const normalized = normalizeData(msg, 'binance');
        
        // Validar datos antes de enviar
        if (!normalized.bid || !normalized.ask || normalized.bid <= 0 || normalized.ask <= 0) {
          console.warn('⚠ Datos inválidos de Binance:', normalized);
          return;
        }
        
        // Enviar a Python vía ZMQ usando cola
        sendToZMQ(normalized).catch(() => {});
        
        // Emitir al dashboard
        try {
          io.emit('price-update', normalized);
          totalMessages++;
        } catch (e) {
          console.error('✗ Socket.io emit error:', e.message);
        }
      }
    } catch (e) {
      console.error('✗ Error parsing Binance message:', e.message);
    }
  });

  ws.on('error', (err) => {
    console.error('Binance WS error:', err && err.message ? err.message : err);
    // No volver a lanzar: cerramos la conexión y dejamos que 'close' gestione la reconexión
    try { ws.close(); } catch (e) {}
  });

  ws.on('close', () => {
    console.log('Binance WS cerrado. Reconectando en 5s...');
    setTimeout(() => {
      createBinanceWs();
    }, 5000);
  });

  return ws;
}

// ---------------------
// KRAKEN WebSocket (más complejo, usa suscripción JSON)
// ---------------------
const krakenWsUrl = 'wss://ws.kraken.com';

function createKrakenWs() {
  const ws = new WebSocket(krakenWsUrl);

  ws.on('open', () => {
    console.log('Conectado a Kraken WebSocket');
    const subscribeMsg = {
      event: 'subscribe',
      pair: ['XBT/USDT'],
      subscription: { name: 'ticker' }
    };
    try { ws.send(JSON.stringify(subscribeMsg)); } catch (e) { console.error('Kraken subscribe send error:', e); }
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (Array.isArray(msg) && msg[1] && msg[1].a && msg[1].b) {
        const ticker = msg[1];
        const normalized = {
          exchange: 'kraken',
          timestamp: Date.now(),
          ask: parseFloat(ticker.a[0]),
          askQty: parseFloat(ticker.a[1]),
          bid: parseFloat(ticker.b[0]),
          bidQty: parseFloat(ticker.b[1]),
        };
        
        // Validar datos
        if (!normalized.bid || !normalized.ask || normalized.bid <= 0 || normalized.ask <= 0) {
          console.warn('⚠ Datos inválidos de Kraken:', normalized);
          return;
        }
        
        // Enviar a Python vía ZMQ usando cola
        sendToZMQ(normalized).catch(() => {});
        
        // Emitir al dashboard
        try {
          io.emit('price-update', normalized);
          totalMessages++;
        } catch (e) {
          console.error('✗ Socket.io emit error:', e.message);
        }
      }
    } catch (e) {
      // Mensajes de eventos no JSON de Kraken - silenciar
      if (e.message && !e.message.includes('JSON')) {
        console.error('✗ Error parsing Kraken message:', e.message);
      }
    }
  });

  ws.on('error', (err) => {
    console.error('Kraken WS error:', err && err.message ? err.message : err);
    try { ws.close(); } catch (e) {}
  });

  ws.on('close', () => {
    console.log('Kraken WS cerrado. Reconectando en 5s...');
    setTimeout(() => createKrakenWs(), 5000);
  });

  return ws;
}

// Modo de simulación: si `SIMULATE` !== 'false' entonces generamos ticks aleatorios
const SIMULATE = process.env.SIMULATE !== 'false';

if (!SIMULATE) {
  createBinanceWs();
  createKrakenWs();
} else {
  console.log('Modo SIMULADO activado: generando datos localmente');
  simulatePrices();
}

// ---------------------
// Función de simulación
// ---------------------
function simulatePrices() {
  let base = 50000;
  let binancePrice = base + Math.random() * 100;
  let krakenPrice = base + Math.random() * 100;
  let lastSignalTime = 0;
  const SIGNAL_COOLDOWN = 8000; // Generar señal cada 8 segundos mínimo
  const SPREAD_THRESHOLD_SIM = 0.05; // Threshold más bajo para ver señales

  setInterval(() => {
    // pequeño random-walk
    binancePrice += (Math.random() - 0.5) * 20;
    krakenPrice += (Math.random() - 0.5) * 20;

    // Ocasionalmente crear una oportunidad de arbitraje
    const createOpportunity = Math.random() > 0.85; // 15% de probabilidad
    if (createOpportunity) {
      // Hacer que Kraken sea más alto que Binance
      krakenPrice = binancePrice + (25 + Math.random() * 30);
    }

    const timestamp = Date.now();
    const bin = {
      exchange: 'binance',
      timestamp: timestamp,
      bid: parseFloat((binancePrice - Math.random() * 2).toFixed(2)),
      ask: parseFloat((binancePrice + Math.random() * 2).toFixed(2))
    };

    const kra = {
      exchange: 'kraken',
      timestamp: timestamp,
      bid: parseFloat((krakenPrice - Math.random() * 2).toFixed(2)),
      ask: parseFloat((krakenPrice + Math.random() * 2).toFixed(2))
    };

    // Emitir localmente al dashboard
    try { io.emit('price-update', bin); } catch (e) {}
    try { io.emit('price-update', kra); } catch (e) {}

    // Publicar en Redis para mantener flujo consistente (usar redisPub)
    try { redisPub.publish('price-updates', JSON.stringify(bin)); } catch (e) {}
    try { redisPub.publish('price-updates', JSON.stringify(kra)); } catch (e) {}

    // Simular detección de arbitraje y ejecución de órdenes
    const now = Date.now();
    if (now - lastSignalTime > SIGNAL_COOLDOWN) {
      // Calcular spread
      const spread = ((kra.bid - bin.ask) / bin.ask) * 100;
      
      if (spread > SPREAD_THRESHOLD_SIM) {
        const signal = {
          time: now,
          message: `COMPRA BINANCE $${bin.ask.toFixed(2)} → VENDE KRAKEN $${kra.bid.toFixed(2)} | Spread: ${spread.toFixed(3)}%`
        };
        
        // Simular ejecución de orden
        const executionTime = 1 + Math.random() * 3; // 1-4ms
        const amount = 0.01;
        const buyCost = bin.ask * amount;
        const sellRevenue = kra.bid * amount;
        const grossProfit = sellRevenue - buyCost;
        const fees = (buyCost + sellRevenue) * 0.001;
        const netProfit = grossProfit - fees;
        const profitPct = (netProfit / buyCost) * 100;
        
        const order = {
          id: `ORD-${now}`,
          timestamp: now,
          buy_exchange: 'binance',
          sell_exchange: 'kraken',
          buy_price: bin.ask,
          sell_price: kra.bid,
          amount: amount,
          gross_profit: parseFloat(grossProfit.toFixed(2)),
          fees: parseFloat(fees.toFixed(2)),
          net_profit: parseFloat(netProfit.toFixed(2)),
          profit_pct: parseFloat(profitPct.toFixed(3)),
          execution_time_ms: parseFloat(executionTime.toFixed(2)),
          status: 'EXECUTED'
        };
        
        try {
          io.emit('signal', signal);
          io.emit('order-executed', order);
          
          // Simular métricas
          const metrics = {
            avg_latency_ms: 1.5 + Math.random() * 2,
            last_latency_ms: executionTime,
            process_time_ms: 0.5 + Math.random(),
            total_opportunities: Math.floor(now / 10000),
            total_orders: Math.floor(now / 15000),
            total_profit: netProfit * Math.floor(now / 15000)
          };
          io.emit('metrics-update', metrics);
          
          redisPub.publish('arbitrage-signals', signal.message);
          lastSignalTime = now;
        } catch (e) {
          console.error('Error emitiendo señal/orden:', e.message);
        }
      }
    }

  }, 2000); // Reducir frecuencia a 2 segundos
}

// Inicia servidor Socket.io
server.listen(PORT, () => {
  console.log('╔═══════════════════════════════════════════════════╗');
  console.log('║       ARBITRAGE SNIPER - Dashboard Server       ║');
  console.log('╠═══════════════════════════════════════════════════╣');
  console.log(`║  URL: http://localhost:${PORT}`.padEnd(54) + '║');
  console.log(`║  Modo: ${SIMULATE ? 'SIMULACIÓN' : 'EN VIVO'}`.padEnd(54) + '║');
  console.log(`║  Redis: ${REDIS_HOST}`.padEnd(54) + '║');
  console.log(`║  ZMQ: ${ZMQ_PUSH_ADDRESS}`.padEnd(54) + '║');
  console.log('╚═══════════════════════════════════════════════════╝');
});

// Reportar métricas cada 30 segundos
setInterval(() => {
  if (connectedClients > 0 || totalMessages > 0) {
    console.log(`Métricas - Clientes: ${connectedClients} | Mensajes: ${totalMessages} | Uptime: ${Math.floor(process.uptime())}s`);
  }
}, 30000);

// Suscribirse a señales y actualizaciones de precios en Redis (para dashboard)
redis.subscribe('arbitrage-signals', 'price-updates', 'executed-orders', 'performance-metrics', (err, count) => {
  if (err) console.error('Redis subscribe error:', err);
  else console.log('✓ Suscrito a', count, 'canales Redis');
});

redis.on('message', (channel, message) => {
  try {
    if (channel === 'price-updates') {
      const parsed = JSON.parse(message);
      io.emit('price-update', parsed);
    } else if (channel === 'arbitrage-signals') {
      io.emit('signal', { time: Date.now(), message });
    } else if (channel === 'executed-orders') {
      const order = JSON.parse(message);
      io.emit('order-executed', order);
      console.log('✓ Orden ejecutada:', order.id, '| Ganancia:', `$${order.net_profit}`);
    } else if (channel === 'performance-metrics') {
      const metrics = JSON.parse(message);
      lastMetrics = metrics;
      io.emit('metrics-update', metrics);
    }
  } catch (e) {
    console.error('Error manejando mensaje Redis:', e.message, 'Canal:', channel);
  }
});