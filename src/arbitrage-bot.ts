/**
 * Polymarket 15-MIN Crypto Arbitrage Bot v2
 * С улучшенной стратегией
 */

import { ClobClient, Side, OrderType, Chain } from "@polymarket/clob-client";
import type { ApiKeyCreds } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import WebSocket from "ws";
import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";

dotenvConfig({ path: resolve(__dirname, "../.env") });

// ============== КОНФИГУРАЦИЯ ==============

interface StrategyConfig {
    mode: "CONSERVATIVE" | "BALANCED" | "AGGRESSIVE";
    
    // Основные параметры
    minEdgePercent: number;           // Мин. edge для основной ставки
    mainBetSize: number;              // Размер основной ставки USDC
    maxBetsPerMarket: number;         // Макс. ставок на один рынок
    
    // Хеджирование
    enableHedging: boolean;           // Включить умное хеджирование
    hedgePriceThreshold: number;      // Макс. цена для хеджа (0.20 = 20¢)
    hedgeBetSize: number;             // Размер хедж-ставки USDC
    hedgeOnlyWhenLosing: boolean;     // Хедж только если основная в минусе (будущая функция)
    
    // Тайминг
    cooldownSeconds: number;          // Пауза между ставками
    noTradeLastMinutes: number;       // Не торговать последние N минут периода
    
    // Риск-менеджмент
    maxDailyLoss: number;             // Стоп-лосс на день USDC
    maxConsecutiveLosses: number;     // Стоп после N проигрышей подряд
}

interface BotConfig {
    polymarketHost: string;
    gammaApiHost: string;
    chainId: Chain;
    privateKey: string;
    funderAddress: string;
    signatureType: 0 | 1;
    momentumWindowSeconds: number;
    momentumThresholdPercent: number;
    asset: "btc" | "eth" | "sol" | "xrp";
    strategy: StrategyConfig;
    simulationMode: boolean;           // Режим симуляции (без реальных ставок)
}

const botConfig: BotConfig = {
    polymarketHost: "https://clob.polymarket.com",
    gammaApiHost: "https://gamma-api.polymarket.com",
    chainId: 137 as Chain,
    privateKey: process.env.PRIVATE_KEY || "",
    funderAddress: process.env.FUNDER_ADDRESS || "",
    signatureType: 1,
    
    momentumWindowSeconds: 60,         // Окно анализа
    momentumThresholdPercent: 0.05,   // Порог моментума
    
    asset: "btc",
    
    simulationMode: true,              // ⚠️ РЕЖИМ СИМУЛЯЦИИ: измените на false для реальных ставок
    
    // ========== НОВАЯ СТРАТЕГИЯ: SMART HEDGING + HIGH EDGE ==========
    strategy: {
        mode: "BALANCED",
        
        // Основные параметры
        minEdgePercent: 5.0,
        mainBetSize: 15,
        maxBetsPerMarket: 2,  // 1 основная + 1 хедж
        
        // Хеджирование
        enableHedging: true,
        hedgePriceThreshold: 0.20,  // Хедж только если цена < 20¢
        hedgeBetSize: 7,
        hedgeOnlyWhenLosing: false,
        
        // Тайминг
        cooldownSeconds: 60,
        noTradeLastMinutes: 2,  // Не торговать последние 2 мин
        
        // Риск-менеджмент
        maxDailyLoss: 50,
        maxConsecutiveLosses: 5,
    },
};

// ============== BINANCE PRICE FEED ==============

interface PricePoint {
    timestamp: number;
    price: number;
}

class BinancePriceFeed {
    private ws: WebSocket | null = null;
    private prices: PricePoint[] = [];
    private wsUrl:  string;
    private reconnectAttempts = 0;

    constructor(asset: string = "btc") {
        const symbol = asset.toLowerCase() + "usdt";
        this.wsUrl = `wss://stream.binance.com:9443/ws/${symbol}@trade`;
    }

