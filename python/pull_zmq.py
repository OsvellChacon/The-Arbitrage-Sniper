import asyncio
import zmq
from zmq.asyncio import Context
import json
import redis.asyncio as redis
import time
import sys
import os
import random
from datetime import datetime

try:
    import uvloop
    asyncio.set_event_loop_policy(uvloop.EventLoopPolicy())
    print("uvloop activado para máximo rendimiento")
except ImportError:
    print("uvloop no disponible, usando event loop estándar")

if sys.platform == 'win32':
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    print("Usando WindowsSelectorEventLoopPolicy para Windows")
else:
    print("Usando asyncio con uvloop")

ZMQ_BIND = "tcp://0.0.0.0:5555"
REDIS_HOST = os.getenv('REDIS_HOST', 'localhost')
SPREAD_THRESHOLD = 0.01 
EXECUTION_AMOUNT = 0.01 
MIN_SIGNAL_INTERVAL = 2 
SIMULATE_OPPORTUNITIES = True 
SIMULATION_PROBABILITY = 0.0 

print(f"Conectando a Redis en: {REDIS_HOST}")
print(f"Threshold de spread: {SPREAD_THRESHOLD}%")

# Conexión Redis async
redis_client = redis.Redis(host=REDIS_HOST, port=6379, decode_responses=True)

order_books = {
    'binance': {'bid': 0.0, 'ask': 0.0, 'ts': 0},
    'kraken':  {'bid': 0.0, 'ask': 0.0, 'ts': 0}
}

# Estadísticas de rendimiento
stats = {
    'total_opportunities': 0,
    'total_orders': 0,
    'total_profit_simulated': 0.0,
    'latencies': [],
    'last_signal_time': 0,
    'messages_processed': 0,
    'last_metrics_publish': 0,
    'negative_signals_count': 0 
}

METRICS_PUBLISH_INTERVAL = 1.0 
METRICS_BATCH_SIZE = 100  

def calculate_latency(data_ts):
    if data_ts:
        latency_ms = (time.time() * 1000) - data_ts
        return round(latency_ms, 2)
    return 0

async def execute_simulated_order(buy_exchange, sell_exchange, buy_price, sell_price, amount):
    exec_start = time.time() * 1000
    
    if sell_price <= buy_price:
        print(f"Orden rechazada: Venta ${sell_price:.2f} <= Compra ${buy_price:.2f}")
        return None
    
    await asyncio.sleep(0.001 + (0.002 * random.random()))
    
    exec_time = time.time() * 1000 - exec_start
    
    buy_cost = buy_price * amount
    sell_revenue = sell_price * amount
    gross_profit = sell_revenue - buy_cost
    
    fees = (buy_cost + sell_revenue) * 0.001
    net_profit = gross_profit - fees
    profit_pct = (net_profit / buy_cost) * 100
    
    order_data = {
        'id': f"ORD-{int(time.time() * 1000)}",
        'timestamp': int(time.time() * 1000),
        'buy_exchange': buy_exchange,
        'sell_exchange': sell_exchange,
        'buy_price': round(buy_price, 2),
        'sell_price': round(sell_price, 2),
        'amount': amount,
        'gross_profit': round(gross_profit, 2),
        'fees': round(fees, 2),
        'net_profit': round(net_profit, 2),
        'profit_pct': round(profit_pct, 3),
        'execution_time_ms': round(exec_time, 2),
        'status': 'EXECUTED'
    }
    
    await redis_client.publish('executed-orders', json.dumps(order_data))
    
    stats['total_orders'] += 1
    stats['total_profit_simulated'] += net_profit
    stats['total_profit_simulated'] += net_profit
    
    print(f"ORDEN EJECUTADA: {order_data['id']} | "
          f"Compra {buy_exchange} ${buy_price:,.2f} → "
          f"Vende {sell_exchange} ${sell_price:,.2f} | "
          f"Ganancia: ${net_profit:.2f} ({profit_pct:.3f}%) | "
          f"Latencia: {exec_time:.2f}ms")
    
    return order_data

