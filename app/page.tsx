"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type TicketType = {
  id: string;
  name: string;
  shortName: string;
  cost: number;
  unlockLevel: number;
  maxLabel: string;
  accent: string;
  accent2: string;
  prizePool: number[];
  feature: string;
  multipliers: number[];
  specialChance: number;
};

type TopupPackage = {
  id: string;
  price: number;
  coins: number;
};

type EconomyConfig = {
  coinsPerToken: number;
  myrPerToken: number;
};

type Cell = { number: number; prize: number; multiplier: number; instant?: boolean };
type Ticket = {
  id: string;
  typeId: string;
  typeSnapshot?: TicketType;
  winning: number[];
  cells: Cell[];
  scratched: boolean[];
  settled: boolean;
  totalWin: number;
  createdAt: number;
};
type LogEntry = {
  t: number;
  k: "buy" | "win" | "daily" | "rescue" | "topup" | "developer";
  a: number;
  n?: string;
  packageId?: string;
  priceMyr?: number;
};
type Player = {
  coins: number;
  level: number;
  ticketsPlayed: number;
  selectedTicketId: string;
  bestWins: Record<string, number>;
  lastDaily: string;
  rescueAt: number;
  tutorialSeen: boolean;
  settings: { sound: boolean; vibration: boolean };
  totalSpent: number;
  totalWon: number;
  log: LogEntry[];
};

const SAVE_KEY = "lucky_save_v1";
const SESSION_KEY = "lucky_session_v1";
const ACCOUNTS_KEY = "lucky_accounts_v1";
const SCRATCH_FOIL_SRC = "/prismatic-scratch-foil.webp";
let scratchFoilImage: HTMLImageElement | null = null;

function prepareScratchFoil(onReady: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  if (!scratchFoilImage) {
    scratchFoilImage = new Image();
    scratchFoilImage.decoding = "async";
    scratchFoilImage.src = SCRATCH_FOIL_SRC;
  }
  if (scratchFoilImage.complete && scratchFoilImage.naturalWidth > 0) {
    onReady();
    return () => undefined;
  }
  scratchFoilImage.addEventListener("load", onReady, { once: true });
  return () => scratchFoilImage?.removeEventListener("load", onReady);
}

/** The game is gated by the existing device-local login flow. */
function hasLocalAccountSession(): boolean {
  try {
    const session = JSON.parse(localStorage.getItem(SESSION_KEY) || "null") as { u?: string } | null;
    if (!session?.u) return false;
    const accounts = JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || "{}") as Record<string, unknown>;
    return Boolean(accounts[session.u.toLowerCase()]);
  } catch {
    return false;
  }
}

/** Scope the save to the signed-in account (from /login.html) so separate
 *  accounts on one device keep separate progress. Guests use the bare key.
 *  Only ever called on the client (inside effects) — never during SSR. */
function gameSaveKey(): string {
  try {
    const raw = localStorage.getItem("lucky_session_v1");
    if (raw) {
      const s = JSON.parse(raw) as { u?: string };
      if (s && typeof s.u === "string" && s.u) return SAVE_KEY + "::" + s.u.toLowerCase();
    }
  } catch { /* fall through to guest key */ }
  return SAVE_KEY;
}
const TICKET_TYPES: TicketType[] = [
  { id: "starter_100x", name: "100X Starter", shortName: "100X", cost: 500, unlockLevel: 1, maxLabel: "100X", accent: "#d743ff", accent2: "#7c2eff", prizePool: [50, 100, 250, 500, 750, 1500], feature: "经典对号中奖", multipliers: [2, 5, 10], specialChance: 0.06 },
  { id: "gem_rush", name: "Gem Rush", shortName: "GEM", cost: 1000, unlockLevel: 4, maxLabel: "250X", accent: "#24e4d1", accent2: "#0c8295", prizePool: [100, 250, 500, 1000, 2000, 3500], feature: "更多倍数宝石", multipliers: [2, 5, 10], specialChance: 0.16 },
  { id: "neon_vault", name: "Neon Vault", shortName: "VAULT", cost: 2500, unlockLevel: 8, maxLabel: "500X", accent: "#6c72ff", accent2: "#30238f", prizePool: [250, 500, 1000, 2500, 5000, 10000], feature: "高额金库奖金", multipliers: [2, 5, 10], specialChance: 0.2 },
  { id: "crown_2000x", name: "2000X Crown", shortName: "CROWN", cost: 5000, unlockLevel: 15, maxLabel: "2000X", accent: "#ffb648", accent2: "#9d3b25", prizePool: [500, 1000, 2500, 5000, 10000, 25000], feature: "稀有皇冠 巨额奖金", multipliers: [2, 5, 10, 100], specialChance: 0.24 },
];

const CONFIG_KEY = "lucky_config_v1";
const CONFIG_VERSION_KEY = "lucky_config_version_v1";
const CONFIG_API = "/api/config";
const CONFIG_CHANNEL = "lucky-config";
let acceptedCloudConfigVersion = -1;
let cloudConfigRequestSequence = 0;
type Odds = { m0: number; m1: number; m2: number; m3: number };
type GameConfig = { types: TicketType[]; odds: Odds; multiplierMinLevel: number; topups: TopupPackage[]; economy: EconomyConfig };
const DEFAULT_ODDS: Odds = { m0: 0.45, m1: 0.33, m2: 0.16, m3: 0.06 };
const DEFAULT_TOPUPS: TopupPackage[] = [
  { id: "starter", price: 5, coins: 250 },
  { id: "value", price: 10, coins: 500 },
  { id: "popular", price: 20, coins: 1000 },
  { id: "mega", price: 50, coins: 2500 },
];
const LEGACY_DEFAULT_TOPUPS: TopupPackage[] = [
  { id: "starter", price: 4.9, coins: 5000 },
  { id: "value", price: 9.9, coins: 12000 },
  { id: "popular", price: 19.9, coins: 30000 },
  { id: "mega", price: 49.9, coins: 80000 },
];
const DEFAULT_ECONOMY: EconomyConfig = { coinsPerToken: 50, myrPerToken: 1 };
const DEFAULT_CONFIG: GameConfig = { types: TICKET_TYPES, odds: DEFAULT_ODDS, multiplierMinLevel: 3, topups: DEFAULT_TOPUPS, economy: DEFAULT_ECONOMY };

/** Converts the operator document into the runtime shape. Any bad field falls back to the built-in default. */
function normaliseConfig(value: unknown): GameConfig {
  try {
    const parsed = (value || {}) as Partial<{ tiers: unknown[]; odds: Partial<Odds>; multiplierMinLevel: number; topups: unknown; economy: Partial<EconomyConfig> }>;
    const positives = (value: unknown, min: number) =>
      Array.isArray(value) ? value.map(Number).filter((entry) => Number.isFinite(entry) && entry >= min) : [];

    const types = Array.isArray(parsed.tiers) && parsed.tiers.length
      ? parsed.tiers.map((entry, index) => {
          const tier = (entry || {}) as Partial<TicketType>;
          const base = TICKET_TYPES.find((type) => type.id === tier.id) || TICKET_TYPES[index] || TICKET_TYPES[0];
          const prizePool = positives(tier.prizePool, 0.01);
          const multipliers = positives(tier.multipliers, 1);
          const cost = Number(tier.cost);
          const unlockLevel = Number(tier.unlockLevel);
          const specialChance = Number(tier.specialChance);
          return {
            ...base,
            id: typeof tier.id === "string" && tier.id ? tier.id : base.id,
            name: typeof tier.name === "string" && tier.name ? tier.name : base.name,
            shortName: typeof tier.shortName === "string" && tier.shortName ? tier.shortName : base.shortName,
            maxLabel: typeof tier.maxLabel === "string" && tier.maxLabel ? tier.maxLabel : base.maxLabel,
            feature: typeof tier.feature === "string" && tier.feature ? tier.feature : base.feature,
            accent: /^#[0-9a-f]{6}$/i.test(String(tier.accent)) ? String(tier.accent) : base.accent,
            accent2: /^#[0-9a-f]{6}$/i.test(String(tier.accent2)) ? String(tier.accent2) : base.accent2,
            cost: Number.isFinite(cost) && cost > 0 ? Math.floor(cost) : base.cost,
            unlockLevel: Number.isFinite(unlockLevel) && unlockLevel >= 1 ? Math.floor(unlockLevel) : base.unlockLevel,
            prizePool: prizePool.length ? prizePool : base.prizePool,
            multipliers: multipliers.length ? multipliers : base.multipliers,
            specialChance: Number.isFinite(specialChance) && specialChance >= 0 && specialChance <= 1 ? specialChance : base.specialChance,
          };
        })
      : TICKET_TYPES;

    const raw0 = Number(parsed.odds?.m0), raw1 = Number(parsed.odds?.m1);
    const raw2 = Number(parsed.odds?.m2), raw3 = Number(parsed.odds?.m3);
    const candidate = [raw0, raw1, raw2, raw3].map((value) => (Number.isFinite(value) && value >= 0 ? value : -1));
    const odds = candidate.every((value) => value >= 0) && candidate.some((value) => value > 0)
      ? { m0: candidate[0], m1: candidate[1], m2: candidate[2], m3: candidate[3] }
      : DEFAULT_ODDS;

    const minLevel = Number(parsed.multiplierMinLevel);
    const seenTopups = new Set<string>();
    const parsedTopups = Array.isArray(parsed.topups)
      ? parsed.topups.reduce<TopupPackage[]>((packages, entry) => {
          if (!entry || typeof entry !== "object" || packages.length >= 20) return packages;
          const raw = entry as Partial<TopupPackage>;
          const id = typeof raw.id === "string" ? raw.id.trim().toLowerCase() : "";
          const price = Number(raw.price);
          const coins = Number(raw.coins);
          if (!id || !/^[a-z0-9_-]{1,40}$/i.test(id) || seenTopups.has(id)) return packages;
          if (!Number.isFinite(price) || price < 0.01 || price > 1_000_000) return packages;
          if (!Number.isSafeInteger(coins) || coins < 1 || coins > 1_000_000_000) return packages;
          seenTopups.add(id);
          packages.push({ id, price: Math.round(price * 100) / 100, coins });
          return packages;
        }, [])
      : DEFAULT_TOPUPS;
    const isLegacyDefaultTopups = parsedTopups.length === LEGACY_DEFAULT_TOPUPS.length
      && parsedTopups.every((item, index) => {
        const legacy = LEGACY_DEFAULT_TOPUPS[index];
        return item.id === legacy.id && item.price === legacy.price && item.coins === legacy.coins;
      });
    const topups = isLegacyDefaultTopups ? DEFAULT_TOPUPS : parsedTopups;
    const rawCoinsPerToken = Number(parsed.economy?.coinsPerToken);
    const rawMyrPerToken = Number(parsed.economy?.myrPerToken);
    const economy = {
      coinsPerToken: Number.isSafeInteger(rawCoinsPerToken) && rawCoinsPerToken >= 1 && rawCoinsPerToken <= 1_000_000
        ? rawCoinsPerToken
        : DEFAULT_ECONOMY.coinsPerToken,
      myrPerToken: Number.isFinite(rawMyrPerToken) && rawMyrPerToken >= 0.01 && rawMyrPerToken <= 1_000_000
        ? Math.round(rawMyrPerToken * 100) / 100
        : DEFAULT_ECONOMY.myrPerToken,
    };
    return { types, odds, multiplierMinLevel: Number.isFinite(minLevel) && minLevel >= 1 ? Math.floor(minLevel) : 3, topups, economy };
  } catch {
    return DEFAULT_CONFIG;
  }
}