    async connect(): Promise<void> {
        return new Promise((resolvePromise, reject) => {
            this.ws = new WebSocket(this.wsUrl);

            this.ws.on("open", () => {
                console.log(`✅ Binance WebSocket подключён`);
                this.reconnectAttempts = 0;
                resolvePromise();
            });

            this.ws.on("message", (data:  WebSocket.Data) => {
                try {
                    const trade = JSON.parse(data.toString());
                    const price = parseFloat(trade.p);
                    const timestamp = Date.now();
                    this.prices.push({ timestamp, price });

                    // Храним 10 минут данных
                    const cutoff = timestamp - 600000;
                    this.prices = this.prices.filter(p => p.timestamp > cutoff);
                } catch (e) {}
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

    getCurrentPrice(): number | null {
        if (this.prices.length === 0) return null;
        return this.prices[this.prices.length - 1].price;
    }

    // Моментум:  изменение цены за период
    calculateMomentum(windowSeconds: number): number | null {
        if (this.prices.length < 2) return null;

        const now = Date.now();
        const cutoff = now - windowSeconds * 1000;

        const pastPrices = this.prices.filter(p => p.timestamp <= cutoff);
        if (pastPrices.length === 0) return null;

        const pastPrice = pastPrices[pastPrices.length - 1].price;
        const currentPrice = this.prices[this.prices.length - 1].price;

        return ((currentPrice - pastPrice) / pastPrice) * 100;
    }

    // Волатильность: стандартное отклонение цены
    calculateVolatility(windowSeconds: number): number | null {
        const now = Date.now();
        const cutoff = now - windowSeconds * 1000;
        const recentPrices = this.prices.filter(p => p.timestamp > cutoff);

        if (recentPrices.length < 10) return null;

        const prices = recentPrices.map(p => p.price);
        const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
        const variance = prices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / prices.length;
        
        return (Math.sqrt(variance) / mean) * 100;
    }

    // Тренд: сравниваем несколько периодов
    calculateTrend(): { short: number | null; medium: number | null; direction: string } {
        const short = this.calculateMomentum(30);  // 30 сек
        const medium = this.calculateMomentum(120); // 2 мин

        let direction = "NEUTRAL";
        if (short !== null && medium !== null) {
            if (short > 0 && medium > 0) direction = "STRONG_UP";
            else if (short < 0 && medium < 0) direction = "STRONG_DOWN";
            else if (short > 0) direction = "WEAK_UP";
            else if (short < 0) direction = "WEAK_DOWN";
        }

        return { short, medium, direction };
    }

    disconnect(): void {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}

// ============== 15-MIN MARKET CALCULATOR ==============

class MarketCalculator {
    static get15MinTimestamps(): { current: number; next: number } {
        const now = Math.floor(Date.now() / 1000);
        const minutes = Math.floor((now % 3600) / 60);
        const currentSlot = Math.floor(minutes / 15) * 15;
        
        const hourStart = now - (now % 3600);
        const currentTimestamp = hourStart + currentSlot * 60;
        const nextTimestamp = currentTimestamp + 15 * 60;
        
        return { current: currentTimestamp, next:  nextTimestamp };
    }

    static formatSlug(asset: string, timestamp: number): string {
        return `${asset.toLowerCase()}-updown-15m-${timestamp}`;
    }

    static getTimeLeft(endTimestamp: number): string {
        const now = Math.floor(Date.now() / 1000);
        const secondsLeft = endTimestamp + 15 * 60 - now;
        
        if (secondsLeft <= 0) return "Истёк";
        
        const minutes = Math.floor(secondsLeft / 60);
        const seconds = secondsLeft % 60;
        return `${minutes}м ${seconds}с`;
    }
}

// ============== GAMMA API CLIENT ==============

interface Market15m {
    id:  string;
    question: string;
    slug: string;
    conditionId: string;
    upTokenId: string;
    downTokenId: string;
    upPrice: number;
    downPrice: number;
    endTimestamp: number;
    active: boolean;
}

class GammaApiClient {
    constructor(private host: string) {}

    async getMarketBySlug(slug:  string): Promise<Market15m | null> {
        try {
            const res = await fetch(`${this.host}/markets/slug/${slug}`);
            if (!res.ok) return null;

            const m = await res.json() as any;

            let tokenIds:  string[] = [];
            try {
                tokenIds = typeof m.clobTokenIds === "string"
                    ? JSON.parse(m.clobTokenIds)
                    : m.clobTokenIds || [];
            } catch {}

            let prices: number[] = [0.5, 0.5];
            try {
                prices = typeof m.outcomePrices === "string"
                    ? JSON.parse(m.outcomePrices).map((p: string) => parseFloat(p))
                    : m.outcomePrices?.map((p: string) => parseFloat(p)) || [0.5, 0.5];
            } catch {}

            const timestampMatch = slug.match(/(\d{10})$/);
            const endTimestamp = timestampMatch ? parseInt(timestampMatch[1]) : 0;

            return {
                id: m.id,
                question: m.question,
                slug: m.slug,
                conditionId: m.conditionId,
                upTokenId: tokenIds[0] || "",
                downTokenId: tokenIds[1] || "",
                upPrice:  prices[0] || 0.5,
                downPrice: prices[1] || 0.5,
                endTimestamp,
                active: m.active && ! m.closed,
            };
        } catch {
            return null;
        }
    }

    async getCurrentMarket(asset: string): Promise<Market15m | null> {
        const { current, next } = MarketCalculator.get15MinTimestamps();
        
        const currentSlug = MarketCalculator.formatSlug(asset, current);
        let market = await this.getMarketBySlug(currentSlug);
        
        if (market && market.active) return market;

        const nextSlug = MarketCalculator.formatSlug(asset, next);
        return await this.getMarketBySlug(nextSlug);
    }
}

// ============== POLYMARKET SERVICE ==============

interface MarketPrices {
    upPrice: number;
    downPrice: number;
    found: boolean;
    question: string;
    timeLeft: string;
    upTokenId: string;
    downTokenId: string;
    slug: string;
    marketBias: "UP" | "DOWN" | "NEUTRAL";
}

class PolymarketService {
    private clobClient: ClobClient;
    private gammaClient: GammaApiClient;
    private creds: ApiKeyCreds | null = null;

    constructor(private config: BotConfig) {
        const signer = new Wallet(config.privateKey);
        this.clobClient = new ClobClient(config.polymarketHost, config.chainId, signer);
        this.gammaClient = new GammaApiClient(config.gammaApiHost);
    }

    async initialize(): Promise<void> {
        console.log("🔑 Инициализация...");
        try {
            this.creds = await this.clobClient.createOrDeriveApiKey();
        } catch {}

        if (this.creds) {
            const signer = new Wallet(this.config.privateKey);
            this.clobClient = new ClobClient(
                this.config.polymarketHost,
                this.config.chainId,
                signer,
                this.creds,
                this.config.signatureType,
                this.config.funderAddress
            );
        }
        console.log("✅ Готово");
    }

    async getMarketPrices(): Promise<MarketPrices> {
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
        let marketBias:  "UP" | "DOWN" | "NEUTRAL" = "NEUTRAL";
        if (market.upPrice > 0.52) marketBias = "UP";
        else if (market.downPrice > 0.52) marketBias = "DOWN";

        return {
            upPrice: market.upPrice,
            downPrice: market.downPrice,
            found: true,
            question: market.question,
            timeLeft,
            upTokenId: market.upTokenId,
            downTokenId:  market.downTokenId,
            slug:  market.slug,
            marketBias,
        };
    }

    async placeBet(tokenId: string, price: number, size: number): Promise<any> {
        if (!this.creds) throw new Error("No API key");

        console.log(`📝 Ставка:  ${tokenId.substring(0, 20)}...@ ${price} x ${size} USDC`);

        return await this.clobClient.createAndPostOrder(
            { tokenID: tokenId, price, side: Side.BUY, size },
            { tickSize: "0.01" as any, negRisk: false },
            OrderType.GTC, false, false
        );
    }
}

// ============== УЛУЧШЕННАЯ СТРАТЕГИЯ ==============

interface MarketPosition {
    slug: string;
    mainBet: {
        direction: "UP" | "DOWN";
        price: number;
        size: number;
        timestamp: number;
    } | null;
    hedgeBet: {
        direction: "UP" | "DOWN";
        price: number;
        size: number;
        timestamp: number;
    } | null;
    totalBets: number;
}

interface TradeDecision {
    action: "BET" | "SKIP";
    type?: "MAIN" | "HEDGE";
    direction?: "UP" | "DOWN";
    size?: number;
    reason: string;
}

interface Scenarios {
    ifMainWins: {
        payout: number;
        profit: number;
        roi: number;
    };
    ifMainLoses: {
        payout: number;
        profit: number;
        roi: number;
    };
}

interface AnalysisResult {
    price: number | null;
    momentum: number | null;
    volatility: number | null;
    trend:  { short: number | null; medium: number | null; direction: string };
    direction: "UP" | "DOWN" | "NEUTRAL";
    confidence: number;
    realProbability: number;
    marketPrices: MarketPrices;
    edge: number;
    shouldTrade: boolean;
    reason: string;
}

class ImprovedStrategy {
    private positions = new Map<string, MarketPosition>();
    private dailyLoss = 0;
    private consecutiveLosses = 0;
    private dailyLossResetTime = 0;

    constructor(
        private priceFeed: BinancePriceFeed,
        private polymarket: PolymarketService,
        private config: BotConfig
    ) {
        this.resetDailyStats();
    }

    private resetDailyStats(): void {
        const now = Date.now();
        const today = new Date(now);
        today.setHours(0, 0, 0, 0);
        this.dailyLossResetTime = today.getTime() + 24 * 60 * 60 * 1000;
    }

    private checkDailyReset(): void {
        const now = Date.now();
        if (now >= this.dailyLossResetTime) {
            this.dailyLoss = 0;
            this.resetDailyStats();
        }
    }

    private parseTimeLeft(timeLeft: string): number {
        // Парсит "8м 45с" -> 8.75 минут
        const minutesMatch = timeLeft.match(/(\d+)м/);
        const secondsMatch = timeLeft.match(/(\d+)с/);
        
        const minutes = minutesMatch ? parseInt(minutesMatch[1]) : 0;
        const seconds = secondsMatch ? parseInt(secondsMatch[1]) : 0;
        
        return minutes + seconds / 60;
    }

    async evaluateTrade(analysis: AnalysisResult): Promise<TradeDecision> {
        const { marketPrices, direction, edge, confidence } = analysis;
        const slug = marketPrices.slug;

        // Проверка риск-менеджмента
        this.checkDailyReset();
        if (this.dailyLoss >= this.config.strategy.maxDailyLoss) {
            return { action: "SKIP", reason: `Достигнут дневной лимит убытков: $${this.dailyLoss.toFixed(2)}` };
        }
        if (this.consecutiveLosses >= this.config.strategy.maxConsecutiveLosses) {
            return { action: "SKIP", reason: `Достигнут лимит проигрышей подряд: ${this.consecutiveLosses}` };
        }

        // Получаем или создаём позицию
        let position = this.positions.get(slug);
        if (!position) {
            position = { slug, mainBet: null, hedgeBet: null, totalBets: 0 };
            this.positions.set(slug, position);
        }

        // Проверка лимитов
        if (position.totalBets >= this.config.strategy.maxBetsPerMarket) {
            return { action: "SKIP", reason: "Лимит ставок на рынок" };
        }

        // Проверка времени (не торгуем в конце периода)
        const timeLeftMinutes = this.parseTimeLeft(marketPrices.timeLeft);
        if (timeLeftMinutes < this.config.strategy.noTradeLastMinutes) {
            return { action: "SKIP", reason: `Слишком мало времени: ${timeLeftMinutes}м` };
        }

        // ОСНОВНАЯ СТАВКА
        if (!position.mainBet && edge >= this.config.strategy.minEdgePercent && direction !== "NEUTRAL") {
            return {
                action: "BET",
                type: "MAIN",
                direction,
                size: this.config.strategy.mainBetSize,
                reason: `Основная ставка: edge ${edge.toFixed(1)}%, уверенность ${(confidence * 100).toFixed(0)}%`
            };
        }

        // ХЕДЖ-СТАВКА
        if (this.config.strategy.enableHedging && position.mainBet && !position.hedgeBet) {
            const oppositeDirection = position.mainBet.direction === "UP" ? "DOWN" : "UP";
            const oppositePrice = oppositeDirection === "UP" 
                ? marketPrices.upPrice 
                : marketPrices.downPrice;

            // Хедж только при низкой цене
            if (oppositePrice <= this.config.strategy.hedgePriceThreshold) {
                const potentialMultiplier = 1 / oppositePrice;
                return {
                    action: "BET",
                    type: "HEDGE",
                    direction: oppositeDirection,
                    size: this.config.strategy.hedgeBetSize,
                    reason: `Хедж: цена ${(oppositePrice * 100).toFixed(0)}¢, потенциал x${potentialMultiplier.toFixed(1)}`
                };
            }
        }

        return { action: "SKIP", reason: "Нет подходящих условий" };
    }

    recordBet(slug: string, type: "MAIN" | "HEDGE", direction: "UP" | "DOWN", price: number, size: number): void {
        let position = this.positions.get(slug);
        if (!position) {
            position = { slug, mainBet: null, hedgeBet: null, totalBets: 0 };
            this.positions.set(slug, position);
        }

        const bet = { direction, price, size, timestamp: Date.now() };
        
        if (type === "MAIN") {
            position.mainBet = bet;
        } else {
            position.hedgeBet = bet;
        }
        
        position.totalBets++;
    }

    calculateScenarios(slug: string, prices: MarketPrices): Scenarios | null {
        const position = this.positions.get(slug);
        if (!position || !position.mainBet) return null;

        const main = position.mainBet;
        const hedge = position.hedgeBet;

        const mainWinPayout = main.size / main.price;  // Выплата если основная выиграла
        const hedgeWinPayout = hedge ? hedge.size / hedge.price : 0;

        const totalInvested = main.size + (hedge?.size || 0);

        return {
            ifMainWins: {
                payout: mainWinPayout,
                profit: mainWinPayout - totalInvested,
                roi: ((mainWinPayout - totalInvested) / totalInvested) * 100
            },
            ifMainLoses: {
                payout: hedgeWinPayout,
                profit: hedgeWinPayout - totalInvested,
                roi: hedgeWinPayout > 0 ? ((hedgeWinPayout - totalInvested) / totalInvested) * 100 : -100
            }
        };
    }

    getPosition(slug: string): MarketPosition | null {
        return this.positions.get(slug) || null;
    }

    cleanupOldPositions(currentSlug: string): void {
        // Очищаем позиции для старых рынков
        const toDelete: string[] = [];
        for (const [slug, position] of this.positions.entries()) {
            if (slug !== currentSlug) {
                toDelete.push(slug);
            }
        }
        for (const slug of toDelete) {
            this.positions.delete(slug);
        }
    }

    getStats(): { totalPositions: number; mainBets: number; hedgeBets: number; dailyLoss: number; consecutiveLosses: number } {
        let mainBets = 0;
        let hedgeBets = 0;
        
        for (const position of this.positions.values()) {
            if (position.mainBet) mainBets++;
            if (position.hedgeBet) hedgeBets++;
        }

        return {
            totalPositions: this.positions.size,
            mainBets,
            hedgeBets,
            dailyLoss: this.dailyLoss,
            consecutiveLosses: this.consecutiveLosses
        };
    }

    async analyze(): Promise<AnalysisResult> {
        const price = this.priceFeed.getCurrentPrice();
        const momentum = this.priceFeed.calculateMomentum(this.config.momentumWindowSeconds);
        const volatility = this.priceFeed.calculateVolatility(60);
        const trend = this.priceFeed.calculateTrend();
        const marketPrices = await this.polymarket.getMarketPrices();

        // Базовый результат
        const result: AnalysisResult = {
            price, momentum, volatility, trend,
            direction:  "NEUTRAL",
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
        let direction:  "UP" | "DOWN" | "NEUTRAL" = "NEUTRAL";

        // 1.Базовый сигнал от моментума
        if (Math.abs(momentum) > threshold) {
            direction = momentum > 0 ? "UP" : "DOWN";
            confidence += 0.3;
        }

        // 2.Усиление от тренда
        if (trend.direction === "STRONG_UP" && direction === "UP") {
            confidence += 0.2;
        } else if (trend.direction === "STRONG_DOWN" && direction === "DOWN") {
            confidence += 0.2;
        }

        // 3.Согласие с рынком (contrarian или confirmation)
        if (marketPrices.marketBias === direction && direction !== "NEUTRAL") {
            // Рынок согласен — небольшое подтверждение
            confidence += 0.1;
        } else if (marketPrices.marketBias !== "NEUTRAL" && marketPrices.marketBias !== direction) {
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
        if (direction === "UP") marketProb = marketPrices.upPrice;
        else if (direction === "DOWN") marketProb = marketPrices.downPrice;

        const edge = (realProbability - marketProb) * 100;

        // Решение о торговле
        const shouldTrade = edge >= this.config.strategy.minEdgePercent && 
                           direction !== "NEUTRAL" && 
                           marketPrices.found &&
                           confidence >= 0.3;

        let reason = "";
        if (!marketPrices.found) reason = "Рынок не найден";
        else if (direction === "NEUTRAL") reason = `Моментум ${momentum.toFixed(4)}% < порог ${threshold}%`;
        else if (confidence < 0.3) reason = `Низкая уверенность ${(confidence * 100).toFixed(0)}%`;
        else if (edge < this.config.strategy.minEdgePercent) reason = `Edge ${edge.toFixed(2)}% < мин ${this.config.strategy.minEdgePercent}%`;
        else reason = "✅ Сигнал! ";

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
    private priceFeed: BinancePriceFeed;
    private polymarket: PolymarketService;
    private strategy:  ImprovedStrategy;
    private running = false;
    private lastTradeTime = 0;
    private lastLog = 0;
    private currentSlug = "";
    private stats = { 
        trades: 0, 
        opportunities: 0, 
        wins: 0, 
        losses: 0,
        mainBets: 0,
        hedgeBets: 0
    };

    constructor(private config: BotConfig) {
        this.priceFeed = new BinancePriceFeed(config.asset);
        this.polymarket = new PolymarketService(config);
        this.strategy = new ImprovedStrategy(this.priceFeed, this.polymarket, config);
    }

    async start(): Promise<void> {
        const cfg = this.config.strategy;
        const simMode = this.config.simulationMode ? "⚠️  СИМУЛЯЦИЯ" : "✅ РЕАЛЬНЫЕ СТАВКИ";
        console.log(`
╔═══════════════════════════════════════════════════════════╗
║  🤖 POLYMARKET ${this.config.asset.toUpperCase()} 15-MIN ARBITRAGE BOT v3          ║
╠═══════════════════════════════════════════════════════════╣
║  ${simMode.padEnd(30)}                          ║
║  Режим: ${cfg.mode.padEnd(12)} | Edge: ${cfg.minEdgePercent}% | Ставка: $${cfg.mainBetSize}    ║
║  Хедж: ${cfg.enableHedging ? "ВКЛ" : "ВЫКЛ"} (${(cfg.hedgePriceThreshold * 100).toFixed(0)}¢) | Размер: $${cfg.hedgeBetSize}                ║
║  Лимит рынок: ${cfg.maxBetsPerMarket} | Кулдаун: ${cfg.cooldownSeconds}с                    ║
╚═══════════════════════════════════════════════════════════╝`);

        await this.priceFeed.connect();
        await this.polymarket.initialize();

        console.log("⏳ Накапливаем данные (60 сек)...");
        await this.sleep(60000);

        console.log("🚀 Бот запущен!\n");
        this.running = true;
        await this.mainLoop();
    }

    private async mainLoop(): Promise<void> {
        while (this.running) {
            try {
                const a = await this.strategy.analyze();
                const now = Date.now();

                // Очищаем старые позиции при смене рынка
                if (this.currentSlug && this.currentSlug !== a.marketPrices.slug) {
                    this.strategy.cleanupOldPositions(a.marketPrices.slug);
                }
                this.currentSlug = a.marketPrices.slug;

                if (now - this.lastLog >= 3000) {
                    this.printStatus(a);
                    this.lastLog = now;
                }

                if ((now - this.lastTradeTime) / 1000 < this.config.strategy.cooldownSeconds && this.lastTradeTime > 0) {
                    await this.sleep(1000);
                    continue;
                }

                // Используем новую логику evaluateTrade
                const decision = await this.strategy.evaluateTrade(a);

                if (decision.action === "BET" && decision.direction && decision.size && decision.type) {
                    this.stats.opportunities++;
                    
                    const tokenId = decision.direction === "UP" 
                        ? a.marketPrices.upTokenId 
                        : a.marketPrices.downTokenId;
                    
                    const price = decision.direction === "UP"
                        ? a.marketPrices.upPrice
                        : a.marketPrices.downPrice;

                    console.log(`\n🎯 ${decision.type === "MAIN" ? "ОСНОВНАЯ" : "ХЕДЖ"} СТАВКА: ${decision.direction}`);
                    console.log(`   ${decision.reason}`);
                    console.log(`   Цена: ${(price * 100).toFixed(1)}¢ | Размер: $${decision.size}`);

                    // Записываем ставку в позицию
                    this.strategy.recordBet(
                        a.marketPrices.slug,
                        decision.type,
                        decision.direction,
                        price,
                        decision.size
                    );

                    if (decision.type === "MAIN") {
                        this.stats.mainBets++;
                    } else {
                        this.stats.hedgeBets++;
                    }

                    // Показываем сценарии если есть позиция
                    const scenarios = this.strategy.calculateScenarios(a.marketPrices.slug, a.marketPrices);
                    if (scenarios) {
                        console.log(`\n📈 Сценарии:`);
                        const position = this.strategy.getPosition(a.marketPrices.slug);
                        if (position && position.mainBet) {
                            console.log(`   Если ${position.mainBet.direction} выигрывает: ${scenarios.ifMainWins.profit >= 0 ? "+" : ""}$${scenarios.ifMainWins.profit.toFixed(2)} (${scenarios.ifMainWins.roi >= 0 ? "+" : ""}${scenarios.ifMainWins.roi.toFixed(1)}% ROI)`);
                            console.log(`   Если ${position.mainBet.direction === "UP" ? "DOWN" : "UP"} выигрывает: ${scenarios.ifMainLoses.profit >= 0 ? "+" : ""}$${scenarios.ifMainLoses.profit.toFixed(2)} (${scenarios.ifMainLoses.roi >= 0 ? "+" : ""}${scenarios.ifMainLoses.roi.toFixed(1)}% ROI)${scenarios.ifMainLoses.profit > 0 ? " ← Хедж окупается!" : ""}`);
                        }
                    }

                    // Реальная или симулированная ставка
                    if (!this.config.simulationMode && tokenId) {
                        await this.polymarket.placeBet(tokenId, Math.min(price + 0.01, 0.95), decision.size);
                        this.stats.trades++;
                        this.lastTradeTime = Date.now();
                        console.log(`   ✅ СТАВКА РАЗМЕЩЕНА\n`);
                    } else {
                        console.log(`   ⚠️ РЕЖИМ СИМУЛЯЦИИ (установите simulationMode: false для реальных ставок)\n`);
                    }
                } else if (decision.action === "SKIP" && a.shouldTrade) {
                    // Если есть торговый сигнал, но evaluateTrade отклонила
                    console.log(`\n⏭️  Пропуск: ${decision.reason}`);
                }

                await this.sleep(1000);
            } catch (error) {
                console.error("❌", error);
                await this.sleep(5000);
            }
        }
    }

    private printStatus(a: AnalysisResult): void {
        const arrow = a.momentum !== null
            ? (a.momentum > 0 ? "📈" : a.momentum < 0 ? "📉" : "➡️") :  "⏳";
        const trendIcon = a.trend.direction.includes("STRONG") ? "💪" : 
                         a.trend.direction.includes("WEAK") ? "〰️" : "➖";

        const stratStats = this.strategy.getStats();
        const position = this.strategy.getPosition(a.marketPrices.slug);

        let positionInfo = "";
        if (position && position.mainBet) {
            positionInfo = `\n│ 💰 Позиция:`;
            positionInfo += `\n│    └─ Основная: ${position.mainBet.direction} $${position.mainBet.size} @ ${(position.mainBet.price * 100).toFixed(0)}¢`;
            if (position.hedgeBet) {
                const potentialMultiplier = 1 / position.hedgeBet.price;
                positionInfo += `\n│    └─ Хедж: ${position.hedgeBet.direction} $${position.hedgeBet.size} @ ${(position.hedgeBet.price * 100).toFixed(0)}¢ (потенциал x${potentialMultiplier.toFixed(1)})`;
            }
        }

        console.log(`
┌─────────────────────────────────────────────────────────────┐
│ ${arrow} ${this.config.asset.toUpperCase()}: $${a.price?.toFixed(2) || "N/A"}  Моментум: ${a.momentum?.toFixed(2) || "N/A"}%  Тренд: ${a.trend.direction}
├─────────────────────────────────────────────────────────────┤
│ 🎰 ${a.marketPrices.slug || "N/A"}
│    UP: ${(a.marketPrices.upPrice * 100).toFixed(0)}%  DOWN: ${(a.marketPrices.downPrice * 100).toFixed(0)}%  ⏱️ ${a.marketPrices.timeLeft}${positionInfo}
├─────────────────────────────────────────────────────────────┤
│ 🧠 Направление: ${a.direction} | Наш edge: ${a.edge.toFixed(1)}%
│ 💬 ${a.reason}
├─────────────────────────────────────────────────────────────┤
│ 📊 Основных: ${stratStats.mainBets} | Хеджей: ${stratStats.hedgeBets} | Возможностей: ${this.stats.opportunities}
└─────────────────────────────────────────────────────────────┘`);
    }

    stop(): void {
        console.log("\n🛑 Стоп");
        this.running = false;
        this.priceFeed.disconnect();
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(r => setTimeout(r, ms));
    }
}

// ============== ЗАПУСК ==============

async function main() {
    const bot = new ArbitrageBot(botConfig);
    process.on("SIGINT", () => { bot.stop(); process.exit(0); });

    try {
        await bot.start();
    } catch (error) {
        console.error("Критическая ошибка:", error);
        process.exit(1);
    }
}

main();
