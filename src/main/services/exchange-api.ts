import axios, { AxiosInstance } from 'axios';
import CryptoJS from 'crypto-js';
import type { APICredentials } from '../../renderer/types/trading.js';

interface ExchangeConfig {
  baseURL: string;
  wsURL: string;
  testnet: boolean;
}

const EXCHANGE_CONFIGS: Record<string, ExchangeConfig> = {
  binance: {
    baseURL: 'https://testnet.binance.vision',
    wsURL: 'wss://testnet.binance.vision/ws',
    testnet: true,
  },
  bybit: {
    baseURL: 'https://api-testnet.bybit.com',
    wsURL: 'wss://stream-testnet.bybit.com/v5/public/linear',
    testnet: true,
  },
};

export class ExchangeAPI {
  private client: AxiosInstance;
  private credentials: APICredentials;
  private exchange: 'binance' | 'bybit';
  private config: ExchangeConfig;

  constructor(credentials: APICredentials) {
    this.credentials = credentials;
    this.exchange = credentials.exchange;
    this.config = EXCHANGE_CONFIGS[this.exchange];
    
    this.client = axios.create({
      baseURL: this.config.baseURL,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'X-MBX-APIKEY': credentials.apiKey,
      },
    });

    this.client.interceptors.request.use((config) => {
      if (config.method === 'post' || config.method === 'put' || config.method === 'delete') {
        const timestamp = Date.now();
        const queryString = new URLSearchParams(config.data as Record<string, string>).toString();
        const signature = this.generateSignature(`${queryString}&timestamp=${timestamp}`);
        config.params = { ...config.params, timestamp, signature };
      }
      return config;
    });
  }

  private generateSignature(queryString: string): string {
    return CryptoJS.HmacSHA256(queryString, this.credentials.apiSecret).toString(CryptoJS.enc.Hex);
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      if (this.exchange === 'binance') {
        await this.client.get('/api/v3/account');
      } else {
        await this.client.get('/v5/account/wallet-balance', { params: { accountType: 'UNIFIED' } });
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
    if (this.exchange === 'binance') {
      const response = await this.client.get('/api/v3/account');
      return response.data;
    } else {
      const response = await this.client.get('/v5/account/wallet-balance', { 
        params: { accountType: 'UNIFIED' } 
      });
      return response.data;
    }
  }

  async getTicker(symbol: string): Promise<any> {
    if (this.exchange === 'binance') {
      const response = await this.client.get('/api/v3/ticker/24hr', { params: { symbol } });
      return response.data;
    } else {
      const response = await this.client.get('/v5/market/tickers', { 
        params: { category: 'linear', symbol } 
      });
      return response.data.result.list[0];
    }
  }

  async getOrderBook(symbol: string, limit: number = 100): Promise<{ bids: [number, number][]; asks: [number, number][] }> {
    if (this.exchange === 'binance') {
      const response = await this.client.get('/api/v3/depth', { params: { symbol, limit } });
      return {
        bids: response.data.bids.map((b: string[]) => [parseFloat(b[0]), parseFloat(b[1])]),
        asks: response.data.asks.map((a: string[]) => [parseFloat(a[0]), parseFloat(a[1])]),
      };
    } else {
      const response = await this.client.get('/v5/market/orderbook', { 
        params: { category: 'linear', symbol, limit } 
      });
      return {
        bids: response.data.result.b.map((b: string[]) => [parseFloat(b[0]), parseFloat(b[1])]),
        asks: response.data.result.a.map((a: string[]) => [parseFloat(a[0]), parseFloat(a[1])]),
      };
    }
  }

  async getKlines(symbol: string, interval: string, limit: number = 500): Promise<any[]> {
    if (this.exchange === 'binance') {
      const response = await this.client.get('/api/v3/klines', { 
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
    } else {
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
  }

  async getRecentTrades(symbol: string, limit: number = 100): Promise<Array<{ price: number; quantity: number; time: number; side: 'buy' | 'sell' }>> {
    if (this.exchange === 'binance') {
      const response = await this.client.get('/api/v3/trades', { params: { symbol, limit } });
      return response.data.map((t: any) => ({
        price: parseFloat(t.price),
        quantity: parseFloat(t.qty),
        time: t.time,
        side: t.isBuyerMaker ? 'sell' : 'buy',
      }));
    } else {
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
  }

  async placeOrder(order: {
    symbol: string;
    side: 'BUY' | 'SELL';
    type: 'MARKET' | 'LIMIT';
    quantity: number;
    price?: number;
    stopPrice?: number;
    timeInForce?: 'GTC' | 'IOC' | 'FOK';
  }): Promise<any> {
    if (this.exchange === 'binance') {
      const params: any = {
        symbol: order.symbol,
        side: order.side,
        type: order.type,
        quantity: order.quantity,
      };
      if (order.price) params.price = order.price;
      if (order.stopPrice) params.stopPrice = order.stopPrice;
      if (order.timeInForce) params.timeInForce = order.timeInForce;

      const response = await this.client.post('/api/v3/order', params);
      return response.data;
    } else {
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
  }

  async cancelOrder(symbol: string, orderId: string): Promise<any> {
    if (this.exchange === 'binance') {
      const response = await this.client.delete('/api/v3/order', { 
        params: { symbol, orderId } 
      });
      return response.data;
    } else {
      const response = await this.client.post('/v5/order/cancel', {
        category: 'linear',
        symbol,
        orderId,
      });
      return response.data.result;
    }
  }

  async getOpenOrders(symbol?: string): Promise<any[]> {
    if (this.exchange === 'binance') {
      const response = await this.client.get('/api/v3/openOrders', { 
        params: symbol ? { symbol } : {} 
      });
      return response.data;
    } else {
      const response = await this.client.get('/v5/order/realtime', { 
        params: { category: 'linear', symbol } 
      });
      return response.data.result.list;
    }
  }

  getWebSocketURL(): string {
    return this.config.wsURL;
  }
}