/** Reads the last-known cloud configuration cached by the manager/game. */
function loadConfig(): GameConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    return raw ? normaliseConfig(JSON.parse(raw)) : DEFAULT_CONFIG;
  } catch {
    return DEFAULT_CONFIG;
  }
}

/** Cloud config is authoritative; a cached copy keeps the game playable offline. */
async function fetchCloudConfig(): Promise<GameConfig | null> {
  const requestSequence = ++cloudConfigRequestSequence;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(CONFIG_API, { cache: "no-store", headers: { accept: "application/json" }, signal: controller.signal });
    if (!response.ok || !(response.headers.get("content-type") || "").includes("application/json")) return null;
    const payload = await response.json() as { config?: unknown; version?: unknown };
    if (!payload.config) return null;
    const version = Number(payload.version);
    if (!Number.isSafeInteger(version) || version < 0) return null;
    if (requestSequence !== cloudConfigRequestSequence || version < acceptedCloudConfigVersion) return null;
    acceptedCloudConfigVersion = version;
    const next = normaliseConfig(payload.config);
    try {
      localStorage.setItem(CONFIG_VERSION_KEY, String(version));
      localStorage.setItem(CONFIG_KEY, JSON.stringify(payload.config));
    } catch { /* cache unavailable */ }
    return next;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function resolveStartupConfig(): Promise<GameConfig> {
  const cached = loadConfig();
  return (await fetchCloudConfig()) || cached;
}

const DEFAULT_PLAYER: Player = {
  coins: 20000,
  level: 1,
  ticketsPlayed: 0,
  selectedTicketId: "starter_100x",
  bestWins: {},
  lastDaily: "",
  rescueAt: 0,
  tutorialSeen: false,
  settings: { sound: true, vibration: true },
  totalSpent: 0,
  totalWon: 0,
  log: [],
};

const LOG_MAX = 80;
const pushLog = (log: LogEntry[], entry: LogEntry): LogEntry[] => [entry, ...(Array.isArray(log) ? log : [])].slice(0, LOG_MAX);

const formatCoins = (value: number) => new Intl.NumberFormat("en-US").format(value);
const formatTokens = (coins: number, coinsPerToken: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(coins / coinsPerToken);
const randomFrom = <T,>(items: T[]) => items[Math.floor(Math.random() * items.length)];

function uniqueNumbers(count: number, min = 1, max = 60, blocked = new Set<number>()) {
  const values: number[] = [];
  while (values.length < count) {
    const value = Math.floor(Math.random() * (max - min + 1)) + min;
    if (!blocked.has(value) && !values.includes(value)) values.push(value);
  }
  return values;
}

/** Developer cheat overrides. Stored per-device under lucky_cheat_v1, only while dev mode is armed.
 *  rtp: target return-to-player percent (null = use the config's natural RTP). */
type Cheat = { forceMatch: number | null; forceMax: boolean; freeDraw: boolean; rtp: number | null };
const DEV_KEY = "lucky_dev_v1";
const CHEAT_KEY = "lucky_cheat_v1";
const DEFAULT_CHEAT: Cheat = { forceMatch: null, forceMax: false, freeDraw: false, rtp: null };
const RTP_MAX = 300;
const mean = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);

function buildTicket(type: TicketType, tutorial = false, playerLevel = 1, odds: Odds = DEFAULT_ODDS, multiplierMinLevel = 3, cheat: Cheat | null = null): Ticket {
  const winning = uniqueNumbers(4);
  const roll = Math.random();
  const oddsTotal = odds.m0 + odds.m1 + odds.m2 + odds.m3;
  const safeOdds = oddsTotal > 0 ? odds : DEFAULT_ODDS;
  const total = oddsTotal > 0 ? oddsTotal : DEFAULT_ODDS.m0 + DEFAULT_ODDS.m1 + DEFAULT_ODDS.m2 + DEFAULT_ODDS.m3;
  const cut1 = safeOdds.m0 / total, cut2 = cut1 + safeOdds.m1 / total, cut3 = cut2 + safeOdds.m2 / total;
  const rolled = tutorial ? 1 : roll < cut1 ? 0 : roll < cut2 ? 1 : roll < cut3 ? 2 : 3;
  // Developer cheat can force the number of matches (0–4) on the next ticket.
  const matchCount = cheat && cheat.forceMatch != null ? Math.max(0, Math.min(4, Math.floor(cheat.forceMatch))) : rolled;
  const matching = [...winning].sort(() => Math.random() - 0.5).slice(0, matchCount);
  const nonMatching = uniqueNumbers(16 - matchCount, 1, 60, new Set(winning));
  const all = [...matching, ...nonMatching].sort(() => Math.random() - 0.5);
  const specialChance = type.specialChance;
  const prizePool = type.prizePool.length ? type.prizePool : TICKET_TYPES[0].prizePool;
  const multipliers = type.multipliers.length ? type.multipliers : [1];
  const topPrize = Math.max(...prizePool), topMultiplier = Math.max(...multipliers);
  // RTP override: scale prize magnitude so the ticket's expected payout ≈ target RTP × cost.
  let rtpScale = 1;
  if (cheat && cheat.rtp != null && !tutorial && type.cost > 0) {
    const pSpecial = playerLevel >= multiplierMinLevel ? specialChance : 0;
    const expectedMultiplier = (1 - pSpecial) + pSpecial * mean(multipliers);
    const expectedMatches = total > 0 ? (safeOdds.m1 + 2 * safeOdds.m2 + 3 * safeOdds.m3) / total : 0.83;
    const naturalRtp = (expectedMatches * mean(prizePool) * expectedMultiplier) / type.cost;
    if (naturalRtp > 0) rtpScale = cheat.rtp / 100 / naturalRtp;
  }
  const scalePrize = (prize: number) => (rtpScale === 1 ? prize : Math.max(5, Math.round((prize * rtpScale) / 5) * 5));
  const cells = all.map((number) => {
    // "超级大奖" cheat: matching cells pay the top prize at the top multiplier.
    if (cheat && cheat.forceMax && matching.includes(number)) return { number, prize: topPrize, multiplier: topMultiplier };
    const canMultiply = playerLevel >= multiplierMinLevel && Math.random() < specialChance;
    const multiplier = canMultiply ? randomFrom(multipliers) : 1;
    return { number, prize: tutorial && matching.includes(number) ? 250 : scalePrize(randomFrom(prizePool)), multiplier };
  });
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    typeId: type.id,
    typeSnapshot: { ...type, prizePool: [...type.prizePool], multipliers: [...type.multipliers] },
    winning,
    cells,
    scratched: Array(16).fill(false),
    settled: false,
    totalWin: 0,
    createdAt: Date.now(),
  };
}

