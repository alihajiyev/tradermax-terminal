import { useEffect } from 'react';
import { useTerminal } from '../store/useStore';

export function useLiveSync() {
  const {
    upsertMarket, upsertPosition, upsertOrder, setPortfolio,
    setBotStatus, pushLog, selectedSymbol, timeframe, setIndicators, uiMode,
  } = useTerminal();

  // Subscribe to push events once
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    const offs = [
      api.onMarketDataUpdate((m) => upsertMarket(m)),
      api.onPositionUpdate((p) => upsertPosition(p)),
      api.onOrderUpdate((o) => upsertOrder(o)),
      api.onPortfolioUpdate((p) => setPortfolio(p)),
      api.onBotStatusChange((b) => setBotStatus(b)),
      api.onLog((l) => pushLog(l)),
    ];

    // Initial snapshot
    (async () => {
      try {
        const [portfolio, positions, orders, status, logs, config, hasCreds, prefs] = await Promise.all([
          api.getPortfolioSummary(),
          api.getPositions(),
          api.getOpenOrders(),
          api.getBotStatus(),
          api.getLogs(200),
          api.getTradingConfig().catch(() => null),
          api.hasCredentials().catch(() => false),
          api.getPrefs().catch(() => null),
        ]);
        setPortfolio(portfolio);
        useTerminal.getState().setPositions(positions);
        useTerminal.getState().setOrders(orders);
        useTerminal.getState().setLogs(logs);
        setBotStatus(status);
        if (config) useTerminal.getState().setTradingConfig(config);
        useTerminal.getState().setSimMode(!hasCreds);
        if (prefs?.uiMode) useTerminal.getState().setUiMode(prefs.uiMode);
      } catch (e) {
        console.error('Initial sync failed', e);
      }
    })();

    return () => { offs.forEach((off) => off()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll indicators + candles for selected symbol (skipped in lite mode — no consumers)
  useEffect(() => {
    const api = window.electronAPI;
    if (!api || uiMode === 'lite') return;
    let cancelled = false;
    const fetchInd = async () => {
      try {
        const ind = await api.getIndicators(selectedSymbol, timeframe);
        if (!cancelled && ind) setIndicators(ind);
      } catch { /* ignore */ }
    };
    fetchInd();
    const t = setInterval(fetchInd, 8000);
    return () => { cancelled = true; clearInterval(t); };
  }, [selectedSymbol, timeframe, setIndicators, uiMode]);
}
