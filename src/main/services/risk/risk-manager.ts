import Decimal from 'decimal.js';
import type { TradingConfig, Position, RiskMetrics, MarketData, IndicatorData } from '../../../renderer/types/trading.js';

export class RiskManager {
  private config: TradingConfig;

  constructor(config: TradingConfig) {
    this.config = config;
  }

  updateConfig(config: TradingConfig): void {
    this.config = config;
  }

  calculatePositionSize(
    balance: number,
    entryPrice: number,
    stopLoss: number,
    leverage: number = 1,
    riskPerTradeOverride?: number
  ): RiskMetrics {
    const totalBalance = new Decimal(balance);
    const entry = new Decimal(entryPrice);
    const stop = new Decimal(stopLoss);
    const lev = Math.max(1, leverage);

    const priceDiff = entry.minus(stop).abs();
    const riskPercent = entry.isZero() ? new Decimal(0) : priceDiff.dividedBy(entry);

    // Target: risk at most riskPerTrade of balance; size = targetRisk / riskPercent
    const riskPerTrade = riskPerTradeOverride ?? this.config.riskPerTrade;
    const targetRisk = totalBalance.times(riskPerTrade);
    let positionSize = riskPercent.isZero() ? new Decimal(0) : targetRisk.dividedBy(riskPercent);

    // Notional cap: never exceed 95% of balance × leverage (margin safety)
    const maxNotional = totalBalance.times(0.95).times(lev);
    if (positionSize.greaterThan(maxNotional)) {
      positionSize = maxNotional;
    }

    const side: 'LONG' | 'SHORT' = entryPrice >= stopLoss ? 'LONG' : 'SHORT';
    const takeProfit = this.calculateTakeProfit(entryPrice, stopLoss, side, this.config.takeProfitRiskReward);

    // Actual dollar risk/reward from final size (cap may reduce both proportionally,
    // so the R:R ratio always equals the configured ratio by construction)
    const actualRisk = riskPercent.times(positionSize);
    const rewardDistance = new Decimal(takeProfit).minus(entry).abs();
    const rewardAmount = entry.isZero() ? new Decimal(0) : rewardDistance.dividedBy(entry).times(positionSize);
    const riskRewardRatio = actualRisk.isZero() ? 0 : rewardAmount.dividedBy(actualRisk).toNumber();

    const marginRequired = positionSize.dividedBy(lev).toNumber();

    return {
      positionSize: positionSize.toNumber(),
      stopLoss,
      takeProfit,
      riskAmount: actualRisk.toNumber(),
      rewardAmount: rewardAmount.toNumber(),
      riskRewardRatio,
      marginRequired,
    };
  }

  calculateStopLoss(
    entryPrice: number,
    atr: number,
    side: 'LONG' | 'SHORT',
    multiplier: number = 2
  ): number {
    const atrValue = new Decimal(atr);
    const entry = new Decimal(entryPrice);
    const distance = atrValue.times(multiplier);
    
    if (side === 'LONG') {
      return entry.minus(distance).toNumber();
    } else {
      return entry.plus(distance).toNumber();
    }
  }

  calculateTakeProfit(
    entryPrice: number,
    stopLoss: number,
    side: 'LONG' | 'SHORT',
    riskRewardRatio: number = 2
  ): number {
    const entry = new Decimal(entryPrice);
    const stop = new Decimal(stopLoss);
    const riskDistance = entry.minus(stop).abs();
    const rewardDistance = riskDistance.times(riskRewardRatio);
    
    if (side === 'LONG') {
      return entry.plus(rewardDistance).toNumber();
    } else {
      return entry.minus(rewardDistance).toNumber();
    }
  }

  calculateLiquidationPrice(
    entryPrice: number,
    side: 'LONG' | 'SHORT',
    leverage: number,
    maintenanceMarginRate: number = 0.005
  ): number {
    const entry = new Decimal(entryPrice);
    const lev = new Decimal(leverage);
    const mmr = new Decimal(maintenanceMarginRate);
    
    if (side === 'LONG') {
      return entry.times(lev.minus(1).plus(mmr)).dividedBy(lev).toNumber();
    } else {
      return entry.times(lev.minus(1).minus(mmr)).dividedBy(lev).toNumber();
    }
  }

  validatePosition(position: Position, marketData: MarketData): {
    valid: boolean;
    reason?: string;
    action?: 'CLOSE' | 'REDUCE' | 'HOLD';
  } {
    const currentPrice = new Decimal(marketData.price);
    const entryPrice = new Decimal(position.entryPrice);
    const stopLoss = new Decimal(position.stopLoss);
    const takeProfit = new Decimal(position.takeProfit);
    const liquidationPrice = new Decimal(position.liquidationPrice);
    
    const pnlPercent = currentPrice.minus(entryPrice).dividedBy(entryPrice).times(100);
    
    if (position.side === 'LONG') {
      if (currentPrice.lessThanOrEqualTo(liquidationPrice)) {
        return { valid: false, reason: 'Liquidation price reached', action: 'CLOSE' };
      }
      if (currentPrice.lessThanOrEqualTo(stopLoss)) {
        return { valid: false, reason: 'Stop loss triggered', action: 'CLOSE' };
      }
      if (currentPrice.greaterThanOrEqualTo(takeProfit)) {
        return { valid: false, reason: 'Take profit reached', action: 'CLOSE' };
      }
    } else {
      if (currentPrice.greaterThanOrEqualTo(liquidationPrice)) {
        return { valid: false, reason: 'Liquidation price reached', action: 'CLOSE' };
      }
      if (currentPrice.greaterThanOrEqualTo(stopLoss)) {
        return { valid: false, reason: 'Stop loss triggered', action: 'CLOSE' };
      }
      if (currentPrice.lessThanOrEqualTo(takeProfit)) {
        return { valid: false, reason: 'Take profit reached', action: 'CLOSE' };
      }
    }

    if (Math.abs(pnlPercent.toNumber()) > 10) {
      return { valid: true, reason: 'Large unrealized PnL', action: 'REDUCE' };
    }

    return { valid: true, action: 'HOLD' };
  }

  calculatePortfolioRisk(positions: Position[], balances: Record<string, number>): {
    totalExposure: number;
    totalRisk: number;
    maxDrawdown: number;
    concentrationRisk: Record<string, number>;
  } {
    let totalExposure = new Decimal(0);
    let totalRisk = new Decimal(0);
    const concentrationRisk: Record<string, number> = {};
    
    for (const position of positions) {
      const positionValue = new Decimal(position.entryPrice).times(position.quantity);
      totalExposure = totalExposure.plus(positionValue);
      
      const riskAmount = positionValue.times(this.config.riskPerTrade);
      totalRisk = totalRisk.plus(riskAmount);
      
      if (!concentrationRisk[position.symbol]) {
        concentrationRisk[position.symbol] = 0;
      }
      concentrationRisk[position.symbol] += positionValue.toNumber();
    }

    const totalBalance = Object.values(balances).reduce((sum, b) => sum + b, 0);
    const maxDrawdown = totalBalance > 0 ? totalRisk.dividedBy(totalBalance).toNumber() : 0;

    return {
      totalExposure: totalExposure.toNumber(),
      totalRisk: totalRisk.toNumber(),
      maxDrawdown,
      concentrationRisk,
    };
  }

  shouldReducePosition(position: Position, marketData: MarketData): boolean {
    const validation = this.validatePosition(position, marketData);
    return validation.action === 'REDUCE' || validation.action === 'CLOSE';
  }
}