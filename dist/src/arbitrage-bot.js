"use strict";
/**
 * Polymarket 15-MIN Crypto Arbitrage Bot v2
 * С улучшенной стратегией
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const clob_client_1 = require("@polymarket/clob-client");
const wallet_1 = require("@ethersproject/wallet");
const ws_1 = __importDefault(require("ws"));
const dotenv_1 = require("dotenv");
const path_1 = require("path");
(0, dotenv_1.config)({ path: (0, path_1.resolve)(__dirname, "../.env") });
// ============== ВАЛИДАЦИЯ КОНФИГУРАЦИИ ==============
function validateConfig() {
    const errors = [];
    if (!process.env.PRIVATE_KEY || process.env.PRIVATE_KEY.trim() === "") {
        errors.push("❌ PRIVATE_KEY не установлен в .env файле");
    }
    if (!process.env.FUNDER_ADDRESS || process.env.FUNDER_ADDRESS.trim() === "") {
        errors.push("❌ FUNDER_ADDRESS не установлен в .env файле");
    }
    if (errors.length > 0) {
        console.error("\n🚨 ОШИБКА КОНФИГУРАЦИИ:\n");
        errors.forEach(err => console.error(err));
        console.error("\nПроверьте файл .env и убедитесь, что все необходимые параметры установлены.\n");
        process.exit(1);
    }
}
// Автоматическое определение signatureType
// 0 = MetaMask (приватный ключ начинается с 0x), 1 = Email/Magic
function detectSignatureType(privateKey) {
    // Если приватный ключ в формате MetaMask (с 0x или 64 hex символа), используем 0
    // В противном случае, используем 1 для Email/Magic
    const cleanKey = privateKey.trim();
    if (cleanKey.startsWith("0x") || /^[0-9a-fA-F]{64}$/.test(cleanKey)) {
        return 0;
    }
    return 1;
}
// Валидируем конфигурацию при загрузке
validateConfig();
const botConfig = {
    polymarketHost: "https://clob.polymarket.com",
    gammaApiHost: "https://gamma-api.polymarket.com",
    chainId: 137,
    privateKey: process.env.PRIVATE_KEY || "",
    funderAddress: process.env.FUNDER_ADDRESS || "",
    signatureType: detectSignatureType(process.env.PRIVATE_KEY || ""),
    // ========== НАСТРОЙКИ СТРАТЕГИИ ==========
    minEdgePercent: 2.0, // Минимальный edge для входа (было 5%)
    betSizeUsdc: 5, // Размер ставки
    momentumWindowSeconds: 60, // Окно анализа (было 30 сек)
    momentumThresholdPercent: 0.05, // Порог моментума (было 0.15%)
    cooldownSeconds: 30, // Пауза между сделками
    // =========================================
    asset: "btc",
};
class BinancePriceFeed {
    constructor(asset = "btc") {
        this.ws = null;
        this.prices = [];
        this.reconnectAttempts = 0;
        const symbol = asset.toLowerCase() + "usdt";
        this.wsUrl = `wss://stream.binance.com:9443/ws/${symbol}@trade`;
    }
    async connect() {
        return new Promise((resolvePromise, reject) => {
            this.ws = new ws_1.default(this.wsUrl);
            this.ws.on("open", () => {
                console.log(`✅ Binance WebSocket подключён`);
                this.reconnectAttempts = 0;
                resolvePromise();
            });
            this.ws.on("message", (data) => {
                try {
                    const trade = JSON.parse(data.toString());
                    const price = parseFloat(trade.p);
                    const timestamp = Date.now();
                    this.prices.push({ timestamp, price });
                    // Храним 10 минут данных
                    const cutoff = timestamp - 600000;
                    this.prices = this.prices.filter(p => p.timestamp > cutoff);
                }
                catch (e) { }
            });
            this.ws.on("error", reject);
            this.ws.on("close", () => {
                if (this.reconnectAttempts < 10) {
                    this.reconnectAttempts++;
                    setTimeout(() => this.connect(), 5000);
                }
            });
        });
    }
    getCurrentPrice() {
        if (this.prices.length === 0)
            return null;
        return this.prices[this.prices.length - 1].price;
    }
    // Моментум:  изменение цены за период
    calculateMomentum(windowSeconds) {
        if (this.prices.length < 2)
            return null;
        const now = Date.now();
        const cutoff = now - windowSeconds * 1000;
        const pastPrices = this.prices.filter(p => p.timestamp <= cutoff);
        if (pastPrices.length === 0)
            return null;
        const pastPrice = pastPrices[pastPrices.length - 1].price;
        const currentPrice = this.prices[this.prices.length - 1].price;
        return ((currentPrice - pastPrice) / pastPrice) * 100;
    }
    // Волатильность: стандартное отклонение цены
    calculateVolatility(windowSeconds) {
        const now = Date.now();
        const cutoff = now - windowSeconds * 1000;
        const recentPrices = this.prices.filter(p => p.timestamp > cutoff);
        if (recentPrices.length < 10)
            return null;
        const prices = recentPrices.map(p => p.price);
        const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
        const variance = prices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / prices.length;
        return (Math.sqrt(variance) / mean) * 100;
    }
    // Тренд: сравниваем несколько периодов
    calculateTrend() {
        const short = this.calculateMomentum(30); // 30 сек
        const medium = this.calculateMomentum(120); // 2 мин
        let direction = "NEUTRAL";
        if (short !== null && medium !== null) {
            if (short > 0 && medium > 0)
                direction = "STRONG_UP";
            else if (short < 0 && medium < 0)
                direction = "STRONG_DOWN";
            else if (short > 0)
                direction = "WEAK_UP";
            else if (short < 0)
                direction = "WEAK_DOWN";
        }
        return { short, medium, direction };
    }
    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}
// ============== 15-MIN MARKET CALCULATOR ==============
class MarketCalculator {
    static get15MinTimestamps() {
        const now = Math.floor(Date.now() / 1000);
        const minutes = Math.floor((now % 3600) / 60);
        const currentSlot = Math.floor(minutes / 15) * 15;
        const hourStart = now - (now % 3600);
        const currentTimestamp = hourStart + currentSlot * 60;
        const nextTimestamp = currentTimestamp + 15 * 60;
        return { current: currentTimestamp, next: nextTimestamp };
    }
    static formatSlug(asset, timestamp) {
        return `${asset.toLowerCase()}-updown-15m-${timestamp}`;
    }
    static getTimeLeft(endTimestamp) {
        const now = Math.floor(Date.now() / 1000);
        const secondsLeft = endTimestamp + 15 * 60 - now;
        if (secondsLeft <= 0)
            return "Истёк";
        const minutes = Math.floor(secondsLeft / 60);
        const seconds = secondsLeft % 60;
        return `${minutes}м ${seconds}с`;
    }
}
class GammaApiClient {
    constructor(host) {
        this.host = host;
    }
    async getMarketBySlug(slug) {
        try {
            const res = await fetch(`${this.host}/markets/slug/${slug}`);
            if (!res.ok)
                return null;
            const m = await res.json();
            let tokenIds = [];
            try {
                tokenIds = typeof m.clobTokenIds === "string"
                    ? JSON.parse(m.clobTokenIds)
                    : m.clobTokenIds || [];
            }
            catch { }
            let prices = [0.5, 0.5];
            try {
                prices = typeof m.outcomePrices === "string"
                    ? JSON.parse(m.outcomePrices).map((p) => parseFloat(p))
                    : m.outcomePrices?.map((p) => parseFloat(p)) || [0.5, 0.5];
            }
            catch { }
            const timestampMatch = slug.match(/(\d{10})$/);
            const endTimestamp = timestampMatch ? parseInt(timestampMatch[1]) : 0;
            return {
                id: m.id,
                question: m.question,
                slug: m.slug,
                conditionId: m.conditionId,
                upTokenId: tokenIds[0] || "",
                downTokenId: tokenIds[1] || "",
                upPrice: prices[0] || 0.5,
                downPrice: prices[1] || 0.5,
                endTimestamp,
                active: m.active && !m.closed,
                minimumTickSize: m.minimumTickSize || "0.01",
                negRisk: m.negRisk || false,
            };
        }
        catch {
            return null;
        }
    }
    async getCurrentMarket(asset) {
        const { current, next } = MarketCalculator.get15MinTimestamps();
        const currentSlug = MarketCalculator.formatSlug(asset, current);
        let market = await this.getMarketBySlug(currentSlug);
        if (market && market.active)
            return market;
        const nextSlug = MarketCalculator.formatSlug(asset, next);
        return await this.getMarketBySlug(nextSlug);
    }
}
class PolymarketService {
    constructor(config) {
        this.config = config;
        this.creds = null;
        this.initialized = false;
        const signer = new wallet_1.Wallet(config.privateKey);
        this.clobClient = new clob_client_1.ClobClient(config.polymarketHost, config.chainId, signer);
        this.gammaClient = new GammaApiClient(config.gammaApiHost);
    }
    async initialize() {
        console.log("🔑 Инициализация API...");
        try {
            this.creds = await this.clobClient.createOrDeriveApiKey();
            if (!this.creds) {
                throw new Error("Не удалось получить API ключи");
            }
            console.log("✅ API ключи получены");
            const signer = new wallet_1.Wallet(this.config.privateKey);
            this.clobClient = new clob_client_1.ClobClient(this.config.polymarketHost, this.config.chainId, signer, this.creds, this.config.signatureType, this.config.funderAddress);
            // Проверяем соединение
            try {
                await this.clobClient.isOrderScoring();
                console.log("✅ Соединение с сервером установлено");
            }
            catch (err) {
                console.warn("⚠️ Не удалось проверить соединение с сервером:", err);
            }
            this.initialized = true;
            console.log("✅ Инициализация завершена успешно");
        }
        catch (error) {
            console.error("❌ Ошибка инициализации API:", error);
            throw new Error(`Не удалось инициализировать API: ${error}`);
        }
    }
    async getMarketPrices() {
        const market = await this.gammaClient.getCurrentMarket(this.config.asset);
        if (!market) {
            return {
                upPrice: 0.5, downPrice: 0.5, found: false,
                question: "Рынок не найден", timeLeft: "",
                upTokenId: "", downTokenId: "", slug: "",
                marketBias: "NEUTRAL",
            };
        }
        const timeLeft = MarketCalculator.getTimeLeft(market.endTimestamp);
        // Определяем bias рынка
        let marketBias = "NEUTRAL";
        if (market.upPrice > 0.52)
            marketBias = "UP";
        else if (market.downPrice > 0.52)
            marketBias = "DOWN";
        return {
            upPrice: market.upPrice,
            downPrice: market.downPrice,
            found: true,
            question: market.question,
            timeLeft,
            upTokenId: market.upTokenId,
            downTokenId: market.downTokenId,
            slug: market.slug,
            marketBias,
            minimumTickSize: market.minimumTickSize,
            negRisk: market.negRisk,
        };
    }
    async placeBet(tokenId, price, size, tickSize = "0.01", negRisk = false) {
        if (!this.initialized || !this.creds) {
            return {
                success: false,
                error: "API не инициализирован"
            };
        }
        try {
            console.log(`📝 Размещение ордера:`);
            console.log(`   Token: ${tokenId.substring(0, 20)}...`);
            console.log(`   Цена: ${price} USDC`);
            console.log(`   Размер: ${size} USDC`);
            console.log(`   TickSize: ${tickSize}, NegRisk: ${negRisk}`);
            const result = await this.clobClient.createAndPostOrder({ tokenID: tokenId, price, side: clob_client_1.Side.BUY, size }, { tickSize: tickSize, negRisk }, clob_client_1.OrderType.GTC, false, false);
            if (result && result.orderID) {
                console.log(`✅ Ордер размещён успешно! OrderID: ${result.orderID}`);
                return {
                    success: true,
                    orderId: result.orderID
                };
            }
            else if (result && result.error) {
                console.error(`❌ Ошибка размещения ордера: ${result.error}`);
                return {
                    success: false,
                    error: result.error
                };
            }
            else {
                console.warn(`⚠️ Неизвестный ответ от API:`, result);
                return {
                    success: false,
                    error: "Неизвестный ответ от API"
                };
            }
        }
        catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            console.error(`❌ Исключение при размещении ордера:`, errorMsg);
            return {
                success: false,
                error: errorMsg
            };
        }
    }
    async getBalance() {
        if (!this.initialized || !this.creds) {
            console.warn("⚠️ Невозможно получить баланс: API не инициализирован");
            return null;
        }
        try {
            const balances = await this.clobClient.getBalanceAllowance();
            if (balances && balances.balance) {
                const usdcBalance = parseFloat(balances.balance);
                console.log(`💰 Баланс USDC: ${usdcBalance.toFixed(2)}`);
                return usdcBalance;
            }
            return null;
        }
        catch (error) {
            console.error("❌ Ошибка при получении баланса:", error);
            return null;
        }
    }
}
class ImprovedStrategy {
    constructor(priceFeed, polymarket, config) {
        this.priceFeed = priceFeed;
        this.polymarket = polymarket;
        this.config = config;
    }
    async analyze() {
        const price = this.priceFeed.getCurrentPrice();
        const momentum = this.priceFeed.calculateMomentum(this.config.momentumWindowSeconds);
        const volatility = this.priceFeed.calculateVolatility(60);
        const trend = this.priceFeed.calculateTrend();
        const marketPrices = await this.polymarket.getMarketPrices();
        // Базовый результат
        const result = {
            price, momentum, volatility, trend,
            direction: "NEUTRAL",
            confidence: 0,
            realProbability: 0.5,
            marketPrices,
            edge: 0,
            shouldTrade: false,
            reason: "",
        };
        if (momentum === null) {
            result.reason = "Недостаточно данных";
            return result;
        }
        // ========== УЛУЧШЕННЫЙ РАСЧЁТ ВЕРОЯТНОСТИ ==========
        const threshold = this.config.momentumThresholdPercent;
        let confidence = 0;
        let direction = "NEUTRAL";
        // 1.Базовый сигнал от моментума
        if (Math.abs(momentum) > threshold) {
            direction = momentum > 0 ? "UP" : "DOWN";
            confidence += 0.3;
        }
        // 2.Усиление от тренда
        if (trend.direction === "STRONG_UP" && direction === "UP") {
            confidence += 0.2;
        }
        else if (trend.direction === "STRONG_DOWN" && direction === "DOWN") {
            confidence += 0.2;
        }
        // 3.Согласие с рынком (contrarian или confirmation)
        if (marketPrices.marketBias === direction && direction !== "NEUTRAL") {
            // Рынок согласен — небольшое подтверждение
            confidence += 0.1;
        }
        else if (marketPrices.marketBias !== "NEUTRAL" && marketPrices.marketBias !== direction) {
            // Рынок не согласен — либо мы умнее, либо ошибаемся
            // Не добавляем и не убавляем
        }
        // 4.Волатильность (высокая = больше возможностей)
        if (volatility !== null && volatility > 0.05) {
            confidence += 0.1;
        }
        // Финальная вероятность
        let realProbability = 0.5;
        if (direction !== "NEUTRAL") {
            realProbability = 0.5 + confidence * 0.35; // Max ~0.67
            realProbability = Math.min(0.75, Math.max(0.5, realProbability));
        }
        // Edge расчёт
        let marketProb = 0.5;
        if (direction === "UP")
            marketProb = marketPrices.upPrice;
        else if (direction === "DOWN")
            marketProb = marketPrices.downPrice;
        const edge = (realProbability - marketProb) * 100;
        // Решение о торговле
        const shouldTrade = edge >= this.config.minEdgePercent &&
            direction !== "NEUTRAL" &&
            marketPrices.found &&
            confidence >= 0.3;
        let reason = "";
        if (!marketPrices.found)
            reason = "Рынок не найден";
        else if (direction === "NEUTRAL")
            reason = `Моментум ${momentum.toFixed(4)}% < порог ${threshold}%`;
        else if (confidence < 0.3)
            reason = `Низкая уверенность ${(confidence * 100).toFixed(0)}%`;
        else if (edge < this.config.minEdgePercent)
            reason = `Edge ${edge.toFixed(2)}% < мин ${this.config.minEdgePercent}%`;
        else
            reason = "✅ Сигнал! ";
        return {
            ...result,
            direction,
            confidence,
            realProbability,
            edge,
            shouldTrade,
            reason,
        };
    }
}
// ============== ГЛАВНЫЙ КЛАСС БОТА ==============
class ArbitrageBot {
    constructor(config) {
        this.config = config;
        this.running = false;
        this.lastTradeTime = 0;
        this.lastLog = 0;
        this.stats = { trades: 0, opportunities: 0, successfulOrders: 0, failedOrders: 0 };
        this.priceFeed = new BinancePriceFeed(config.asset);
        this.polymarket = new PolymarketService(config);
        this.strategy = new ImprovedStrategy(this.priceFeed, this.polymarket, config);
    }
    async start() {
        console.log(`
╔═══════���═══════════════════════════════════════════════════════╗
║  🤖 POLYMARKET ${this.config.asset.toUpperCase()} 15-MIN ARBITRAGE BOT v2          ║
╠═══════════════════════════════════════════════════════════════╣
║  Edge: ${this.config.minEdgePercent}% | Порог: ${this.config.momentumThresholdPercent}% | Окно: ${this.config.momentumWindowSeconds}s | Ставка: $${this.config.betSizeUsdc}  ║
╚═══════════════════════════════════════════════════════════════╝`);
        await this.priceFeed.connect();
        await this.polymarket.initialize();
        // Проверяем баланс (опционально)
        const balance = await this.polymarket.getBalance();
        if (balance !== null && balance < this.config.betSizeUsdc) {
            console.warn(`⚠️ ПРЕДУПРЕЖДЕНИЕ: Баланс (${balance.toFixed(2)} USDC) меньше размера ставки (${this.config.betSizeUsdc} USDC)`);
        }
        console.log("⏳ Накапливаем данные (60 сек)...");
        await this.sleep(60000);
        console.log("🚀 Бот запущен!\n");
        this.running = true;
        await this.mainLoop();
    }
    async mainLoop() {
        while (this.running) {
            try {
                const a = await this.strategy.analyze();
                const now = Date.now();
                if (now - this.lastLog >= 3000) {
                    this.printStatus(a);
                    this.lastLog = now;
                }
                if ((now - this.lastTradeTime) / 1000 < this.config.cooldownSeconds && this.lastTradeTime > 0) {
                    await this.sleep(1000);
                    continue;
                }
                if (a.shouldTrade) {
                    this.stats.opportunities++;
                    const tokenId = a.direction === "UP" ? a.marketPrices.upTokenId : a.marketPrices.downTokenId;
                    console.log(`\n🎯 ${a.direction} | Edge: ${a.edge.toFixed(2)}% | Уверенность: ${(a.confidence * 100).toFixed(0)}%`);
                    if (tokenId) {
                        const price = a.direction === "UP"
                            ? Math.min(a.marketPrices.upPrice + 0.01, 0.95)
                            : Math.min(a.marketPrices.downPrice + 0.01, 0.95);
                        const tickSize = a.marketPrices.minimumTickSize || "0.01";
                        const negRisk = a.marketPrices.negRisk || false;
                        const result = await this.polymarket.placeBet(tokenId, price, this.config.betSizeUsdc, tickSize, negRisk);
                        if (result.success) {
                            this.stats.successfulOrders++;
                            console.log(`✅ Ордер успешно размещён! ID: ${result.orderId}\n`);
                        }
                        else {
                            this.stats.failedOrders++;
                            console.error(`❌ Не удалось разместить ордер: ${result.error}\n`);
                        }
                        this.stats.trades++;
                        this.lastTradeTime = Date.now();
                    }
                }
                await this.sleep(1000);
            }
            catch (error) {
                console.error("❌", error);
                await this.sleep(5000);
            }
        }
    }
    printStatus(a) {
        const arrow = a.momentum !== null
            ? (a.momentum > 0 ? "📈" : a.momentum < 0 ? "📉" : "➡️") : "⏳";
        const trendIcon = a.trend.direction.includes("STRONG") ? "💪" :
            a.trend.direction.includes("WEAK") ? "〰️" : "➖";
        console.log(`
┌───────────────────────────────────────────────────────────────┐
│ ${arrow} ${this.config.asset.toUpperCase()}: $${a.price?.toFixed(2) || "N/A"}  Mom: ${a.momentum?.toFixed(4) || "N/A"}%  Vol: ${a.volatility?.toFixed(3) || "N/A"}%
│ ${trendIcon} Тренд: ${a.trend.direction}  (30s:  ${a.trend.short?.toFixed(4) || "N/A"}% | 2m: ${a.trend.medium?.toFixed(4) || "N/A"}%)
├───────────────────────────────────────────────────────────────┤
│ 🎰 ${a.marketPrices.slug || "N/A"}
│    UP: ${(a.marketPrices.upPrice * 100).toFixed(1)}%  DOWN: ${(a.marketPrices.downPrice * 100).toFixed(1)}%  ⏱️ ${a.marketPrices.timeLeft}  Bias: ${a.marketPrices.marketBias}
├───────────────────────────────────────────────────────────────┤
│ 🧠 ${a.direction} | Оценка: ${(a.realProbability * 100).toFixed(1)}% | Edge: ${a.edge.toFixed(2)}% | Уверенность: ${(a.confidence * 100).toFixed(0)}%
│ 💬 ${a.reason}
├───────────────────────────────────────────────────────────────┤
│ 📊 Возможностей: ${this.stats.opportunities} | Сделок: ${this.stats.trades} | ✅ Успешно: ${this.stats.successfulOrders} | ❌ Неудачно: ${this.stats.failedOrders}
└───────────────────────────────────────────────────────────────┘`);
    }
    stop() {
        console.log("\n🛑 Стоп");
        this.running = false;
        this.priceFeed.disconnect();
    }
    sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }
}
// ============== ЗАПУСК ==============
async function main() {
    const bot = new ArbitrageBot(botConfig);
    process.on("SIGINT", () => { bot.stop(); process.exit(0); });
    try {
        await bot.start();
    }
    catch (error) {
        console.error("Критическая ошибка:", error);
        process.exit(1);
    }
}
main();