function playTone(enabled: boolean, kind: "scratch" | "match" | "win" | "bigwin" | "tap") {
  if (!enabled || typeof window === "undefined") return;
  try {
    const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const context = new AudioContextClass();
    const now = context.currentTime;
    const note = (freq: number, start: number, dur: number, vol: number, type: OscillatorType) => {
      const o = context.createOscillator();
      const g = context.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, now + start);
      g.gain.setValueAtTime(0.0001, now + start);
      g.gain.exponentialRampToValueAtTime(vol, now + start + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
      o.connect(g).connect(context.destination);
      o.start(now + start);
      o.stop(now + start + dur + 0.03);
    };
    let closeAfter = 0.25;
    if (kind === "win") {
      // ascending bell arpeggio
      ([[659, 0], [784, 0.09], [988, 0.18], [1319, 0.28]] as [number, number][]).forEach(([f, s]) => note(f, s, 0.34, 0.07, "triangle"));
      closeAfter = 0.85;
    } else if (kind === "bigwin") {
      // fuller fanfare + sustained chord + high sparkle
      ([[523, 0], [659, 0.08], [784, 0.16], [1047, 0.26], [1319, 0.38], [1568, 0.5]] as [number, number][]).forEach(([f, s]) => note(f, s, 0.4, 0.075, "triangle"));
      note(523, 0.02, 0.95, 0.028, "sine");
      note(784, 0.02, 0.95, 0.028, "sine");
      [1760, 2093, 2637].forEach((f, i) => note(f, 0.56 + i * 0.06, 0.22, 0.03, "sine"));
      closeAfter = 1.35;
    } else {
      const freq = kind === "match" ? 740 : kind === "scratch" ? 165 : 310;
      note(freq, 0, kind === "scratch" ? 0.1 : 0.11, kind === "scratch" ? 0.02 : 0.06, kind === "scratch" ? "sawtooth" : "sine");
    }
    window.setTimeout(() => { try { context.close(); } catch { /* already closed */ } }, closeAfter * 1000);
  } catch { /* Audio feedback is optional. */ }
}

function ScratchTile({ cell, revealed, matched, accent, sound, coinsPerToken, onReveal, onScratchStart }: {
  cell: Cell;
  revealed: boolean;
  matched: boolean;
  accent: string;
  sound: boolean;
  coinsPerToken: number;
  onReveal: () => void;
  onScratchStart: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const lastPoint = useRef<{ x: number; y: number } | null>(null);
  const revealedRef = useRef(revealed);
  const lastSoundAt = useRef(0);
  const coverTouchedRef = useRef(false);

  useEffect(() => { revealedRef.current = revealed; }, [revealed]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const drawCover = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(rect.width * ratio));
      canvas.height = Math.max(1, Math.round(rect.height * ratio));
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return;
      if (revealedRef.current) { context.clearRect(0, 0, canvas.width, canvas.height); return; }
      context.globalCompositeOperation = "source-over";
      context.globalAlpha = 1;
      context.clearRect(0, 0, canvas.width, canvas.height);
      if (scratchFoilImage?.complete && scratchFoilImage.naturalWidth > 0) {
        context.drawImage(scratchFoilImage, 0, 0, canvas.width, canvas.height);
      } else {
        const fallback = context.createLinearGradient(0, 0, canvas.width, canvas.height);
        fallback.addColorStop(0, "#fbf8ff"); fallback.addColorStop(0.52, "#c4bad2"); fallback.addColorStop(1, "#eee9f5");
        context.fillStyle = fallback;
        context.fillRect(0, 0, canvas.width, canvas.height);
      }
      context.globalAlpha = 0.88;
      context.fillStyle = "#554764";
      context.shadowColor = "#ffffffa8";
      context.shadowBlur = 2.5 * ratio;
      context.font = `850 ${Math.max(8, rect.width * 0.125) * ratio}px Arial`;
      context.textAlign = "center"; context.textBaseline = "middle";
      context.fillText("刮开", canvas.width / 2, canvas.height / 2);
      context.shadowBlur = 0;
      context.globalAlpha = 1;
    };
    drawCover();
    const stopWaitingForFoil = prepareScratchFoil(() => {
      if (!coverTouchedRef.current && !revealedRef.current) drawCover();
    });
    const observer = new ResizeObserver(() => {
      coverTouchedRef.current = false;
      drawCover();
    });
    observer.observe(canvas);
    return () => { observer.disconnect(); stopWaitingForFoil(); };
  }, []);

  const revealIfReady = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || revealedRef.current) return;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let clear = 0;
    let sampled = 0;
    for (let i = 3; i < pixels.length; i += 32) { sampled += 1; if (pixels[i] < 32) clear += 1; }
    if (clear / sampled >= 0.57) {
      revealedRef.current = true;
      context.clearRect(0, 0, canvas.width, canvas.height);
      onReveal();
    }
  }, [onReveal]);

  const pointFor = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * (canvas.width / rect.width), y: (event.clientY - rect.top) * (canvas.height / rect.height) };
  };

  const eraseTo = (point: { x: number; y: number }) => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.save();
    context.globalCompositeOperation = "destination-out";
    context.lineCap = "round"; context.lineJoin = "round";
    context.lineWidth = Math.max(28, canvas.width * 0.28);
    context.beginPath();
    const last = lastPoint.current || point;
    context.moveTo(last.x, last.y); context.lineTo(point.x, point.y); context.stroke();
    context.restore();
    lastPoint.current = point;
    const now = performance.now();
    if (now - lastSoundAt.current > 120) { playTone(sound, "scratch"); lastSoundAt.current = now; }
  };

  return (
    <div
      className={`scratch-tile ${revealed ? "is-revealed" : ""} ${revealed && matched ? "is-match" : ""}`}
      style={{ "--tile-accent": accent } as React.CSSProperties}
      role="button"
      tabIndex={0}
      aria-label={revealed ? `${cell.number}, prize ${formatTokens(cell.prize * cell.multiplier, coinsPerToken)} tokens${matched ? ", match" : ""}` : "Covered scratch tile"}
      onKeyDown={(event) => { if (!revealed && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onScratchStart(); onReveal(); } }}
    >
      <div className="tile-content">
        <strong>{cell.number}</strong>
        <small>{formatTokens(cell.prize, coinsPerToken)} TOKENS</small>
        {cell.multiplier > 1 && <b>{cell.multiplier}X</b>}
        {revealed && matched && <em>MATCH</em>}
      </div>
      <canvas
        ref={canvasRef}
        className="scratch-canvas"
        aria-hidden="true"
        onPointerDown={(event) => { if (revealedRef.current) return; coverTouchedRef.current = true; drawingRef.current = true; onScratchStart(); event.currentTarget.setPointerCapture(event.pointerId); const point = pointFor(event); lastPoint.current = point; eraseTo(point); }}
        onPointerMove={(event) => { if (!drawingRef.current || revealedRef.current) return; eraseTo(pointFor(event)); revealIfReady(); }}
        onPointerUp={(event) => { drawingRef.current = false; lastPoint.current = null; try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* Some browsers release capture automatically. */ } revealIfReady(); }}
        onPointerCancel={() => { drawingRef.current = false; lastPoint.current = null; revealIfReady(); }}
      />
    </div>
  );
}

type ResultParticleKind = "coin" | "gem" | "spark" | "ribbon";
type ResultParticle = {
  id: number;
  kind: ResultParticleKind;
  x: number;
  y: number;
  size: number;
  delay: number;
  duration: number;
  drift: number;
  lift: number;
  spin: number;
  color: string;
};

