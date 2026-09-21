import { useEffect, useState } from 'react';
import {
  PlugZap, Trash2, Save, ShieldCheck, Sparkles,
  Download, RefreshCw, Rocket, FolderInput, Power, Bell,
} from 'lucide-react';
import { useTerminal } from '../../store/useStore';
import type { TradingConfig } from '../../types/trading';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="panel p-4">
      <h2 className="text-sm font-bold mb-3">{title}</h2>
      {children}
    </div>
  );
}

function Num({ label, value, onChange, step = 0.5, min = 0, max = 100 }: {
  label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number;
}) {
  return (
    <div>
      <label className="label">{label}</label>
      <input className="input" type="number" step={step} min={min} max={max} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)} />
    </div>
  );
}

export function SettingsPanel() {
  const { tradingConfig, setTradingConfig, updater, setUpdater } = useTerminal();
  const [exchange, setExchange] = useState<'binance' | 'bybit'>('binance');
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [hasSaved, setHasSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [symbolsText, setSymbolsText] = useState(tradingConfig.symbols.join(', '));

  // Gemini
  const [gemKey, setGemKey] = useState('');
  const [gemModel, setGemModel] = useState('gemini-2.0-flash');
  const [gemConfigured, setGemConfigured] = useState('');
  const [gemTesting, setGemTesting] = useState(false);

  // Prefs
  const [closeToTray, setCloseToTray] = useState(true);
  const [autoStart, setAutoStart] = useState(false);
  const [updateRepo, setUpdateRepo] = useState('');
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [paper, setPaper] = useState<{ virtualBalance: number; realizedPnL: number; totalTrades: number; positions: unknown[] } | null>(null);
  const [resetting, setResetting] = useState(false);

  const cfg = (patch: Partial<TradingConfig>) => setTradingConfig({ ...tradingConfig, ...patch });

  useEffect(() => {
    (async () => {
      try {
        const api = window.electronAPI;
        if (!api) return;
        const creds = await api.getCredentials();
        if (creds) { setExchange(creds.exchange); setHasSaved(true); }
        const tcfg = await api.getTradingConfig();
        if (tcfg) { setTradingConfig(tcfg); setSymbolsText(tcfg.symbols.join(', ')); }
        const gem = await api.getGemini();
        if (gem?.configured) { setGemConfigured(gem.masked); setGemModel(gem.model); }
        const prefs = await api.getPrefs();
        if (prefs) { setCloseToTray(prefs.closeToTray); setAutoStart(prefs.autoStart); setUpdateRepo(prefs.updateRepo); }
        const paperState = await api.getPaper().catch(() => null);
        if (paperState) setPaper(paperState);
        const off = api.onUpdaterStatus((s) => {
          setUpdater(s);
          if (s.phase === 'downloaded' || s.phase === 'error' || s.phase === 'not-available') setCheckingUpdate(false);
        });
        return off;
      } catch { /* ignore */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const say = (m: string) => setTestMsg(m);

  // ── Exchange ──
  const testConnection = async () => {
    if (!apiKey || !apiSecret) { say('Key ve Secret girin.'); return; }
    setTesting(true);
    try {
      const res = await window.electronAPI?.testConnection({ exchange, apiKey, apiSecret, testnet: true });
      say(res?.success ? `✅ ${res.message}` : `❌ ${res?.message}`);
    } catch (e) { say(`❌ ${String(e)}`); } finally { setTesting(false); }
  };
  const saveCredentials = async () => {
    if (!apiKey || !apiSecret) { say('Key ve Secret girin.'); return; }
    setSaving(true);
    try {
      await window.electronAPI?.saveCredentials({ exchange, apiKey, apiSecret, testnet: true });
      setHasSaved(true); setApiKey(''); setApiSecret('');
      say('✅ Anahtarlar şifreli olarak kaydedildi (electron-store + AES).');
    } catch (e) { say(`❌ ${String(e)}`); } finally { setSaving(false); }
  };
  const deleteCredentials = async () => {
    if (!confirm('Kayıtlı API anahtarları silinsin mi?')) return;
    await window.electronAPI?.deleteCredentials();
    setHasSaved(false); say('Anahtarlar silindi.');
  };

  // ── Trading config ──
  const saveConfig = async () => {
    const symbols = symbolsText.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    const next = { ...tradingConfig, symbols };
    setTradingConfig(next);
    await window.electronAPI?.saveTradingConfig(next);
    say('✅ Trading konfigürasyonu kaydedildi. Yeni ayarlar bot yeniden başlatılınca geçerli olur.');
  };

  // ── Gemini ──
  const saveGemini = async () => {
    if (!gemKey) { say('Gemini API anahtarı girin.'); return; }
    await window.electronAPI?.saveGemini(gemKey, gemModel);
    setGemKey('');
    const g = await window.electronAPI?.getGemini();
    setGemConfigured(g?.masked ?? '');
    say('✅ Gemini anahtarı şifreli kaydedildi.');
  };
  const testGemini = async () => {
    if (!gemKey && !gemConfigured) { say('Önce anahtar girin.'); return; }
    setGemTesting(true);
    try {
      // Boş anahtar → main kayıtlı (şifreli) anahtarla test eder
      const res = await window.electronAPI?.testGemini(gemKey, gemModel);
      say(res?.success ? `✅ ${res.message}` : `❌ ${res?.message}`);
    } catch (e) { say(`❌ ${String(e)}`); } finally { setGemTesting(false); }
  };
  const importGemini = async () => {
    const res = await window.electronAPI?.importGemini();
    say(res?.success ? `✅ ${res.message}` : `❌ ${res?.message}`);
    if (res?.success) {
      const g = await window.electronAPI?.getGemini();
      setGemConfigured(g?.masked ?? '');
      if (res.model) setGemModel(res.model);
    }
  };
  const deleteGemini = async () => {
    if (!confirm('Gemini anahtarı silinsin mi?')) return;
    await window.electronAPI?.deleteGemini();
    setGemConfigured(''); say('Gemini anahtarı silindi.');
  };

  // ── Prefs & updater ──
  const savePrefs = async () => {
    await window.electronAPI?.savePrefs({ closeToTray, autoStart, updateRepo: updateRepo.trim() });
    say('✅ Uygulama ayarları kaydedildi.');
  };
  const resetPaper = async () => {
    if (!confirm('Simülasyon hesabı sıfırlansın mı? Bakiye $10.000 olur, açık pozisyonlar silinir. Journal geçmişi KORUNUR.')) return;
    setResetting(true);
    try {
      const res = await window.electronAPI?.resetPaper();
      say(res?.success ? `✅ ${res.message}` : `❌ ${res?.message}`);
      const paperState = await window.electronAPI?.getPaper().catch(() => null);
      setPaper(paperState ?? null);
    } finally {
      setResetting(false);
    }
  };
  const checkUpdates = async () => {
    setCheckingUpdate(true);
    setUpdater({ phase: 'checking', message: 'Denetleniyor…' });
    const res = await window.electronAPI?.checkForUpdates();
    if (!res?.ok) { setCheckingUpdate(false); say(`❌ ${res?.message}`); }
  };
  const installUpdate = async () => {
    if (!confirm('Yeni sürüm kurulup uygulama yeniden başlatılsın mı? Açık pozisyonlar etkilenmez (bot simülasyon modunda sıfırlanır).')) return;
    await window.electronAPI?.installUpdate();
  };

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="max-w-3xl mx-auto space-y-4 pb-6">

        <Section title="API Ayarları (Testnet Only)">
          <p className="text-xs text-terminal-textMuted mb-4 flex items-center gap-1.5">
            <ShieldCheck size={13} className="text-terminal-accent" />
            Anahtarlar koda gömülmez — electron-store içinde AES ile şifreli saklanır. Sadece Testnet.
            {hasSaved && <span className="ml-1 px-1.5 py-0.5 rounded bg-terminal-accentDim text-terminal-accent font-bold">KAYITLI</span>}
          </p>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <label className="label">Borsa</label>
              <div className="flex gap-2">
                {(['binance', 'bybit'] as const).map((ex) => (
                  <button key={ex} onClick={() => setExchange(ex)}
                    className={`flex-1 px-3 py-1.5 rounded text-sm font-bold capitalize border transition ${exchange === ex ? 'bg-terminal-accentDim text-terminal-accent border-terminal-accent/40' : 'bg-terminal-bg border-terminal-border text-terminal-textMuted'}`}>
                    {ex}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="label">Ortam</label>
              <div className="input text-terminal-warning font-bold">TESTNET (izole)</div>
            </div>
          </div>
          <label className="label">API Key</label>
          <input className="input font-mono mb-3" type="password" placeholder={hasSaved ? '•••••••• (kayıtlı)' : 'Testnet API Key'} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          <label className="label">API Secret</label>
          <input className="input font-mono mb-4" type="password" placeholder={hasSaved ? '•••••••• (kayıtlı)' : 'Testnet API Secret'} value={apiSecret} onChange={(e) => setApiSecret(e.target.value)} />
          <div className="flex gap-2 flex-wrap">
            <button className="btn-ghost" disabled={testing} onClick={testConnection}><PlugZap size={14} /> {testing ? 'Test ediliyor…' : 'Bağlantıyı Test Et'}</button>
            <button className="btn-accent" disabled={saving} onClick={saveCredentials}><Save size={14} /> {saving ? 'Kaydediliyor…' : 'Şifreli Kaydet'}</button>
            {hasSaved && <button className="btn-danger" onClick={deleteCredentials}><Trash2 size={14} /> Sil</button>}
          </div>
        </Section>

        <Section title="Strateji & Sinyal">
          <label className="label">Semboller (virgülle ayırın)</label>
          <input className="input font-mono mb-3" value={symbolsText} onChange={(e) => setSymbolsText(e.target.value)} />
          <label className="label">Strateji Periyodu (bot bu mumlarda çalışır — değişiklikte botu yeniden başlatın)</label>
          <div className="flex gap-2 mb-3">
            {(['1m', '5m', '15m', '1h', '4h'] as const).map((t) => (
              <button key={t} onClick={() => cfg({ timeframe: t })}
                className={`flex-1 px-3 py-1.5 rounded text-sm font-mono font-bold border transition ${tradingConfig.timeframe === t ? 'bg-terminal-accent text-black border-terminal-accent' : 'bg-terminal-bg border-terminal-border text-terminal-textMuted'}`}>
                {t}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <Num label="Risk / İşlem (örn. 0.02 = %2)" value={tradingConfig.riskPerTrade} step={0.005} min={0.001} max={0.1} onChange={(v) => cfg({ riskPerTrade: v })} />
            <Num label="Max Pozisyon" value={tradingConfig.maxPositions} step={1} min={1} max={10} onChange={(v) => cfg({ maxPositions: Math.round(v) })} />
            <Num label="Min. Sinyal Gücü (1-4)" value={tradingConfig.minSignalStrength} step={1} min={1} max={4} onChange={(v) => cfg({ minSignalStrength: Math.min(4, Math.max(1, Math.round(v))) })} />
            <Num label="Soğuma Süresi / Sembol (dk, 0=kapalı)" value={tradingConfig.cooldownMinutes} step={1} min={0} max={120} onChange={(v) => cfg({ cooldownMinutes: v })} />
          </div>
          <label className="label">İşlem Yönü</label>
          <div className="flex gap-2 mb-3">
            {([['both', 'Long + Short'], ['long-only', 'Sadece Long'], ['short-only', 'Sadece Short']] as const).map(([v, l]) => (
              <button key={v} onClick={() => cfg({ tradingSide: v })}
                className={`flex-1 px-3 py-1.5 rounded text-sm font-bold border transition ${tradingConfig.tradingSide === v ? 'bg-terminal-accentDim text-terminal-accent border-terminal-accent/40' : 'bg-terminal-bg border-terminal-border text-terminal-textMuted'}`}>
                {l}
              </button>
            ))}
          </div>
          <label className="label">Stratejiler (oylama sistemi)</label>
          <div className="grid grid-cols-2 gap-2 mb-3">
            {([['emaCross', 'EMA 9/21 Kesişimi'], ['macd', 'MACD'], ['rsi', 'RSI'], ['bollinger', 'Bollinger']] as const).map(([key, label]) => (
              <label key={key} className="flex items-center gap-2 text-sm bg-terminal-bg border border-terminal-border rounded px-2.5 py-2 cursor-pointer">
                <input type="checkbox" className="accent-[#00d4aa]" checked={tradingConfig.strategies[key]}
                  onChange={(e) => cfg({ strategies: { ...tradingConfig.strategies, [key]: e.target.checked } })} />
                {label}
              </label>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm mb-1 cursor-pointer">
            <input type="checkbox" className="accent-[#00d4aa]" checked={tradingConfig.useLimitOrders} onChange={(e) => cfg({ useLimitOrders: e.target.checked })} />
            Limit emir simülasyonu kullan (kapalı = market)
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" className="accent-[#00d4aa]" checked={tradingConfig.adaptiveMode} onChange={(e) => cfg({ adaptiveMode: e.target.checked })} />
            <span><b>Adaptif Mod</b> <span className="text-terminal-textMuted">— volatiliteye göre sinyal eşiği + zarar serisinde riski yarıya indirir, uygulamaya bırak</span></span>
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer mt-1">
            <input type="checkbox" className="accent-[#00d4aa]" checked={tradingConfig.regimeFilterEnabled} onChange={(e) => cfg({ regimeFilterEnabled: e.target.checked })} />
            <span><b>Rejim Filtresi (ADX)</b> <span className="text-terminal-textMuted">— yatay piyasada bot dinlenir, kırbaçtan korunur</span></span>
          </label>
          <div className="grid grid-cols-2 gap-3 mt-3">
            <Num label="Min. ADX (altı = yatay, klasik 20)" value={tradingConfig.adxThreshold} step={1} min={5} max={50} onChange={(v) => cfg({ adxThreshold: v })} />
            <Num label="Günlük zarar freni (0.03 = %3, 0=kapalı)" value={tradingConfig.maxDailyLossPct} step={0.005} min={0} max={0.2} onChange={(v) => cfg({ maxDailyLossPct: v })} />
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer mt-2">
            <input type="checkbox" className="accent-[#00d4aa]" checked={tradingConfig.htfFilterEnabled} onChange={(e) => cfg({ htfFilterEnabled: e.target.checked })} />
            <span><b>Üst-periyot trend filtresi</b> <span className="text-terminal-textMuted">— 5m sinyali 1h trendle aynı yönde olmalı, ana trende kafa atılmaz</span></span>
          </label>
          <div className="flex gap-2 mt-2">
            {(['15m', '1h', '4h'] as const).map((t) => (
              <button key={t} onClick={() => cfg({ htfTimeframe: t })}
                className={`flex-1 px-3 py-1.5 rounded text-sm font-mono font-bold border transition ${tradingConfig.htfTimeframe === t ? 'bg-terminal-accentDim text-terminal-accent border-terminal-accent/40' : 'bg-terminal-bg border-terminal-border text-terminal-textMuted'}`}>
                {t}
              </button>
            ))}
          </div>
        </Section>

        <Section title="Pozisyon Yönetimi (otomatik çıkışlar)">
          <p className="text-xs text-terminal-textMuted mb-3">
            Bot pozisyonu <b>şu durumlarda kendisi kapatır</b>: Take-Profit (+2R varsayılan) → kârı kilitler;
            Stop-Loss (−1R) → zararı keser; Trailing stop → kâr büyüdükçe stopu fiyata yaklaştırır;
            Başabaş → +1R kârda stopu girişe çeker; Maks. süre → zaman aşımında kapatır.
          </p>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <Num label="SL ATR Çarpanı" value={tradingConfig.stopLossATRMultiplier} step={0.5} min={0.5} max={5} onChange={(v) => cfg({ stopLossATRMultiplier: v })} />
            <Num label="TP Risk/Ödül (örn. 2 = 1:2)" value={tradingConfig.takeProfitRiskReward} step={0.5} min={1} max={5} onChange={(v) => cfg({ takeProfitRiskReward: v })} />
            <Num label="Trailing ATR Çarpanı" value={tradingConfig.trailingATRMultiplier} step={0.25} min={0.25} max={5} onChange={(v) => cfg({ trailingATRMultiplier: v })} />
            <Num label="Başabaş Tetikleyici (R, 0=kapalı)" value={tradingConfig.breakevenTriggerR} step={0.5} min={0} max={5} onChange={(v) => cfg({ breakevenTriggerR: v })} />
            <Num label="Maks. Taşıma Süresi (dk, 0=kapalı)" value={tradingConfig.maxHoldMinutes} step={5} min={0} max={1440} onChange={(v) => cfg({ maxHoldMinutes: v })} />
            <Num label="Komisyon oranı (0.001 = %0.1)" value={tradingConfig.commissionRate} step={0.00025} min={0} max={0.01} onChange={(v) => cfg({ commissionRate: v })} />
            <Num label="Kayma slipaj (bps, 100 = %1)" value={tradingConfig.slippageBps} step={1} min={0} max={50} onChange={(v) => cfg({ slippageBps: v })} />
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" className="accent-[#00d4aa]" checked={tradingConfig.trailingStopEnabled} onChange={(e) => cfg({ trailingStopEnabled: e.target.checked })} />
            Trailing stop aktif (kârdayken stopu fiyatla birlikte sürükle)
          </label>
        </Section>

        <Section title="Yapay Zekâ (Gemini) — ikinci görüş katmanı">
          <p className="text-xs text-terminal-textMuted mb-3 flex items-center gap-1.5">
            <Sparkles size={13} className="text-terminal-accent" />
            <span>
              <b>Assist</b>: AI görüşünü loga yazar, karar tekniğindir. <b>Gate</b>: AI %60+ güvenle karşıysa
              sinyali veto eder. AI çökerse motor tekniğe düşer, bot durmaz.
              {gemConfigured && <span className="ml-1 px-1.5 py-0.5 rounded bg-terminal-accentDim text-terminal-accent font-bold">KAYITLI {gemConfigured}</span>}
            </span>
          </p>
          <label className="label">AI Modu</label>
          <div className="flex gap-2 mb-3">
            {([['off', 'Kapalı'], ['assist', 'Assist (öneri)'], ['gate', 'Gate (veto)']] as const).map(([v, l]) => (
              <button key={v} onClick={() => cfg({ aiMode: v })}
                className={`flex-1 px-3 py-1.5 rounded text-sm font-bold border transition ${tradingConfig.aiMode === v ? 'bg-terminal-accentDim text-terminal-accent border-terminal-accent/40' : 'bg-terminal-bg border-terminal-border text-terminal-textMuted'}`}>
                {l}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <label className="label">Gemini API Key</label>
              <input className="input font-mono" type="password" placeholder={gemConfigured ? `•••••• (kayıtlı ${gemConfigured})` : 'AIza…'} value={gemKey} onChange={(e) => setGemKey(e.target.value)} />
            </div>
            <div>
              <label className="label">Model</label>
              <input className="input font-mono" value={gemModel} onChange={(e) => setGemModel(e.target.value)} placeholder="gemini-2.0-flash" />
            </div>
          </div>
          <div className="flex gap-2 flex-wrap">
            <button className="btn-accent" onClick={saveGemini}><Save size={14} /> Şifreli Kaydet</button>
            <button className="btn-ghost" disabled={gemTesting} onClick={testGemini}><PlugZap size={14} /> {gemTesting ? 'Test…' : 'Test Et'}</button>
            <button className="btn-ghost" onClick={importGemini}><FolderInput size={14} /> Videofolge'dan Aktar</button>
            {gemConfigured && <button className="btn-danger" onClick={deleteGemini}><Trash2 size={14} /> Sil</button>}
          </div>
        </Section>

        <Section title="Güncellemeler (GitHub)">
          <p className="text-xs text-terminal-textMuted mb-3">
            Repo adresini yazın (örn: <span className="font-mono">kullaniciadi/tradermax</span>), "Güncellemeyi Denetle"ye basın.
            Yeni sürüm varsa otomatik iner; "Kur ve Yeniden Başlat" ile geçersiniz. npm falan gerekmez.
          </p>
          <label className="label">GitHub Repo (owner/repo)</label>
          <input className="input font-mono mb-3" placeholder="kullaniciadi/tradermax" value={updateRepo} onChange={(e) => setUpdateRepo(e.target.value)} />
          <div className="flex gap-2 flex-wrap items-center">
            <button className="btn-ghost" disabled={checkingUpdate} onClick={checkUpdates}>
              <RefreshCw size={14} className={checkingUpdate ? 'animate-spin' : ''} /> {checkingUpdate ? 'Denetleniyor…' : 'Güncellemeyi Denetle'}
            </button>
            {updater.phase === 'downloaded' && (
              <button className="btn-accent" onClick={installUpdate}><Rocket size={14} /> Kur ve Yeniden Başlat (v{updater.version})</button>
            )}
          </div>
          {updater.message && (
            <div className="mt-3 text-xs font-mono bg-terminal-bg rounded border border-terminal-border p-2 flex items-center gap-2">
              <Download size={13} className="text-terminal-accent shrink-0" />
              [{updater.phase}] {updater.message}
            </div>
          )}
        </Section>

        <Section title="Uygulama">
          <label className="flex items-center gap-2 text-sm mb-2 cursor-pointer">
            <input type="checkbox" className="accent-[#00d4aa]" checked={closeToTray} onChange={(e) => setCloseToTray(e.target.checked)} />
            <span className="flex items-center gap-1.5"><Power size={13} /> Pencereyi kapatınca tepsiye küçült — <b>bot arka planda çalışmaya devam eder</b></span>
          </label>
          <label className="flex items-center gap-2 text-sm mb-4 cursor-pointer">
            <input type="checkbox" className="accent-[#00d4aa]" checked={autoStart} onChange={(e) => setAutoStart(e.target.checked)} />
            <span className="flex items-center gap-1.5"><Bell size={13} /> Windows açılışında otomatik başlat</span>
          </label>
          <div className="flex gap-2 flex-wrap">
            <button className="btn-accent" onClick={saveConfig}><Save size={14} /> Tüm Trading Ayarlarını Kaydet</button>
            <button className="btn-ghost" onClick={savePrefs}><Save size={14} /> Uygulama Ayarlarını Kaydet</button>
          </div>
        </Section>

        <Section title="Simülasyon Hesabı (hafıza)">
          <p className="text-xs text-terminal-textMuted mb-3">
            Botun hafızası disktedir: bakiye, kâr/zarar istatistikleri ve <b>açık pozisyonlar</b> uygulamayı
            kapatıp açınca veya güncelleyince <b>kaybolmaz</b> — kaldığı yerden devam eder.
            Journal geçmişi sıfırlamadan etkilenmez.
          </p>
          {paper ? (
            <div className="grid grid-cols-3 gap-2 mb-3 font-mono text-center">
              <div className="bg-terminal-bg border border-terminal-border rounded px-2 py-1.5">
                <div className="text-[10px] text-terminal-textDim uppercase">Bakiye</div>
                <div className="font-bold">${paper.virtualBalance.toFixed(2)}</div>
              </div>
              <div className="bg-terminal-bg border border-terminal-border rounded px-2 py-1.5">
                <div className="text-[10px] text-terminal-textDim uppercase">Net PnL</div>
                <div className={`font-bold ${paper.realizedPnL >= 0 ? 'text-terminal-accent' : 'text-terminal-danger'}`}>{paper.realizedPnL >= 0 ? '+' : ''}{paper.realizedPnL.toFixed(2)}</div>
              </div>
              <div className="bg-terminal-bg border border-terminal-border rounded px-2 py-1.5">
                <div className="text-[10px] text-terminal-textDim uppercase">İşlem / Açık</div>
                <div className="font-bold">{paper.totalTrades} / {paper.positions.length}</div>
              </div>
            </div>
          ) : (
            <p className="text-xs text-terminal-textDim mb-3">Kayıtlı hesap yok — ilk bot çalıştırmada $10.000 ile oluşur.</p>
          )}
          <button className="btn-danger" disabled={resetting} onClick={resetPaper}>
            <Trash2 size={14} /> {resetting ? 'Sıfırlanıyor…' : 'Hesabı Sıfırla ($10.000)'}
          </button>
        </Section>

        {testMsg && <div className="text-xs font-mono bg-terminal-bgSecondary rounded border border-terminal-border p-2.5">{testMsg}</div>}
      </div>
    </div>
  );
}
