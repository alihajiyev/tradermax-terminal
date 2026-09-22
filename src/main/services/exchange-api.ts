import axios, { AxiosInstance } from 'axios';
import CryptoJS from 'crypto-js';
import type { APICredentials } from '../../renderer/types/trading.js';

interface ExchangeConfig {
  baseURL: string;
  wsURL: string;
  testnet: boolean;
}

function binanceConfig(futures: boolean): ExchangeConfig {
  return futures
    ? {
        baseURL: 'https://testnet.binancefuture.com',
        wsURL: 'wss://stream.testnet.binancefuture.com/ws',
        testnet: true,
      }
    : {
        baseURL: 'https://testnet.binance.vision',
        wsURL: 'wss://stream.testnet.binance.vision/ws',
        testnet: true,
      };
}

const BYBIT_CONFIG: ExchangeConfig = {
  baseURL: 'https://api-testnet.bybit.com',
  wsURL: 'wss://stream-testnet.bybit.com/v5/public/linear',
  testnet: true,
};

export type OrderType =
  | 'MARKET'
  | 'LIMIT'
  | 'STOP_LOSS_LIMIT'
  | 'TAKE_PROFIT_LIMIT'
  | 'STOP_MARKET'
  | 'TAKE_PROFIT_MARKET';

export class ExchangeAPI {
  private client: AxiosInstance;
  private credentials: APICredentials;
  private exchange: 'binance' | 'bybit';
  private futures: boolean;
  private config: ExchangeConfig;

  constructor(credentials: APICredentials, opts?: { futures?: boolean }) {
    this.credentials = credentials;
    this.exchange = credentials.exchange;
    this.futures = opts?.futures ?? false;
    this.config = this.exchange === 'bybit' ? BYBIT_CONFIG : binanceConfig(this.futures);

    this.client = axios.create({
      baseURL: this.config.baseURL,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'X-MBX-APIKEY': credentials.apiKey,
      },
    });