const RESULT_PARTICLE_COLORS = ["#ffd76e", "#ffb719", "#ff4fd8", "#aa4dff", "#36f2e0", "#4ca6ff", "#fff3ba"];

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seedValue: number) {
  let state = seedValue || 0x6d2b79f5;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** A logarithmic curve keeps normal prizes celebratory while reserving the
 *  densest glow and motion for genuinely exceptional payouts. */
function prizeEffectPower(totalWin: number, ticketCost: number) {
  if (totalWin <= 0) return 0;
  const payoutRatio = totalWin / Math.max(1, ticketCost);
  return Math.min(1, 0.16 + Math.log2(payoutRatio + 1) / 6.6);
}

function buildResultParticles(seed: string, power: number): ResultParticle[] {
  if (!seed || power <= 0) return [];
  const random = seededRandom(stableHash(seed));
  const count = Math.round(10 + power * 66);
  return Array.from({ length: count }, (_, id) => {
    const roll = random();
    const kind: ResultParticleKind = roll < 0.28 + power * 0.17
      ? "coin"
      : roll < 0.59
        ? "gem"
        : roll < 0.82
          ? "spark"
          : "ribbon";
    const leftSide = random() < 0.5;
    const edgeBias = random();
    const x = id % 11 === 0
      ? 16 + random() * 68
      : leftSide
        ? 1 + edgeBias * 34
        : 65 + edgeBias * 34;
    const y = 1 + random() * (65 + power * 10);
    const heroScale = id % 9 === 0 ? 1.45 + power * 0.65 : 1;
    return {
      id,
      kind,
      x,
      y,
      size: ((kind === "spark" ? 5 : kind === "ribbon" ? 10 : 12) + random() * (8 + power * 18)) * heroScale,
      delay: -random() * (1.4 + power * 2.2),
      duration: 2.2 + random() * 1.9 - power * 0.55,
      drift: (random() - 0.5) * (18 + power * 30),
      lift: 7 + random() * (11 + power * 15),
      spin: (random() - 0.5) * (220 + power * 520),
      color: RESULT_PARTICLE_COLORS[Math.floor(random() * RESULT_PARTICLE_COLORS.length)],
    };
  });
}

/** Full-screen code-driven celebration fired on a win. Particle volume, size,
 *  speed, coin ratio, and duration all grow continuously with payout value. */
function WinConfetti({ trigger, intensity }: { trigger: number; intensity: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!trigger) return;
    if (typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let W = 0, H = 0;
    const resize = () => { W = canvas.clientWidth; H = canvas.clientHeight; canvas.width = Math.max(1, Math.round(W * dpr)); canvas.height = Math.max(1, Math.round(H * dpr)); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
    resize();
    const power = Math.max(0.12, Math.min(1, intensity));
    const rand = (a: number, b: number) => a + Math.random() * (b - a);
    const sMul = 0.82 + power * 0.62;
    const palette = ["#ffd76e", "#ffe9a8", "#2ce9d3", "#a83cff", "#ff5db1", "#48f5df", "#ffffff"];
    type P = { x: number; y: number; vx: number; vy: number; rot: number; vr: number; size: number; color: string; coin: boolean; wob: number };
    const parts: P[] = [];
    const rain = Math.min(320, Math.max(34, Math.round((W / 4.8) * (0.55 + power * 1.7))));
    for (let i = 0; i < rain; i++) {
      const coin = Math.random() < 0.2 + power * 0.34;
      parts.push({ x: rand(0, W), y: rand(-H * (0.35 + power * 0.45), -8), vx: rand(-35 - power * 25, 35 + power * 25), vy: rand(65, 135 + power * 85), rot: rand(0, 6.28), vr: rand(-6 - power * 5, 6 + power * 5), size: (coin ? rand(8, 14 + power * 5) : rand(5, 9 + power * 5)) * sMul, color: coin ? "#ffd76e" : palette[(Math.random() * palette.length) | 0], coin, wob: rand(0, 6.28) });
    }
    const burst = Math.round(22 + power * 116);
    for (let i = 0; i < burst; i++) {
      const a = rand(0, 6.28), sp = rand(75, 230 + power * 310), coin = Math.random() < 0.26 + power * 0.25;
      parts.push({ x: W / 2, y: H * 0.42, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 110 - power * 80, rot: rand(0, 6.28), vr: rand(-8 - power * 4, 8 + power * 4), size: (coin ? rand(8, 14 + power * 5) : rand(5, 10 + power * 6)) * sMul, color: coin ? "#ffd76e" : palette[(Math.random() * palette.length) | 0], coin, wob: rand(0, 6.28) });
    }
    const G = 260 + power * 70, DUR = 2100 + power * 2500;
    let raf = 0, last = performance.now();
    const start = last;
    const frame = (now: number) => {
      const dt = Math.min(0.033, (now - last) / 1000); last = now;
      const t = now - start;
      ctx.clearRect(0, 0, W, H);
      const fade = t > DUR - 700 ? Math.max(0, (DUR - t) / 700) : 1;
      for (const p of parts) {
        p.vy += G * dt; p.wob += dt * 6;
        p.x += (p.vx + Math.sin(p.wob) * 22) * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
        ctx.save(); ctx.globalAlpha = fade; ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        if (p.coin) {
          const s = 0.32 + 0.68 * Math.abs(Math.cos(p.rot * 1.5));
          ctx.beginPath(); ctx.ellipse(0, 0, p.size * s, p.size, 0, 0, 6.283); ctx.fillStyle = p.color; ctx.fill();
          ctx.lineWidth = 1.5; ctx.strokeStyle = "#b8892f"; ctx.stroke();
        } else {
          ctx.fillStyle = p.color; ctx.fillRect(-p.size / 2, -p.size * 0.34, p.size, p.size * 0.68);
        }
        ctx.restore();
      }
      if (t < DUR) raf = requestAnimationFrame(frame); else ctx.clearRect(0, 0, W, H);
    };
    raf = requestAnimationFrame(frame);
    window.addEventListener("resize", resize);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", resize); if (ctx) ctx.clearRect(0, 0, W, H); };
  }, [trigger, intensity]);
  return <canvas ref={canvasRef} className="win-fx" aria-hidden="true" />;
}

export default function Home() {
  const [player, setPlayer] = useState<Player>(DEFAULT_PLAYER);
  const [config, setConfig] = useState<GameConfig>(DEFAULT_CONFIG);
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [panel, setPanel] = useState<"shop" | "collection" | "settings" | "topup" | null>(null);
  const [selectedTopup, setSelectedTopup] = useState<TopupPackage | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  useEffect(() => { if (!showHelp) return; const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setShowHelp(false); }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [showHelp]);
  const [toast, setToast] = useState("");
  const [showResult, setShowResult] = useState(false);
  const [winFx, setWinFx] = useState<{ n: number; intensity: number }>({ n: 0, intensity: 0 });
  const [winFlash, setWinFlash] = useState<{ n: number; intensity: number }>({ n: 0, intensity: 0 });
  const [sessionNow] = useState(() => Date.now());
  const [profileAvatar, setProfileAvatar] = useState<string | null>(null);
  const [devArmed, setDevArmed] = useState(false);
  const [devOpen, setDevOpen] = useState(false);
  const [cheat, setCheat] = useState<Cheat>(DEFAULT_CHEAT);
  const [coinInput, setCoinInput] = useState("");
  const settleLock = useRef(false);
  const saveKeyRef = useRef(SAVE_KEY);
  const brandTapRef = useRef({ n: 0, t: 0 });
  const gameCardRef = useRef<HTMLElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const topupConfirmRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!panel) return;
    const sheet = sheetRef.current;
    const gameCard = gameCardRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => Array.from(sheet?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])") || []);
    gameCard?.setAttribute("inert", "");
    const focusTimer = window.setTimeout(() => (focusable()[0] || sheet)?.focus(), 0);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setSelectedTopup(null);
        setPanel(null);
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) { event.preventDefault(); sheet?.focus(); return; }
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKey);
      gameCard?.removeAttribute("inert");
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [panel]);

  useEffect(() => {
    if (!selectedTopup) return;
    const current = config.topups.find((item) => item.id === selectedTopup.id);
    if (!current || current.price !== selectedTopup.price || current.coins !== selectedTopup.coins) {
      const refreshTask = window.setTimeout(() => {
        setSelectedTopup(null);
        setToast("充值套餐已更新，请重新选择");
      }, 0);
      return () => window.clearTimeout(refreshTask);
    }
  }, [config.topups, selectedTopup]);

  useEffect(() => {
    if (panel !== "topup" || !selectedTopup) return;
    const focusTimer = window.setTimeout(() => topupConfirmRef.current?.focus(), 0);
    return () => window.clearTimeout(focusTimer);
  }, [panel, selectedTopup]);

  const armDev = useCallback(() => {
    setDevArmed(true);
    setDevOpen(true);
    try { sessionStorage.setItem(DEV_KEY, "1"); } catch { /* storage disabled */ }
    setToast("开发者模式已开启 🛠");
  }, []);

  // The signed-in account's avatar (from /login.html), shown on the profile button.
  useEffect(() => {
    const task = window.setTimeout(() => {
      try {
        const raw = localStorage.getItem(SESSION_KEY);
        if (!raw) return;
        const session = JSON.parse(raw) as { u?: string };
        if (!session?.u) return;
        const store = JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || "{}");
        const account = store?.[session.u.toLowerCase()];
        if (account?.avatar) setProfileAvatar(account.avatar as string);
      } catch { /* no signed-in account; show the generic profile glyph */ }
    }, 0);
    return () => window.clearTimeout(task);
  }, []);

  // Restore an armed dev session (this tab, or ?dev in the URL) and any saved cheat settings.
  useEffect(() => {
    const restoreTask = window.setTimeout(() => {
      try {
        const armed = sessionStorage.getItem(DEV_KEY) === "1" || new URL(window.location.href).searchParams.has("dev");
        if (armed) setDevArmed(true);
        const raw = localStorage.getItem(CHEAT_KEY);
        if (raw) {
          const c = JSON.parse(raw) as Partial<Cheat>;
          setCheat({ forceMatch: typeof c?.forceMatch === "number" ? c.forceMatch : null, forceMax: !!c?.forceMax, freeDraw: !!c?.freeDraw, rtp: typeof c?.rtp === "number" ? c.rtp : null });
        }
      } catch { /* storage/URL unavailable */ }
    }, 0);
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "d" || e.key === "D")) { e.preventDefault(); armDev(); }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.clearTimeout(restoreTask); window.removeEventListener("keydown", onKey); };
  }, [armDev]);

  // Persist cheat settings while dev mode is armed.
  useEffect(() => {
    if (!devArmed) return;
    try { localStorage.setItem(CHEAT_KEY, JSON.stringify(cheat)); } catch { /* storage disabled */ }
  }, [cheat, devArmed]);

  useEffect(() => {
    let cancelled = false;
    const hydrate = async () => {
      if (!hasLocalAccountSession()) {
        window.location.replace("/login.html?next=%2F");
        return;
      }
      const startup = await resolveStartupConfig();
      if (cancelled) return;
      setConfig(startup);
      const saveKey = gameSaveKey();
      saveKeyRef.current = saveKey;
      try {
        const saved = localStorage.getItem(saveKey);
        if (saved) {
          const parsed = JSON.parse(saved) as { player: Player; ticket: Ticket | null };
          const mergedPlayer = { ...DEFAULT_PLAYER, ...parsed.player, settings: { ...DEFAULT_PLAYER.settings, ...parsed.player?.settings } };
          const legacyType = startup.types.find((type) => type.id === parsed.ticket?.typeId) || startup.types[0];
          const restoredTicket = parsed.ticket
            ? { ...parsed.ticket, typeSnapshot: parsed.ticket.typeSnapshot || { ...legacyType, prizePool: [...legacyType.prizePool], multipliers: [...legacyType.multipliers] } }
            : null;
          setPlayer(mergedPlayer);
          setTicket(restoredTicket);
          settleLock.current = Boolean(restoredTicket?.settled);
          // A settled ticket stays settled, but its result poster belongs only
          // to the settlement that happened in this page session. Returning
          // from Profile or refreshing must not replay an old result.
          setShowResult(false);
        } else {
          const first = buildTicket(startup.types[0], true, 1, startup.odds, startup.multiplierMinLevel);
          setPlayer({ ...DEFAULT_PLAYER, coins: DEFAULT_PLAYER.coins - startup.types[0].cost, ticketsPlayed: 1, totalSpent: startup.types[0].cost, log: [{ t: Date.now(), k: "buy", a: startup.types[0].cost, n: startup.types[0].name }] });
          setTicket(first);
        }
      } catch {
        const first = buildTicket(startup.types[0], true, 1, startup.odds, startup.multiplierMinLevel);
        setPlayer({ ...DEFAULT_PLAYER, coins: DEFAULT_PLAYER.coins - startup.types[0].cost, ticketsPlayed: 1, totalSpent: startup.types[0].cost, log: [{ t: Date.now(), k: "buy", a: startup.types[0].cost, n: startup.types[0].name }] });
        setTicket(first);
      }
      setHydrated(true);
    };
    const hydrationTask = window.setTimeout(() => { void hydrate(); }, 0);
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    return () => { cancelled = true; window.clearTimeout(hydrationTask); };
  }, []);

  // Keep operator settings current across devices. Existing ticket cells are
  // immutable; refreshed settings are used for the shop and all new tickets.
  useEffect(() => {
    if (!hydrated) return;
    let disposed = false;
    let refreshing = false;
    const apply = (next: GameConfig | null) => {
      if (!next || disposed) return;
      setConfig((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    };
    const refresh = async () => {
      if (refreshing || disposed) return;
      refreshing = true;
      apply(await fetchCloudConfig());
      refreshing = false;
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === CONFIG_VERSION_KEY && event.newValue) {
        const version = Number(event.newValue);
        if (Number.isSafeInteger(version)) acceptedCloudConfigVersion = Math.max(acceptedCloudConfigVersion, version);
      }
      if (event.key === CONFIG_KEY && event.newValue) {
        const version = Number(localStorage.getItem(CONFIG_VERSION_KEY));
        if (Number.isSafeInteger(version)) acceptedCloudConfigVersion = Math.max(acceptedCloudConfigVersion, version);
        apply(loadConfig());
      }
    };
    const onFocus = () => { void refresh(); };
    const onVisibility = () => { if (!document.hidden) void refresh(); };
    let channel: BroadcastChannel | null = null;
    try {
      if ("BroadcastChannel" in window) {
        channel = new BroadcastChannel(CONFIG_CHANNEL);
        channel.onmessage = (event: MessageEvent<{ version?: unknown }>) => {
          const version = Number(event.data?.version);
          if (Number.isSafeInteger(version)) acceptedCloudConfigVersion = Math.max(acceptedCloudConfigVersion, version);
          void refresh();
        };
      }
    } catch { /* unsupported browser */ }
    const interval = window.setInterval(() => { if (!document.hidden) void refresh(); }, 30000);
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      channel?.close();
    };
  }, [hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(saveKeyRef.current, JSON.stringify({ player, ticket, saveVersion: 1 }));
  }, [player, ticket, hydrated]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const ticketType = ticket?.typeSnapshot || config.types.find((type) => type.id === ticket?.typeId) || config.types[0];
  const selectedType = config.types.find((type) => type.id === player.selectedTicketId) || config.types[0];
  const tokenAmount = (coins: number) => formatTokens(coins, config.economy.coinsPerToken);
  const scratchedCount = ticket?.scratched.filter(Boolean).length || 0;
  const progressInLevel = player.ticketsPlayed % 5;
  const canRescue = player.coins < config.types[0].cost && sessionNow - player.rescueAt >= 6 * 60 * 60 * 1000;
  const prizeTier: "miss" | "normal" | "big" | "jackpot" = !ticket?.settled || ticket.totalWin <= 0
    ? "miss"
    : ticket.totalWin >= ticketType.cost * 25
      ? "jackpot"
      : ticket.totalWin >= ticketType.cost * 8
        ? "big"
        : "normal";
  const prizeCopy = {
    miss: { eyebrow: "再试一次", detail: "每一张都让你更进一步", icon: "◇", emblem: null },
    normal: { eyebrow: "幸运中奖", detail: "代币奖励", icon: "◆", emblem: "/prize-assets/normal-win-emblem.webp" },
    big: { eyebrow: "大奖时刻", detail: "高额代币奖励", icon: "✦", emblem: "/prize-assets/big-prize-emblem.webp" },
    jackpot: { eyebrow: "超级大奖", detail: "最高荣耀奖励", icon: "♛", emblem: "/prize-assets/jackpot-emblem.webp" },
  }[prizeTier];
  const resultEffectPower = prizeEffectPower(ticket?.settled ? ticket.totalWin : 0, ticketType.cost);
  const resultSeed = ticket?.settled ? `${ticket.id}:${ticket.totalWin}` : "";
  const resultParticles = useMemo(() => buildResultParticles(resultSeed, resultEffectPower), [resultSeed, resultEffectPower]);
  const resultEffectStyle = {
    "--effect-power": resultEffectPower.toFixed(3),
    "--effect-opacity": (0.18 + resultEffectPower * 0.82).toFixed(3),
    "--effect-scale": (0.84 + resultEffectPower * 0.28).toFixed(3),
    "--effect-glow": `${Math.round(22 + resultEffectPower * 74)}px`,
    "--pulse-speed": `${(2.9 - resultEffectPower * 1.25).toFixed(2)}s`,
    "--ray-speed": `${(13 - resultEffectPower * 6).toFixed(2)}s`,
  } as React.CSSProperties;

  const matchedIndices = useMemo(() => {
    if (!ticket) return new Set<number>();
    return new Set(ticket.cells.map((cell, index) => ticket.winning.includes(cell.number) || cell.instant ? index : -1).filter((index) => index >= 0));
  }, [ticket]);

  const vibrate = (pattern: number | number[]) => {
    if (player.settings.vibration && "vibrate" in navigator) navigator.vibrate(pattern);
  };

  const scratchStart = () => {
    if (player.tutorialSeen) return;
    setPlayer((current) => ({ ...current, tutorialSeen: true }));
  };

  const revealCell = useCallback((index: number) => {
    setTicket((current) => {
      if (!current || current.scratched[index]) return current;
      const scratched = [...current.scratched]; scratched[index] = true;
      const matched = current.winning.includes(current.cells[index].number) || current.cells[index].instant;
      if (matched) {
        playTone(player.settings.sound, "match");
        if (player.settings.vibration && "vibrate" in navigator) navigator.vibrate(35);
      }
      return { ...current, scratched };
    });
  }, [player.settings.sound, player.settings.vibration]);

  const settle = (revealAll = true) => {
    if (!ticket || ticket.settled || settleLock.current) return;
    settleLock.current = true;
    const totalWin = ticket.cells.reduce((sum, cell) => ticket.winning.includes(cell.number) || cell.instant ? sum + cell.prize * cell.multiplier : sum, 0);
    const effectIntensity = prizeEffectPower(totalWin, ticketType.cost);
    const bigWin = effectIntensity >= 0.62;
    setTicket({ ...ticket, scratched: revealAll ? ticket.scratched.map(() => true) : ticket.scratched, settled: true, totalWin });
    setPlayer((current) => ({
      ...current,
      coins: current.coins + totalWin,
      totalWon: current.totalWon + (totalWin > 0 ? totalWin : 0),
      log: totalWin > 0 ? pushLog(current.log, { t: Date.now(), k: "win", a: totalWin, n: ticketType.name }) : current.log,
      bestWins: { ...current.bestWins, [ticket.typeId]: Math.max(current.bestWins[ticket.typeId] || 0, totalWin) },
    }));
    setShowResult(true);
    if (totalWin > 0) {
      setWinFx((current) => ({ n: current.n + 1, intensity: effectIntensity }));
      if (effectIntensity >= 0.44) setWinFlash((current) => ({ n: current.n + 1, intensity: effectIntensity }));
    }
    playTone(player.settings.sound, totalWin <= 0 ? "tap" : bigWin ? "bigwin" : "win");
    vibrate(bigWin ? [60, 40, 80, 40, 130] : totalWin > 0 ? [45, 50, 90] : 30);
  };

  const buyNewTicket = () => {
    const type = selectedType;
    const cost = cheat.freeDraw ? 0 : type.cost;
    if (player.level < type.unlockLevel) { setToast(`等级 ${type.unlockLevel} 解锁`); return; }
    if (player.coins < cost) { setToast("代币不足，可领取救济奖励"); return; }
    const nextPlayed = player.ticketsPlayed + 1;
    const nextLevel = Math.floor(nextPlayed / 5) + 1;
    const leveledUp = nextLevel > player.level;
    setPlayer((current) => ({
      ...current,
      coins: current.coins - cost,
      ticketsPlayed: nextPlayed,
      level: nextLevel,
      totalSpent: current.totalSpent + cost,
      log: pushLog(current.log, { t: Date.now(), k: "buy", a: cost, n: type.name }),
    }));
    setTicket(buildTicket(type, false, nextLevel, config.odds, config.multiplierMinLevel, cheat));
    settleLock.current = false;
    setShowResult(false);
    if (leveledUp) { setToast(`达到 ${nextLevel} 级！已解锁新奖励`); playTone(player.settings.sound, "win"); vibrate([50, 40, 100]); }
    else setToast(`${type.name} 已就绪，祝你好运！`);
  };

  const claimRescue = () => {
    if (!canRescue) return;
    setPlayer((current) => ({ ...current, coins: current.coins + 1500, rescueAt: Date.now(), log: pushLog(current.log, { t: Date.now(), k: "rescue", a: 1500 }) }));
    setToast(`每日救济：+${tokenAmount(1500)} 代币`);
  };

  const confirmDemoTopup = () => {
    const currentPackage = selectedTopup ? config.topups.find((item) => item.id === selectedTopup.id) : null;
    if (!currentPackage || !selectedTopup || currentPackage.price !== selectedTopup.price || currentPackage.coins !== selectedTopup.coins || !Number.isSafeInteger(currentPackage.coins) || currentPackage.coins < 1) {
      setSelectedTopup(null);
      setToast("这个充值套餐已更新，请重新选择");
      return;
    }
    const nextPlayer = {
      ...player,
      coins: Math.min(Number.MAX_SAFE_INTEGER, player.coins + currentPackage.coins),
      log: pushLog(player.log, {
        t: Date.now(),
        k: "topup" as const,
        a: currentPackage.coins,
        n: `RM ${currentPackage.price.toFixed(2)}`,
        packageId: currentPackage.id,
        priceMyr: currentPackage.price,
      }),
    };
    try {
      localStorage.setItem(saveKeyRef.current, JSON.stringify({ player: nextPlayer, ticket, saveVersion: 1 }));
    } catch {
      setToast("演示充值失败：无法写入本机存档");
      return;
    }
    setPlayer(nextPlayer);
    setSelectedTopup(null);
    setPanel(null);
    setToast(`演示充值 +${tokenAmount(currentPackage.coins)} 代币（不会扣款）`);
  };

  const resetSave = () => {
    if (!window.confirm("确定重置所有进度？此操作无法撤销。")) return;
    localStorage.removeItem(saveKeyRef.current);
    const fresh = loadConfig();
    setConfig(fresh);
    const first = buildTicket(fresh.types[0], true, 1, fresh.odds, fresh.multiplierMinLevel);
    setPlayer({ ...DEFAULT_PLAYER, coins: DEFAULT_PLAYER.coins - fresh.types[0].cost, ticketsPlayed: 1, totalSpent: fresh.types[0].cost, log: [{ t: Date.now(), k: "buy", a: fresh.types[0].cost, n: fresh.types[0].name }] });
    setTicket(first); settleLock.current = false; setShowResult(false); setPanel(null); setToast("已重新开始");
  };

  // ---- Developer cheats (only reachable once dev mode is armed) ----
  const maxUnlockLevel = config.types.reduce((max, type) => Math.max(max, type.unlockLevel), 1);
  const bumpBrandTap = () => {
    const now = performance.now();
    const tap = brandTapRef.current;
    tap.n = now - tap.t < 700 ? tap.n + 1 : 1;
    tap.t = now;
    if (tap.n >= 5) { tap.n = 0; armDev(); }
  };
  const devAddCoins = (amount: number) => setPlayer((current) => {
    const nextCoins = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.round(current.coins + amount)));
    const delta = nextCoins - current.coins;
    if (delta === 0) return current;
    return {
      ...current,
      coins: nextCoins,
      log: pushLog(current.log, { t: Date.now(), k: "developer", a: delta, n: delta > 0 ? "增加余额" : "减少余额" }),
    };
  });
  const devSetCoins = (amount: number) => setPlayer((current) => {
    const nextCoins = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.round(amount)));
    const delta = nextCoins - current.coins;
    if (delta === 0) return current;
    return {
      ...current,
      coins: nextCoins,
      log: pushLog(current.log, { t: Date.now(), k: "developer", a: delta, n: nextCoins === 0 ? "清空余额" : "设置余额" }),
    };
  });
  const applyCoinInput = () => {
    const amount = Number(coinInput);
    if (!Number.isFinite(amount)) return;
    devSetCoins(amount);
    setToast(`金币已设为 ${formatCoins(Math.max(0, Math.round(amount)))}`);
    setCoinInput("");
  };
  const devSetLevel = (level: number) => {
    const next = Math.max(1, Math.min(99, Math.floor(level)));
    // Keep ticketsPlayed consistent with level so the next purchase doesn't recompute it away.
    setPlayer((current) => ({ ...current, level: next, ticketsPlayed: (next - 1) * 5 }));
  };
  const devDealTicket = () => {
    setTicket(buildTicket(selectedType, false, player.level, config.odds, config.multiplierMinLevel, cheat));
    settleLock.current = false;
    setShowResult(false);
    setToast(`已发一张 ${selectedType.name} 测试卡`);
  };
  const disableDev = () => {
    setDevArmed(false);
    setDevOpen(false);
    setCheat(DEFAULT_CHEAT);
    try { sessionStorage.removeItem(DEV_KEY); localStorage.removeItem(CHEAT_KEY); } catch { /* storage disabled */ }
    setToast("已退出开发者模式");
  };
  // The visible 开发者 tab: arm dev mode (first time) and pop the cheat console.
  const openDevConsole = () => { if (!devArmed) armDev(); else setDevOpen(true); };
  const matchOptions: { value: number | null; label: string }[] = [
    { value: null, label: "随机" }, { value: 0, label: "不中" }, { value: 1, label: "中1" },
    { value: 2, label: "中2" }, { value: 3, label: "中3" }, { value: 4, label: "全中" },
  ];

  if (!hydrated || !ticket) return <main className="app-shell"><div className="loading-mark">LUCKY<span>SCRATCH</span></div></main>;

  return (
    <main className="app-shell" style={{ "--accent": ticketType.accent, "--accent-2": ticketType.accent2 } as React.CSSProperties}>
      <div className="ambient-orb orb-one" /><div className="ambient-orb orb-two" />
      <section ref={gameCardRef} className="game-card" aria-label="Lucky Scratch game">
        <header className="top-stats">
          {config.topups.length > 0
            ? <button type="button" className="stat-button stat-balance" onClick={() => { setSelectedTopup(null); setPanel("topup"); }} aria-haspopup="dialog" aria-expanded={panel === "topup"} aria-label={`充值虚拟代币，当前余额 ${tokenAmount(player.coins)}`}>
                <span>代币余额 · 充值</span><strong><i className="coin-dot" />{tokenAmount(player.coins)}</strong>
              </button>
            : <div className="stat-display"><span>代币余额</span><strong><i className="coin-dot" />{tokenAmount(player.coins)}</strong></div>}
          <button type="button" className="brand-mark brand-button" onClick={bumpBrandTap}>LUCKY<span>SCRATCH</span></button>
          <div className="top-actions">
            <a className="profile-chip" href="/profile.html" aria-label="我的"><span className={!profileAvatar || profileAvatar === "🍀" ? "profile-avatar-clover" : undefined}>{profileAvatar && profileAvatar !== "🍀" ? profileAvatar : null}</span></a>
            <button className="stat-button stat-right" onClick={() => setPanel("collection")} aria-label="打开收藏">
              <span>等级</span><strong>{String(player.level).padStart(2, "0")}</strong>
            </button>
          </div>
        </header>

        <div className="level-track" aria-label={`距离升级还差 ${5 - progressInLevel} 张`}><span style={{ width: `${(progressInLevel / 5) * 100}%` }} /></div>

        <div className="ticket-heading">
          <div className="ticket-title-main">
            <div className="ticket-kicker"><span>{ticketType.name}</span><button onClick={() => setPanel("shop")}>更换</button></div>
            <h1>{ticketType.shortName}</h1>
          </div>
          <div className="max-badge"><span>最高</span><strong>{ticketType.maxLabel}</strong></div>
          <button className="info-btn" type="button" onClick={() => setShowHelp(true)} aria-label="玩法说明">i</button>
        </div>

        <section className="winning-panel" aria-labelledby="winning-label">
          <div className="section-label" id="winning-label"><span /> 中奖号码 <span /></div>
          <div className="winning-row">{ticket.winning.map((number, index) => <strong key={`${ticket.id}-win-${index}`}>{number}</strong>)}</div>
        </section>

        <section className="play-area" aria-labelledby="your-numbers-label">
          <div className="section-label muted" id="your-numbers-label"><span /> 你的号码 <span /></div>
          <div className="scratch-grid">
            {ticket.cells.map((cell, index) => (
              <ScratchTile key={`${ticket.id}-${index}`} cell={cell} revealed={ticket.scratched[index]} matched={matchedIndices.has(index)} accent={ticketType.accent} sound={player.settings.sound} coinsPerToken={config.economy.coinsPerToken} onScratchStart={scratchStart} onReveal={() => revealCell(index)} />
            ))}
          </div>
          {!player.tutorialSeen && !ticket.settled && <div className="tutorial-tip"><span className="tutorial-gesture" aria-hidden="true" /><span className="tutorial-copy"><b>拖动刮开</b><small>刮开银色区块即可开始</small></span></div>}
        </section>

        <div className="ticket-meta"><span>{scratchedCount}/16 已刮开</span><strong>单价 {tokenAmount(ticketType.cost)} 代币</strong><span>最高 {tokenAmount(player.bestWins[ticketType.id] || 0)}</span></div>

        <nav className="action-bar" aria-label="Game actions">
          <button disabled={ticket.settled || scratchedCount < 8} onClick={() => settle(true)}><span>✓</span>兑奖</button>
          <button className="primary" disabled={player.coins < selectedType.cost || player.level < selectedType.unlockLevel} onClick={buyNewTicket}><span>＋</span>新的一张<small>{tokenAmount(selectedType.cost)} 代币</small></button>
          <button disabled={ticket.settled} onClick={() => settle(true)}><span>✦</span>全部刮开</button>
        </nav>

        {canRescue && <button className="rescue-banner" onClick={claimRescue}>代币不足？领取每日救济 <b>+{tokenAmount(1500)}</b></button>}

        <footer className="footer-nav">
          <button onClick={() => setPanel("shop")}><span>◈</span>票种</button>
          <button className="active"><span>✦</span>开始</button>
          <button onClick={() => setPanel("collection")}><span>♛</span>收藏</button>
          <button onClick={() => setPanel("settings")}><span>⚙</span>设置</button>
          <button className="dev-tab" onClick={openDevConsole}><span>🛠</span>开发者</button>
        </footer>
        <p className="disclaimer">代币为虚拟游戏单位；RM 金额仅供参考，不可兑换现金或实物奖励。</p>
      </section>

      {toast && <div className="toast" role="status">{toast}</div>}

      {showResult && ticket.settled && (
        <div className="modal-backdrop result-backdrop" role="presentation">
          <section className={`result-card prize-${prizeTier}`} style={resultEffectStyle} role="dialog" aria-modal="true" aria-labelledby="result-title">
            <div className="result-celebration">
              <span className="result-aura" aria-hidden="true" />
              <span className="result-rays" aria-hidden="true" />
              {resultParticles.length > 0 && (
                <span className="result-particles" aria-hidden="true">
                  {resultParticles.map((particle) => (
                    <span
                      className="result-particle"
                      key={`${resultSeed}-${particle.id}`}
                      style={{
                        "--particle-x": `${particle.x.toFixed(2)}%`,
                        "--particle-y": `${particle.y.toFixed(2)}%`,
                        "--particle-size": `${particle.size.toFixed(2)}px`,
                        "--particle-delay": `${particle.delay.toFixed(2)}s`,
                        "--particle-duration": `${particle.duration.toFixed(2)}s`,
                        "--particle-drift": `${particle.drift.toFixed(2)}px`,
                        "--particle-lift": `${particle.lift.toFixed(2)}px`,
                        "--particle-spin": `${particle.spin.toFixed(2)}deg`,
                        "--particle-color": particle.color,
                      } as React.CSSProperties}
                    >
                      <i className={`result-particle-shape particle-${particle.kind}`} />
                    </span>
                  ))}
                </span>
              )}
              <div className="result-core">
                <span className="result-medal">
                  {prizeCopy.emblem
                    ? (
                      // The source is already an optimized local WebP; using the raw image avoids a second optimizer.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img className="result-emblem" src={prizeCopy.emblem} alt="" aria-hidden="true" draggable={false} width={1254} height={1254} decoding="async" loading="eager" fetchPriority="high" />
                    )
                    : <span aria-hidden="true">{prizeCopy.icon}</span>}
                </span>
                <p className="result-eyebrow">{prizeCopy.eyebrow}</p>
                <h2 id="result-title">{ticket.totalWin > 0 ? `+${tokenAmount(ticket.totalWin)}` : "未中奖"}</h2>
              </div>
            </div>
            <div className="result-summary">
              <strong className="result-detail">{prizeCopy.detail}</strong>
              <div className="result-stats"><span><b>{matchedIndices.size}</b> 匹配</span><span><b>+1</b> 经验</span><span><b>{5 - progressInLevel}</b> 距升级</span></div>
              <button className="result-next" onClick={buyNewTicket}>下一张 <small>{tokenAmount(selectedType.cost)} 代币</small></button>
              <button className="text-button" onClick={() => setShowResult(false)}>查看彩票</button>
            </div>
          </section>
        </div>
      )}

      {panel && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) { setSelectedTopup(null); setPanel(null); } }}>
          <section ref={sheetRef} tabIndex={-1} className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
            <div className="sheet-handle" />
            <header><div><span>LUCKY SCRATCH</span><h2 id="sheet-title">{panel === "shop" ? "票种商店" : panel === "collection" ? "我的收藏" : panel === "topup" ? "充值虚拟代币" : "设置"}</h2></div><button onClick={() => { setSelectedTopup(null); setPanel(null); }} aria-label="关闭">×</button></header>

            {panel === "topup" && <div className="topup-content">
              <div className="topup-notice"><b>演示充值</b><span>不会真实扣款 · 代币只保存在本设备</span></div>
              {config.topups.length === 0
                ? <div className="topup-empty"><span>◇</span><b>暂未开放充值套餐</b><p>请稍后再回来看看。</p></div>
                : <div className="topup-grid">{config.topups.map((item) => (
                    <button type="button" className={selectedTopup?.id === item.id ? "selected" : ""} key={item.id} onClick={() => setSelectedTopup({ ...item })}>
                      <span>虚拟代币</span><strong>+{tokenAmount(item.coins)}</strong><small>参考价 RM {item.price.toFixed(2)}</small>
                    </button>
                  ))}</div>}
              {selectedTopup && <div ref={topupConfirmRef} tabIndex={-1} aria-live="polite" className="topup-confirm">
                <p>确认领取 <b>+{tokenAmount(selectedTopup.coins)}</b> 虚拟代币？</p>
                <small>显示参考价 RM {selectedTopup.price.toFixed(2)}，本演示不会产生任何付款。</small>
                <div><button type="button" onClick={() => setSelectedTopup(null)}>取消</button><button type="button" className="confirm" onClick={confirmDemoTopup}>确认演示充值</button></div>
              </div>}
              <p className="topup-footnote">这是本地演示功能，不会收集付款资料，也不会产生订单、退款或现金价值。</p>
            </div>}

            {panel === "shop" && <div className="ticket-list">{config.types.map((type) => {
              const locked = player.level < type.unlockLevel;
              const selected = player.selectedTicketId === type.id;
              return <article className={`ticket-option ${selected ? "selected" : ""} ${locked ? "locked" : ""}`} key={type.id} style={{ "--option-accent": type.accent, "--option-accent-2": type.accent2 } as React.CSSProperties}>
                <div className="mini-ticket"><span>刮开</span><strong>{type.shortName}</strong><small>{type.maxLabel}</small></div>
                <div className="ticket-copy"><h3>{type.name}</h3><p>{type.feature}</p><div><b>{tokenAmount(type.cost)} 代币</b><span>{locked ? `等级 ${type.unlockLevel}` : "已解锁"}</span></div></div>
                <button disabled={locked} onClick={() => { setPlayer((current) => ({ ...current, selectedTicketId: type.id })); setToast(`已选择 ${type.name}`); setPanel(null); }}>{locked ? "未解锁" : selected ? "已选择" : "选择"}</button>
              </article>;
            })}</div>}

            {panel === "collection" && <div className="collection-content">
              <div className="collection-hero"><span>等级 {player.level}</span><strong>{player.ticketsPlayed}</strong><p>已刮张数</p><div><i style={{ width: `${(progressInLevel / 5) * 100}%` }} /></div><small>再刮 {5 - progressInLevel} 张升到 {player.level + 1} 级</small></div>
              <div className="badge-grid">{config.types.map((type) => { const unlocked = player.level >= type.unlockLevel; return <article key={type.id} className={unlocked ? "" : "badge-locked"}><span style={{ background: `linear-gradient(145deg,${type.accent},${type.accent2})` }}>{unlocked ? "♛" : "⌁"}</span><h3>{type.shortName}</h3><p>{unlocked ? `最高 ${tokenAmount(player.bestWins[type.id] || 0)} 代币` : `${type.unlockLevel} 级解锁`}</p></article>; })}</div>
              <p className="collection-note">同一票种刮满 50 张即可获得金色收藏徽章。</p>
            </div>}

            {panel === "settings" && <div className="settings-list">
              <label htmlFor="sound-toggle"><span><b>音效</b><small>刮开、匹配与中奖反馈</small></span><input id="sound-toggle" aria-label="音效" type="checkbox" checked={player.settings.sound} onChange={(event) => setPlayer((current) => ({ ...current, settings: { ...current.settings, sound: event.target.checked } }))} /></label>
              <label htmlFor="vibration-toggle"><span><b>振动</b><small>支持的手机上轻微震动</small></span><input id="vibration-toggle" aria-label="振动" type="checkbox" checked={player.settings.vibration} onChange={(event) => setPlayer((current) => ({ ...current, settings: { ...current.settings, vibration: event.target.checked } }))} /></label>
              <a className="settings-row" href="/profile.html" style={{ textDecoration: "none" }}><span>账户与个人资料</span><b>打开</b></a>
              <button className="reset-button" onClick={resetSave}>重置全部进度</button>
              <p>幸运刮刮乐仅使用虚拟代币；RM 金额为运营参考，不涉及真实付款、提现或实物奖励。</p>
            </div>}
          </section>
        </div>
      )}

      {showHelp && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowHelp(false); }}>
          <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="help-title">
            <div className="sheet-handle" />
            <header><div><span>玩法说明</span><h2 id="help-title">幸运刮刮乐</h2></div><button onClick={() => setShowHelp(false)} aria-label="关闭">×</button></header>
            <ul className="help-list">
              <li><h4>目标</h4><p>刮出与<b>中奖号码</b>相同的号码，即可赢得该格奖金。</p></li>
              <li><h4>刮开</h4><p>拖动刮开银色区块，露出全部 16 个<b>你的号码</b>。</p></li>
              <li><h4>中奖</h4><p>刮出的号码只要出现在<b>中奖号码</b>中即可获奖——带 <b>✦ 倍数</b>的格子还会成倍放大奖金。</p></li>
              <li><h4>完成刮卡</h4><p>至少刮开 <b>8 格</b>后点<b>兑奖</b>，或点<b>全部刮开</b>展开整张卡；买<b>新的一张</b>再玩一次。</p></li>
              <li><h4>升级</h4><p>每刮 <b>5 张</b>升一级，解锁更贵、奖金更高的票种。同一票种刮满 50 张可获得<b>金色收藏徽章</b>。</p></li>
              <li><h4>代币不足？</h4><p>余额低于最低票价时，可以领取<b>救济代币</b>继续游戏。</p></li>
            </ul>
            <p className="help-note">代币为虚拟游戏单位，不可兑换现金或实物奖励。</p>
          </section>
        </div>
      )}

      {devArmed && (
        <>
          <button className="dev-fab" onClick={() => setDevOpen((open) => !open)} aria-label="开发者作弊面板" title="开发者作弊面板">🛠</button>
          {devOpen && (
            <section className="dev-panel" role="dialog" aria-label="开发者作弊控制台">
              <header className="dev-head">
                <div><span>DEVELOPER</span><h3>作弊控制台</h3></div>
                <button className="dev-x" onClick={() => setDevOpen(false)} aria-label="收起面板">–</button>
              </header>

              <div className="dev-group">
                <div className="dev-label">金币<b>{formatCoins(player.coins)}</b></div>
                <div className="dev-row">
                  <button onClick={() => devAddCoins(10000)}>+10K</button>
                  <button onClick={() => devAddCoins(100000)}>+100K</button>
                  <button onClick={() => devAddCoins(1000000)}>+1M</button>
                  <button className="dev-danger" onClick={() => devSetCoins(0)}>清空</button>
                </div>
                <div className="dev-row">
                  <input className="dev-input" type="number" inputMode="numeric" placeholder="精确设置金币" value={coinInput}
                    onChange={(event) => setCoinInput(event.target.value)}
                    onKeyDown={(event) => { if (event.key === "Enter") applyCoinInput(); }} />
                  <button onClick={applyCoinInput}>设置</button>
                </div>
              </div>

              <div className="dev-group">
                <div className="dev-label">等级<b>{player.level}</b></div>
                <div className="dev-row">
                  <button onClick={() => devSetLevel(player.level - 1)}>−1 级</button>
                  <button onClick={() => devSetLevel(player.level + 1)}>+1 级</button>
                  <button onClick={() => devSetLevel(maxUnlockLevel)}>满级 {maxUnlockLevel}</button>
                </div>
              </div>

              <div className="dev-group">
                <div className="dev-label">下一张结果</div>
                <div className="dev-seg">
                  {matchOptions.map((option) => (
                    <button key={String(option.value)} className={cheat.forceMatch === option.value ? "on" : ""}
                      onClick={() => setCheat((current) => ({ ...current, forceMatch: option.value }))}>{option.label}</button>
                  ))}
                </div>
              </div>

              <div className="dev-group">
                <button className={`dev-toggle ${cheat.forceMax ? "on" : ""}`} aria-pressed={cheat.forceMax}
                  onClick={() => setCheat((current) => ({ ...current, forceMax: !current.forceMax }))}>
                  <span>超级大奖<small>中奖格给满额奖金 × 最高倍数</small></span><i />
                </button>
                <button className={`dev-toggle ${cheat.freeDraw ? "on" : ""}`} aria-pressed={cheat.freeDraw}
                  onClick={() => setCheat((current) => ({ ...current, freeDraw: !current.freeDraw }))}>
                  <span>免费刮卡<small>购买不扣金币</small></span><i />
                </button>
              </div>

              <div className="dev-group">
                <div className="dev-label">返奖率 RTP<b>{cheat.rtp == null ? "默认" : `${cheat.rtp}%`}</b></div>
                <input className="dev-slider" type="range" min={0} max={RTP_MAX} step={5} aria-label="返奖率 RTP"
                  style={{ "--fill": `${((cheat.rtp == null ? 100 : cheat.rtp) / RTP_MAX) * 100}%` } as React.CSSProperties}
                  value={cheat.rtp == null ? 100 : cheat.rtp}
                  onChange={(event) => setCheat((current) => ({ ...current, rtp: Number(event.target.value) }))} />
                <div className="dev-row">
                  <button className={cheat.rtp == null ? "on" : ""} onClick={() => setCheat((current) => ({ ...current, rtp: null }))}>默认</button>
                  <button className={cheat.rtp === 50 ? "on" : ""} onClick={() => setCheat((current) => ({ ...current, rtp: 50 }))}>50%</button>
                  <button className={cheat.rtp === 100 ? "on" : ""} onClick={() => setCheat((current) => ({ ...current, rtp: 100 }))}>100%</button>
                  <button className={cheat.rtp === 200 ? "on" : ""} onClick={() => setCheat((current) => ({ ...current, rtp: 200 }))}>200%</button>
                </div>
                <p className="dev-sub">仅影响随机结果的奖金大小 · 约 {cheat.rtp == null ? "按配置" : `${cheat.rtp}%`} 返还</p>
              </div>

              <div className="dev-group">
                <div className="dev-row">
                  <button onClick={devDealTicket}>发测试卡</button>
                  <button onClick={() => settle(true)} disabled={ticket.settled}>一键刮开</button>
                </div>
                <div className="dev-row">
                  <button className="dev-danger" onClick={resetSave}>重置存档</button>
                  <button className="dev-danger" onClick={disableDev}>退出作弊</button>
                </div>
              </div>
              <p className="dev-note">仅供开发测试 · 直接修改本机存档 · 不涉及真实货币</p>
            </section>
          )}
        </>
      )}

      <WinConfetti trigger={winFx.n} intensity={winFx.intensity} />
      {winFlash.n > 0 && <div key={winFlash.n} className="win-flash" style={{ "--flash-opacity": (0.35 + winFlash.intensity * 0.65).toFixed(2) } as React.CSSProperties} aria-hidden="true" />}
      <div className="landscape-note">请竖屏以获得最佳体验。</div>
    </main>
  );
}
