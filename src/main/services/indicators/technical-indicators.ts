import { EMA, MACD, RSI, ATR, BollingerBands } from 'technicalindicators';
import Decimal from 'decimal.js';
import type { CandleData, IndicatorData } from '../../../renderer/types/trading.js';

export class TechnicalIndicators {
  static calculateEMA(values: number[], period: number): number[] {
    const ema = new EMA({ period, values });
    return ema.getResult();
  }

  static calculateMACD(
    values: number[],
    fastPeriod: number = 12,
    slowPeriod: number = 26,
    signalPeriod: number = 9
  ): { macd: number[]; signal: number[]; histogram: number[] } {
    const macd = new MACD({ 
      values, 
      fastPeriod, 
      slowPeriod, 
      signalPeriod, 
      SimpleMAOscillator: false, 
      SimpleMASignal: false 
    });
    const result = macd.getResult();
    return {
      macd: result.map((r: any) => r.MACD),
      signal: result.map((r: any) => r.signal),
      histogram: result.map((r: any) => r.histogram),
    };
  }

  static calculateRSI(values: number[], period: number = 14): number[] {
    const rsi = new RSI({ period, values });
    return rsi.getResult();
  }

  static calculateATR(
    high: number[],
    low: number[],
    close: number[],
    period: number = 14
  ): number[] {
    const atr = new ATR({ period, high, low, close });
    return atr.getResult();
  }

  static calculateBollingerBands(
    values: number[],
    period: number = 20,
    stdDev: number = 2
  ): { upper: number[]; middle: number[]; lower: number[] } {
    const bb = new BollingerBands({ period, values, stdDev });
    const result = bb.getResult();
    return {
      upper: result.map((r: any) => r.upper),
      middle: result.map((r: any) => r.middle),
      lower: result.map((r: any) => r.lower),
    };
  }

  static calculateVWAP(candles: CandleData[]): number {
    let cumulativeVolume = new Decimal(0);
    let cumulativeVolumePrice = new Decimal(0);

    for (const candle of candles) {
      const typicalPrice = new Decimal(candle.high)
        .plus(candle.low)
        .plus(candle.close)
        .dividedBy(3);
      const volume = new Decimal(candle.volume);
      
      cumulativeVolumePrice = cumulativeVolumePrice.plus(typicalPrice.times(volume));
      cumulativeVolume = cumulativeVolume.plus(volume);
    }

    if (cumulativeVolume.isZero()) return 0;
    return cumulativeVolumePrice.dividedBy(cumulativeVolume).toNumber();
  }

  static calculateAllIndicators(candles: CandleData[]): IndicatorData {
    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const volumes = candles.map(c => c.volume);

    const emaFast = this.calculateEMA(closes, 9);
    const emaSlow = this.calculateEMA(closes, 21);
    const macd = this.calculateMACD(closes);
    const rsi = this.calculateRSI(closes);
    const atr = this.calculateATR(highs, lows, closes);
    const bollinger = this.calculateBollingerBands(closes);
    const vwap = this.calculateVWAP(candles);

    return {
      rsi: rsi[rsi.length - 1] || 50,
      macd: {
        macd: macd.macd[macd.macd.length - 1] || 0,
        signal: macd.signal[macd.signal.length - 1] || 0,
        histogram: macd.histogram[macd.histogram.length - 1] || 0,
      },
      ema: {
        fast: emaFast[emaFast.length - 1] || 0,
        slow: emaSlow[emaSlow.length - 1] || 0,
      },
      atr: atr[atr.length - 1] || 0,
      bollinger: {
        upper: bollinger.upper[bollinger.upper.length - 1] || 0,
        middle: bollinger.middle[bollinger.middle.length - 1] || 0,
        lower: bollinger.lower[bollinger.lower.length - 1] || 0,
      },
      volume: volumes[volumes.length - 1] || 0,
      vwap,
    };
  }

  static detectEMACross(emaFast: number[], emaSlow: number[]): 'BULLISH' | 'BEARISH' | 'NONE' {
    if (emaFast.length < 2 || emaSlow.length < 2) return 'NONE';
    
    const prevFast = emaFast[emaFast.length - 2];
    const prevSlow = emaSlow[emaSlow.length - 2];
    const currFast = emaFast[emaFast.length - 1];
    const currSlow = emaSlow[emaSlow.length - 1];

    if (prevFast <= prevSlow && currFast > currSlow) return 'BULLISH';
    if (prevFast >= prevSlow && currFast < currSlow) return 'BEARISH';
    return 'NONE';
  }

  static detectMACDCross(macd: number[], signal: number[]): 'BULLISH' | 'BEARISH' | 'NONE' {
    if (macd.length < 2 || signal.length < 2) return 'NONE';
    
    const prevMACD = macd[macd.length - 2];
    const prevSignal = signal[signal.length - 2];
    const currMACD = macd[macd.length - 1];
    const currSignal = signal[signal.length - 1];

    if (prevMACD <= prevSignal && currMACD > currSignal) return 'BULLISH';
    if (prevMACD >= prevSignal && currMACD < currSignal) return 'BEARISH';
    return 'NONE';
  }

  static detectRSISignal(rsi: number[], oversold: number = 30, overbought: number = 70): 'BULLISH' | 'BEARISH' | 'NONE' {
    if (rsi.length < 1) return 'NONE';
    
    const currentRSI = rsi[rsi.length - 1];
    if (currentRSI <= oversold) return 'BULLISH';
    if (currentRSI >= overbought) return 'BEARISH';
    return 'NONE';
  }

  static detectBollingerSqueeze(
    upper: number[],
    lower: number[],
    middle: number[],
    threshold: number = 0.05
  ): boolean {
    if (upper.length < 1 || lower.length < 1 || middle.length < 1) return false;
    
    const bandwidth = (upper[upper.length - 1] - lower[lower.length - 1]) / middle[middle.length - 1];
    return bandwidth < threshold;
  }
}