    // Binance auth: SIGNED endpoints need timestamp+signature in the QUERY STRING.
    // - GET/DELETE → sign merged params
    // - POST → Binance does NOT accept JSON bodies; everything goes to query string
    // Public market-data paths are never signed.
    const PUBLIC_PATHS = [
      '/ticker/', '/depth', '/klines', '/trades', '/exchangeInfo',
      '/ping', '/time', '/avgPrice', '/v5/market/',
    ];
    this.client.interceptors.request.use((config) => {
      if (this.exchange === 'bybit') {
        // Legacy path (unchanged)
        if (config.method === 'post' || config.method === 'put' || config.method === 'delete') {
          const timestamp = Date.now();
          const queryString = new URLSearchParams(config.data as Record<string, string>).toString();
          const signature = this.generateSignature(`${queryString}&timestamp=${timestamp}`);
          config.params = { ...config.params, timestamp, signature };
        }
        return config;
      }
      const url = config.url || '';
      if (PUBLIC_PATHS.some((p) => url.includes(p))) return config;

      const timestamp = Date.now();
      if (config.method === 'get' || config.method === 'delete') {
        const params: Record<string, string> = { ...(config.params || {}), timestamp: String(timestamp) };
        const qs = new URLSearchParams(params).toString();
        config.params = { ...params, signature: this.generateSignature(qs) };
        return config;
      }
      // POST/PUT: flatten body into the query string (Binance-compatible)
      const body = { ...((config.data as Record<string, unknown>) || {}) } as Record<string, unknown>;
      const flat: Record<string, string> = { timestamp: String(timestamp) };
      for (const [k, v] of Object.entries(body)) {
        if (v !== undefined && v !== null) flat[k] = String(v);
      }
      const qs = new URLSearchParams(flat).toString();
      config.params = { ...(config.params || {}), ...flat, signature: this.generateSignature(qs) };
      config.data = undefined;
      return config;
    });
  }

  isFutures(): boolean {
    return this.futures && this.exchange === 'binance';
  }

  private api(path: string): string {
    if (this.exchange === 'bybit') throw new Error('internal: bybit has its own paths');
    return `${this.futures ? '/fapi/v1' : '/api/v3'}${path}`;
  }

  private generateSignature(queryString: string): string {
    return CryptoJS.HmacSHA256(queryString, this.credentials.apiSecret).toString(CryptoJS.enc.Hex);
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      if (this.exchange === 'bybit') {
        await this.client.get('/v5/account/wallet-balance', { params: { accountType: 'UNIFIED' } });
      } else if (this.futures) {
        await this.client.get('/fapi/v2/account');
      } else {
        await this.client.get('/api/v3/account');
      }
      return { success: true, message: 'Connection successful' };
    } catch (error: any) {
      return {
        success: false,
        message: error.response?.data?.msg || error.message || 'Connection failed'
      };
    }
  }

  async getAccountInfo(): Promise<any> {
    if (this.exchange === 'bybit') {
      const response = await this.client.get('/v5/account/wallet-balance', {
        params: { accountType: 'UNIFIED' }
      });
      return response.data;
    }
    const response = await this.client.get(this.futures ? '/fapi/v2/account' : '/api/v3/account');
    return response.data;
  }

  async getTicker(symbol: string): Promise<any> {
    if (this.exchange === 'bybit') {
      const response = await this.client.get('/v5/market/tickers', {
        params: { category: 'linear', symbol }
      });
      return response.data.result.list[0];
    }
    const response = await this.client.get(this.api('/ticker/24hr'), { params: { symbol } });
    return response.data;
  }

  async getOrderBook(symbol: string, limit: number = 100): Promise<{ bids: [number, number][]; asks: [number, number][] }> {
    if (this.exchange === 'bybit') {
      const response = await this.client.get('/v5/market/orderbook', {
        params: { category: 'linear', symbol, limit }
      });
      return {
        bids: response.data.result.b.map((b: string[]) => [parseFloat(b[0]), parseFloat(b[1])]),
        asks: response.data.result.a.map((a: string[]) => [parseFloat(a[0]), parseFloat(a[1])]),
      };
    }
    const response = await this.client.get(this.api('/depth'), { params: { symbol, limit } });
    return {
      bids: response.data.bids.map((b: string[]) => [parseFloat(b[0]), parseFloat(b[1])]),
      asks: response.data.asks.map((a: string[]) => [parseFloat(a[0]), parseFloat(a[1])]),
    };
  }

  async getKlines(symbol: string, interval: string, limit: number = 500): Promise<any[]> {
    if (this.exchange === 'bybit') {
      const response = await this.client.get('/v5/market/kline', {
        params: { category: 'linear', symbol, interval, limit }
      });
      return response.data.result.list.map((k: string[]) => ({
        time: parseInt(k[0]),
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      })).reverse();
    }
    const response = await this.client.get(this.api('/klines'), {
      params: { symbol, interval, limit }
    });
    return response.data.map((k: any[]) => ({
      time: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
  }

  async getRecentTrades(symbol: string, limit: number = 100): Promise<Array<{ price: number; quantity: number; time: number; side: 'buy' | 'sell' }>> {
    if (this.exchange === 'bybit') {
      const response = await this.client.get('/v5/market/recent-trade', {
        params: { category: 'linear', symbol, limit }
      });
      return response.data.result.list.map((t: any) => ({
        price: parseFloat(t.price),
        quantity: parseFloat(t.size),
        time: parseInt(t.time),
        side: t.side.toLowerCase() as 'buy' | 'sell',
      }));
    }
    // /fapi/v1/trades has the same shape as /api/v3/trades
    const response = await this.client.get(this.api('/trades'), { params: { symbol, limit } });
    return response.data.map((t: any) => ({
      price: parseFloat(t.price),
      quantity: parseFloat(t.qty),
      time: t.time,
      side: t.isBuyerMaker ? 'sell' : 'buy',
    }));
  }

  async placeOrder(order: {
    symbol: string;
    side: 'BUY' | 'SELL';
    type: OrderType;
    quantity: number | string;
    price?: number | string;
    stopPrice?: number | string;
    timeInForce?: 'GTC' | 'IOC' | 'FOK';
    reduceOnly?: boolean;
  }): Promise<any> {
    if (this.exchange === 'bybit') {
      const response = await this.client.post('/v5/order/create', {
        category: 'linear',
        symbol: order.symbol,
        side: order.side,
        orderType: order.type,
        qty: order.quantity.toString(),
        price: order.price?.toString(),
        triggerPrice: order.stopPrice?.toString(),
        timeInForce: order.timeInForce || 'GTC',
      });
      return response.data.result;
    }
    const params: any = {
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      quantity: order.quantity,
    };
    if (order.price !== undefined) params.price = order.price;
    if (order.stopPrice !== undefined) params.stopPrice = order.stopPrice;
    if (order.timeInForce) params.timeInForce = order.timeInForce;
    if (order.reduceOnly !== undefined && this.futures) params.reduceOnly = order.reduceOnly;

    const response = await this.client.post(this.api('/order'), params);
    return response.data;
  }

  async cancelOrder(symbol: string, orderId: string): Promise<any> {
    if (this.exchange === 'bybit') {
      const response = await this.client.post('/v5/order/cancel', {
        category: 'linear',
        symbol,
        orderId,
      });
      return response.data.result;
    }
    const response = await this.client.delete(this.api('/order'), {
      params: { symbol, orderId }
    });
    return response.data;
  }

  async getOpenOrders(symbol?: string): Promise<any[]> {
    if (this.exchange === 'bybit') {
      const response = await this.client.get('/v5/order/realtime', {
        params: { category: 'linear', symbol }
      });
      return response.data.result.list;
    }
    const response = await this.client.get(this.api('/openOrders'), {
      params: symbol ? { symbol } : {}
    });
    return response.data;
  }

  /** Free/locked balances by asset (spot account / futures wallet). */
  async getBalances(): Promise<Record<string, { free: number; locked: number }>> {
    if (this.exchange === 'bybit') {
      const response = await this.client.get('/v5/account/wallet-balance', {
        params: { accountType: 'UNIFIED' },
      });
      const out: Record<string, { free: number; locked: number }> = {};
      const coins = response.data?.result?.list?.[0]?.coin ?? [];
      for (const c of coins) {
        out[c.coin] = {
          free: parseFloat(c.availableToWithdraw ?? c.walletBalance ?? 0),
          locked: parseFloat(c.locked ?? 0),
        };
      }
      return out;
    }
    if (this.futures) {
      const response = await this.client.get('/fapi/v2/account');
      const out: Record<string, { free: number; locked: number }> = {};
      for (const a of response.data.assets ?? []) {
        out[a.asset] = {
          free: parseFloat(a.availableBalance ?? a.walletBalance ?? 0),
          locked: 0,
        };
      }
      return out;
    }
    const response = await this.client.get('/api/v3/account');
    const out: Record<string, { free: number; locked: number }> = {};
    for (const b of response.data.balances ?? []) {
      out[b.asset] = { free: parseFloat(b.free), locked: parseFloat(b.locked) };
    }
    return out;
  }

  /** Set futures leverage (U_MARGINED). No-op on spot. */
  async setLeverage(symbol: string, leverage: number): Promise<void> {
    if (!this.isFutures()) return;
    await this.client.post('/fapi/v1/leverage', { symbol, leverage });
  }

  getWebSocketURL(): string {
    return this.config.wsURL;
  }

  getBaseURL(): string {
    return this.config.baseURL;
  }
}
