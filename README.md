# TraderMax Terminal — Algoritmik Trading ve Testnet Terminali

Bloomberg tarzı koyu tema, Electron + React 19 + TypeScript + Tailwind CSS ile
geliştirilmiş masaüstü algoritmik trading terminali. **Sadece Testnet** ortamında çalışır.

## Mimari

```
src/
├── main/                      # Electron main process (Node)
│   ├── main.ts                # Pencere + uygulama yaşam döngüsü
│   ├── ipc/secure-ipc.ts      # Güvenli IPC (validateEvent + invoke-only)
│   ├── services/
│   │   ├── trading-engine.ts  # Bot motoru: WS + polling + strateji + risk
│   │   ├── exchange-api.ts    # Binance/Bybit Testnet REST istemcisi
│   │   ├── settings-service.ts# electron-store + AES şifreli anahtar saklama
│   │   ├── indicators/        # EMA, MACD, RSI, ATR, Bollinger, VWAP
│   │   └── risk/              # ATR stop, 1:2 TP, %2 pozisyon büyüklüğü
│   └── utils/logger.ts        # Dosya + bellek loglama
├── preload/preload.ts         # contextBridge (contextIsolation: true)
└── renderer/                  # React 19 + Vite + Tailwind
    ├── App.tsx                # Terminal shell (sidebar + grafik + gridler)
    ├── store/useStore.ts      # Zustand global state
    ├── hooks/useLiveSync.ts   # IPC event abonelikleri + ilk senkron
    ├── components/
    │   ├── charts/CandlestickChart.tsx  # Canvas mum grafik (EMA9/21, hacim, crosshair)
    │   ├── panels/ (Logs, Positions, OrderBook)
    │   ├── trading/ (BotControls, PortfolioBar)
    │   ├── settings/SettingsPanel.tsx   # Şifreli API ayarları + strateji config
    │   └── ui/ (TitleBar, Sidebar)
    └── types/                 # Paylaşılan TS tipleri (main+preload+renderer)
```

## Güvenlik

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- Preload köprüsü dışında renderer ↔ main erişimi yok
- API anahtarları koda gömülmez; `electron-store` içinde AES ile şifreli saklanır
- Sadece Testnet endpoint'leri (`testnet.binance.vision`, Bybit testnet)

## Strateji

Oylama sistemi (en az 1.5 net oy gerekir): EMA 9/21 kesişimi + MACD + RSI + Bollinger.
Her sinyalde otomatik risk hesaplanır:

- **Stop-Loss:** ATR × çarpan (varsayılan 2)
- **Take-Profit:** R:R 1:2 (ayarlanabilir)
- **Pozisyon büyüklüğü:** bakiyenin en fazla %2 riski + %95 notionel marj tavanı
- Market veya Limit emir simülasyonu

## Çalıştırma

Gereksinim: Node.js 20+

```powershell
cd C:\Users\Vafa\Desktop\TraderMax

# 1) Bağımlılıklar (ilk kurulum)
& "C:\Program Files\nodejs\npm.cmd" install

# 2) Geliştirme (iki terminal VEYA tek komut):
& "C:\Program Files\nodejs\npm.cmd" run dev
#    → Vite :5173 + tsc watch; Electron'u ayrı başlat:
& "C:\Program Files\nodejs\npx.cmd" electron .

# 3) Production build + başlat
& "C:\Program Files\nodejs\npm.cmd" run build
& "C:\Program Files\nodejs\npx.cmd" electron dist/main/main.js

# 4) Windows kurulum paketi (NSIS)
& "C:\Program Files\nodejs\npm.cmd" run dist
```

> Not: `npm.ps1` bu sistemde execution-policy engeline takılır; `npm.cmd` / `npx.cmd`
> tam yoluyla (`& "..."`) çağrın.

## Kullanım

1. Uygulama **anahtarsız da çalışır** — Binance Testnet public verisiyle 10.000 USDT
   sanal bakiyeyle simülasyon yapılır.
2. Gerçek testnet emirleri için: **API Ayarları** sekmesinden Binance/Bybit Testnet
   key girin → *Bağlantıyı Test Et* → *Şifreli Kaydet*.
3. **Botu Başlat** → sinyal, pozisyon, SL/TP ve PnL; Logs + Açık Pozisyonlar +
   Emir Defteri panellerine canlı yansır.
4. **KILL SWITCH** tüm pozisyonları marketten kapatır ve botu durdurur.
5. Açık pozisyonu elle kapatmak için **Açık Pozisyonlar** tablosundaki **Kapat** düğmesi.
6. Botun otomatik çıkışları: **TP** (+R×oran kârda), **SL** (−1R zararda),
   **Trailing stop** (kârdayken stopu sürükler), **Başabaş** (+1R'de SL girişe),
   **Maks. süre** — hepsi Ayarlar → Pozisyon Yönetimi'nden ayarlanır.

## Otomatik çıkışlar ne zaman tetiklenir? (örnek)

Giriş 2636, ATR-stop ≈ 9 (≈1R risk) ise: SL 2627 (−1R), TP 2654 (+2R ≈ +%0.7 kâr),
başabaş +1R'de (2645) SL'i girişe çeker, trailing kâr büyüdükçe stopu yukarı taşır.

## 7/24 çalışma + uygulamadan güncelleme (v1.1.0+)

- **Arka plan:** Ayarlar → Uygulama → "Pencereyi kapatınca tepsiye küçült" açıkken
  pencereyi kapatmak botu durdurmaz; tepsi simgesinden geri açılır.
  "Windows açılışında otomatik başlat" ile PC açılınca terminal kendiliğinden gelir.
- **Tek tuşla güncelleme:** Ayarlar → Güncellemeler bölümüne GitHub repo adresini
  (`owner/repo`) yazıp **Güncellemeyi Denetle**'ye basın. Yeni sürüm varsa otomatik
  iner (fark güncellemesi), **Kur ve Yeniden Başlat** ile geçilir. npm gerekmez.
- **GitHub kurulumu (bir kerelik):**
  1. GitHub'da boş bir repo açın (örn. `tradermax-terminal`).
  2. Projeyi yükleyin: `git init && git add . && git commit -m "v1.1.0" && git remote add origin <repo-url> && git push -u origin main`
  3. Yeni sürüm yayınlamak için: `git tag v1.2.0 && git push origin v1.2.0`
     → Actions otomatik `.exe` üretip **Releases**'e yükler → uygulamadaki
     güncelleme düğmesi onu bulur ve kurar.
  4. Repo adresini uygulamadaki Güncellemeler bölümüne yazın.

## Yapay Zekâ (Gemini)

Ayarlar → Yapay Zekâ bölümünden API anahtarını (şifreli saklanır) girin,
model seçin (varsayılan `gemini-2.0-flash`):
- **Assist:** her sinyalde AI görüşünü loga yazar, karar sizindir/tekniktir.
- **Gate:** AI %60+ güvenle karşıt yöndeyse sinyali veto eder.
- Masaüstündeki `videofolge` klasöründe anahtar varsa **Videofolge'dan Aktar**
  düğmesi tek tıkla bulup şifreli kaydeder.
- AI yanıt vermezse motor saf tekniğe düşer — bot asla durmaz.