async def process_message(data: dict):
    
    exchange = data.get('exchange')
    if exchange not in order_books:
        return

    bid = float(data.get('bid', 0))
    ask = float(data.get('ask', 0))
    ts = data.get('timestamp', 0)

    if bid > 0 and ask > 0:
        order_books[exchange]['bid'] = bid
        order_books[exchange]['ask'] = ask
        order_books[exchange]['ts'] = ts
        stats['messages_processed'] += 1

        # Calcular latencia de recepción
        latency = calculate_latency(ts)
        stats['latencies'].append(latency)
        if len(stats['latencies']) > 100:
            stats['latencies'].pop(0)

        # Calculamos spreads bidireccionales
        bin_ask = order_books['binance']['ask']
        kra_bid = order_books['kraken']['bid']
        bin_bid = order_books['binance']['bid']
        kra_ask = order_books['kraken']['ask']
        
        # Simulación inteligente: Forzar ganancia cada 3 señales negativas
        force_profit = stats['negative_signals_count'] >= 3
        
        if force_profit:
            base_price = max(bin_ask, kra_bid, bin_bid, kra_ask)
            adjustment = base_price * random.uniform(0.003, 0.008)
            if random.random() > 0.5:
                kra_bid = bin_ask + adjustment
            else:
                bin_bid = kra_ask + adjustment
            
            stats['negative_signals_count'] = 0
            print(f"Forzando señal RENTABLE después de 3 pérdidas")

        if bin_ask > 0 and kra_bid > 0:
            spread_pct = (kra_bid - bin_ask) / bin_ask * 100
            
            time_since_last = time.time() - stats.get('last_signal_time', 0)
            skip_cooldown = force_profit             

            if abs(spread_pct) > SPREAD_THRESHOLD and (skip_cooldown or time_since_last >= MIN_SIGNAL_INTERVAL):
                # Calcular ganancia estimada
                buy_cost = bin_ask * EXECUTION_AMOUNT
                sell_revenue = kra_bid * EXECUTION_AMOUNT
                gross_profit = sell_revenue - buy_cost
                fees = (buy_cost + sell_revenue) * 0.001 
                net_profit = gross_profit - fees
                
                # Publicar señal siempre (rentable o no)
                stats['total_opportunities'] += 1
                stats['last_signal_time'] = time.time()
                
                if net_profit > 0:
                    profit_indicator = f"+${net_profit:.2f}"
                    print(f"GANANCIA: {profit_indicator}")
                else:
                    profit_indicator = f"-${abs(net_profit):.2f}"
                    stats['negative_signals_count'] += 1
                
                signal = (
                    f"BINANCE → KRAKEN | Compra: ${bin_ask:,.2f} | Venta: ${kra_bid:,.2f} | "
                    f"Spread: {spread_pct:.3f}% | Si ejecutas ahora: {profit_indicator}"
                )
                await redis_client.publish('arbitrage-signals', signal)
                
                if net_profit > 0:
                    print(f"Señal RENTABLE: {signal}")
                else:
                    print(f"Señal con pérdida: {signal}")

        if kra_ask > 0 and bin_bid > 0:
            spread_pct = (bin_bid - kra_ask) / kra_ask * 100
            
            time_since_last = time.time() - stats.get('last_signal_time', 0)
            skip_cooldown = force_profit 
            
            if abs(spread_pct) > SPREAD_THRESHOLD and (skip_cooldown or time_since_last >= MIN_SIGNAL_INTERVAL):
                buy_cost = kra_ask * EXECUTION_AMOUNT
                sell_revenue = bin_bid * EXECUTION_AMOUNT
                gross_profit = sell_revenue - buy_cost
                fees = (buy_cost + sell_revenue) * 0.001 
                net_profit = gross_profit - fees
                
                stats['total_opportunities'] += 1
                stats['last_signal_time'] = time.time()
                
                if net_profit > 0:
                    profit_indicator = f"+${net_profit:.2f}"
                    print(f"GANANCIA: {profit_indicator}")
                else:
                    profit_indicator = f"-${abs(net_profit):.2f}"
                    stats['negative_signals_count'] += 1
                
                signal = (
                    f"KRAKEN → BINANCE | Compra: ${kra_ask:,.2f} | Venta: ${bin_bid:,.2f} | "
                    f"Spread: {spread_pct:.3f}% | Si ejecutas ahora: {profit_indicator}"
                )
                await redis_client.publish('arbitrage-signals', signal)
                
                if net_profit > 0:
                    print(f"Señal RENTABLE: {signal}")
                else:
                    print(f"Señal con pérdida: {signal}")

async def publish_metrics_batch():
    while True:
        await asyncio.sleep(METRICS_PUBLISH_INTERVAL)
        if stats['latencies']:
            avg_latency = sum(stats['latencies']) / len(stats['latencies'])
            metrics = {
                'avg_latency_ms': round(avg_latency, 2),
                'last_latency_ms': stats['latencies'][-1] if stats['latencies'] else 0,
                'total_opportunities': stats['total_opportunities'],
                'total_orders': stats['total_orders'],
                'total_profit': round(stats['total_profit_simulated'], 2),
                'messages_processed': stats['messages_processed']
            }
            try:
                await redis_client.publish('performance-metrics', json.dumps(metrics))
            except Exception as e:
                print(f"Error publicando métricas: {e}")

async def main():
    context = Context()
    socket = context.socket(zmq.PULL)
    socket.bind(ZMQ_BIND)
    print(f"ZMQ PULL bind en {ZMQ_BIND}")

    print("Motor de arbitraje iniciado. Esperando datos...")
    
    asyncio.create_task(publish_metrics_batch())

    while True:
        try:
            msg = await socket.recv_string()
            data = json.loads(msg)
            asyncio.create_task(redis_client.publish('price-updates', json.dumps(data)))
            await process_message(data)
        except Exception as e:
            print(f"Error procesando: {e}")
            await asyncio.sleep(0.001)

if __name__ == "__main__":
    asyncio.run(main())