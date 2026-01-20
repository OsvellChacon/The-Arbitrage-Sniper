# The Arbitrage Sniper - Prueba Tecnica Oberstaff

Motor de arbitraje de alta frecuencia simulado para BTC/USDT entre dos exchanges (Binance + Kraken). Detecta diferencias de precio en tiempo real (<5 ms latencia interna) y genera señales simuladas de "COMPRA / VENDE".

**Objetivo de la prueba técnica**:  
Crear un sistema híbrido que detecte arbitraje de Bitcoin entre dos exchanges en tiempo real (<5 ms latencia interna) y simule órdenes de ejecución.  
Tiempo estimado: 48 horas (modo Hackathon).

## Arquitectura (El Reto)

No se usa HTTP entre servicios. Comunicación ultra-baja latencia vía **ZeroMQ** (PUSH/PULL).

1. **Node.js (The Ingestor / Gateway)**  
   - Conexión vía WebSockets reales a Binance y Kraken (par BTC/USDT).  
   - Normaliza datos "on the fly" (bid/ask/qty/timestamp).  
   - Envía datos normalizados al motor Python vía ZeroMQ PUSH.  
   - Expone WebSocket (Socket.io) para dashboard frontend simple con precios en vivo, spread, señales y gráfico.

2. **Python (The Quant Engine)**  
   - Escucha datos vía ZeroMQ PULL.  
   - Mantiene order book simplificado en memoria.  
   - Calcula spread en tiempo real (bidireccional).  
   - Si spread > 0.5%, dispara señal simulada "COMPRA A / VENDE B".  
   - Escribe señal en Redis (set 'last_signal') y publica en canal 'arbitrage-signals' (pub/sub) para notificar a Node.js y actualizar dashboard.

## Requisitos Técnicos Cumplidos

- **Python Performance**: asyncio con WindowsSelectorEventLoopPolicy (compatible Windows; uvloop no disponible en Windows). Script puro sin frameworks pesados.  
- **Node.js Performance**: No bloqueante, reconexión automática de WebSockets.  
- **Dockerizado**: Todo se levanta con `docker-compose up --build`.  
- **No DB tradicional**: Todo en memoria (order book) + Redis (caché/persistencia volátil).  
- **Datos**: Reales de Binance/Kraken + simulación para forzar spreads en demo.  

## Tecnologías

- Node.js + ws + zeromq + socket.io + ioredis  
- Python + pyzmq + redis.asyncio + asyncio  
- ZeroMQ (PUSH/PULL)  
- Redis (pub/sub + set)  
- Docker + Docker Compose  
- Dashboard: HTML/CSS/JS + Socket.io + Chart.js (CDN)  

## Instalación y Ejecución

### Requisitos
- Docker + Docker Compose  
- Git (para clonar)

### Levantar todo (recomendado)
```bash
git clone https://github.com/OsvellChacon/the-arbitrage-sniper.git
cd the-arbitrage-sniper
docker-compose up --build

Accede al dashboard:
http://localhost:3000
Ejecución local (desarrollo)

Redis (en Docker o local):Bashdocker run -d -p 6379:6379 redis
Node.js (/node):Bashcd node
npm install
node src/index.js
Python (/python):Bashcd python
python -m venv .venv
.venv\Scripts\activate  # Windows
pip install -r requirements.txt
python pull_zmq.py

Demo

Video demostración (3-5 min): https://www.loom.com/share/b131f7bccbb94376a3cb23c561abd048
Muestra: docker-compose up, dashboard en vivo (precios, spread, gráfico), simulación de spread >0.5% para señal, logs de latencia interna.

Latencia Interna
Medida con perf_counter (Python) desde recepción ZMQ hasta cálculo de spread:
<5 ms en ejecución local (promedio ~1-3 ms).
Ejemplo log: "Latencia interna: 2.45 ms".
(Externa a exchanges depende de red, pero no afecta el core; simulación para demo).
Notas Finales

Listo para entrega: Repo + video enviados a hector@oberstaff.com y natacha@oberstaff.com.

¡Gracias por la oportunidad!
Osvell – Venezuela, CA
Enero 2026