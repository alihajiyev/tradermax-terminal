import { TechnicalIndicators } from '../indicators/technical-indicators.js';
import type {
  CandleData,
  IndicatorData,
  StrategyVotePart,
  TradingConfig,
} from '../../../renderer/types/trading.js';

export interface VoteResult {
  bullVotes: number;
  bearVotes: number;
  parts: StrategyVotePart[];
  reasons: string[];
}

/**
 * Pure strategy voting (node-tested implicitly via engine + backtest).
 * Shared by the live engine and the backtester — single source of truth.
 */
export function computeVotes(
  strategies: TradingConfig['strategies'],
  price: number,
  candles: CandleData[],
  ind: IndicatorData
): VoteResult {
  const closes = candles.map((c) => c.close);

  const emaFastArr = TechnicalIndicators.calculateEMA(closes, 9);
  const emaSlowArr = TechnicalIndicators.calculateEMA(closes, 21);
  const macdRes = TechnicalIndicators.calculateMACD(closes);
  const rsiArr = TechnicalIndicators.calculateRSI(closes);

  let bullVotes = 0;
  let bearVotes = 0;
  const reasons: string[] = [];
  const parts: StrategyVotePart[] = [];
  const s = strategies;

  if (s.emaCross) {
    const cross = TechnicalIndicators.detectEMACross(emaFastArr, emaSlowArr);
    if (cross === 'BULLISH') { bullVotes++; reasons.push('EMA9/21 bullish cross'); parts.push({ key: 'ema', label: 'EMA 9/21', bull: 1, bear: 0, note: 'Taze boğa kesişimi' }); }
    else if (cross === 'BEARISH') { bearVotes++; reasons.push('EMA9/21 bearish cross'); parts.push({ key: 'ema', label: 'EMA 9/21', bull: 0, bear: 1, note: 'Taze ayı kesişimi' }); }
    else if (ind.ema.fast > ind.ema.slow) { bullVotes += 0.5; reasons.push('EMA9>EMA21'); parts.push({ key: 'ema', label: 'EMA 9/21', bull: 0.5, bear: 0, note: 'EMA9 EMA21 üstünde (eğim boğa)' }); }
    else { bearVotes += 0.5; reasons.push('EMA9<EMA21'); parts.push({ key: 'ema', label: 'EMA 9/21', bull: 0, bear: 0.5, note: 'EMA9 EMA21 altında (eğim ayı)' }); }
  } else {
    parts.push({ key: 'ema', label: 'EMA 9/21', bull: 0, bear: 0, note: 'Kapalı' });
  }
  if (s.macd) {
    const cross = TechnicalIndicators.detectMACDCross(macdRes.macd, macdRes.signal);
    if (cross === 'BULLISH') { bullVotes++; reasons.push('MACD bullish cross'); parts.push({ key: 'macd', label: 'MACD', bull: 1, bear: 0, note: 'Taze boğa kesişimi' }); }
    else if (cross === 'BEARISH') { bearVotes++; reasons.push('MACD bearish cross'); parts.push({ key: 'macd', label: 'MACD', bull: 0, bear: 1, note: 'Taze ayı kesişimi' }); }
    else if (ind.macd.histogram > 0) { bullVotes += 0.5; reasons.push('MACD hist+'); parts.push({ key: 'macd', label: 'MACD', bull: 0.5, bear: 0, note: 'Histogram pozitif' }); }
    else { bearVotes += 0.5; reasons.push('MACD hist-'); parts.push({ key: 'macd', label: 'MACD', bull: 0, bear: 0.5, note: 'Histogram negatif' }); }
  } else {
    parts.push({ key: 'macd', label: 'MACD', bull: 0, bear: 0, note: 'Kapalı' });
  }
  if (s.rsi) {
    const rsiSig = TechnicalIndicators.detectRSISignal(rsiArr);
    if (rsiSig === 'BULLISH') { bullVotes++; reasons.push(`RSI oversold (${ind.rsi.toFixed(1)})`); parts.push({ key: 'rsi', label: 'RSI (14)', bull: 1, bear: 0, note: `Aşırı satım (${ind.rsi.toFixed(1)})` }); }
    else if (rsiSig === 'BEARISH') { bearVotes++; reasons.push(`RSI overbought (${ind.rsi.toFixed(1)})`); parts.push({ key: 'rsi', label: 'RSI (14)', bull: 0, bear: 1, note: `Aşırı alım (${ind.rsi.toFixed(1)})` }); }
    else if (ind.rsi > 50 && ind.rsi < 70) { bullVotes += 0.25; parts.push({ key: 'rsi', label: 'RSI (14)', bull: 0.25, bear: 0, note: `Boğa momentum (${ind.rsi.toFixed(1)})` }); }
    else if (ind.rsi < 50 && ind.rsi > 30) { bearVotes += 0.25; parts.push({ key: 'rsi', label: 'RSI (14)', bull: 0, bear: 0.25, note: `Ayı momentum (${ind.rsi.toFixed(1)})` }); }
    else { parts.push({ key: 'rsi', label: 'RSI (14)', bull: 0, bear: 0, note: `Nötr (${ind.rsi.toFixed(1)})` }); }
  } else {
    parts.push({ key: 'rsi', label: 'RSI (14)', bull: 0, bear: 0, note: 'Kapalı' });
  }
  if (s.bollinger) {
    if (price <= ind.bollinger.lower) { bullVotes++; reasons.push('Price at lower BB'); parts.push({ key: 'bb', label: 'Bollinger', bull: 1, bear: 0, note: 'Fiyat alt bantta' }); }
    else if (price >= ind.bollinger.upper) { bearVotes++; reasons.push('Price at upper BB'); parts.push({ key: 'bb', label: 'Bollinger', bull: 0, bear: 1, note: 'Fiyat üst bantta' }); }
    else { parts.push({ key: 'bb', label: 'Bollinger', bull: 0, bear: 0, note: 'Bant içinde' }); }
  } else {
    parts.push({ key: 'bb', label: 'Bollinger', bull: 0, bear: 0, note: 'Kapalı' });
  }

  return { bullVotes, bearVotes, parts, reasons };
}
