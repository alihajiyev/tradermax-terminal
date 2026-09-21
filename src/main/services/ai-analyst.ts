import { Logger } from '../utils/logger.js';
import type { IndicatorData } from '../../renderer/types/trading.js';

export interface AIVerdict {
  bias: 'LONG' | 'SHORT' | 'NEUTRAL';
  confidence: number; // 0..1
  reason: string;
  model: string;
  timestamp: number;
}

export interface AIInput {
  symbol: string;
  price: number;
  timeframe: string;
  indicators: IndicatorData;
  closes: number[];
  position?: { side: string; entryPrice: number; unrealizedPnL: number } | null;
  /** Preformatted structure/flow/sentiment block from the analyst layer. */
  context?: string;
}

const DEFAULT_TIMEOUT_MS = 20000;

/**
 * Gemini AI analyst — second opinion layer over the technical engine.
 * Stateless REST client (Google Generative Language API). All failures
 * return null so the technical engine always stays in charge.
 */
export class AIAnalyst {
  private logger: Logger;

  constructor() {
    this.logger = new Logger('AI');
  }

  async analyze(apiKey: string, model: string, input: AIInput, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<AIVerdict | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const closes = input.closes.slice(-30);
      const first = closes[0] ?? input.price;
      const drift = first !== 0 ? (((input.price - first) / first) * 100).toFixed(2) : '0.00';
      const pos = input.position
        ? `Open position: ${input.position.side} @ ${input.position.entryPrice} (uPnL ${input.position.unrealizedPnL.toFixed(2)} USDT)`
        : 'No open position on this symbol.';
      const ind = input.indicators;

      const prompt =
        `You are a professional crypto scalping analyst. Decide the bias for the NEXT 15-60 minutes.\n` +
        `Market: ${input.symbol} @ ${input.price} (${input.timeframe} candles, session drift ${drift}%)\n` +
        `RSI(14): ${ind.rsi.toFixed(1)} | MACD hist: ${ind.macd.histogram.toFixed(4)} | EMA9: ${ind.ema.fast.toFixed(2)} vs EMA21: ${ind.ema.slow.toFixed(2)} | ` +
        `ATR: ${ind.atr.toFixed(2)} | Bollinger: [${ind.bollinger.lower.toFixed(2)}, ${ind.bollinger.middle.toFixed(2)}, ${ind.bollinger.upper.toFixed(2)}]\n` +
        `${pos}\n` +
        (input.context ? `Ek bağlam (paranın yönü + duygu):\n${input.context}\n` : '') +
        `Kurallar: yapıya karşı işlem açma (direnç üstünde LONG, destek altında SHORT önerme); ` +
        `funding aşırı kalabalıksa (+%0.05 üstü long kalabalığı) aynı yönde güveni düşür; ` +
        `aşırı açgözlülükte (80+) LONG, aşırı korkuda (20-) SHORT için ek teyit iste.\n` +
        `Return ONLY compact JSON: {"bias":"LONG|SHORT|NEUTRAL","confidence":0.0-1.0,"reason":"max 15 words"}`;

      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 200, responseMimeType: 'application/json' },
          }),
          signal: controller.signal,
        }
      );
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`Gemini HTTP ${res.status}: ${txt.slice(0, 200)}`);
      }
      const data = (await res.json()) as any;
      const text: string =
        data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ?? '';
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('Gemini returned no JSON');
      const parsed = JSON.parse(match[0]) as { bias?: string; confidence?: number; reason?: string };
      const bias = parsed.bias === 'LONG' || parsed.bias === 'SHORT' ? parsed.bias : 'NEUTRAL';
      const confidence = Math.min(1, Math.max(0, Number(parsed.confidence) || 0));
      const reason = String(parsed.reason ?? '').slice(0, 140) || 'no reason given';
      return { bias, confidence, reason, model, timestamp: Date.now() };
    } catch (err) {
      this.logger.error('Gemini analysis failed', err);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async testKey(apiKey: string, model: string): Promise<{ success: boolean; message: string }> {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: 'Reply with the single word: ok' }] }],
            generationConfig: { temperature: 0, maxOutputTokens: 10 },
          }),
        }
      );
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        return { success: false, message: `Gemini Hatası HTTP ${res.status}: ${txt.slice(0, 180)}` };
      }
      return { success: true, message: `Gemini bağlantısı başarılı (model: ${model})` };
    } catch (err) {
      return { success: false, message: `Bağlantı hatası: ${String(err)}` };
    }
  }
}
