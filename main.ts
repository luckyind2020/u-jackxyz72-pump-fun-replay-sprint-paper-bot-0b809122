// Pump.fun Replay Sprint — paper bot (agent-fun/replay/v2).
//
// The bot talks to the harness over stdio with newline-delimited JSON:
// the harness sends a hello, then one batch per tick (events, marks,
// fills, account), then done. The bot answers every batch with one
// reply echoing the batch seq and carrying its orders for that slot.
//
// Strategy: early-momentum sniper on fresh bonding-curve coins.
//   * Watch every new mint from its CreateEvent.
//   * Buy only when the coin shows real early demand: price up at least
//     10% from its creation price inside its first 40 trades, at least
//     4 buys, buy SOL at least twice sell SOL, and real SOL reserves of
//     at least 2 SOL (so the order size can clear the 0.01 SOL minimum
//     round trip while staying under 1% of real reserves).
//   * One small fixed buy per coin (0.05 SOL), at most 5 open positions,
//     at most 3 new entries per batch. One entry per mint, ever.
//   * Exits: take profit at 2.5x, a trailing floor once the coin has
//     run 1.5x (sell if it falls back to 1.05x), stop loss at 0.8x,
//     a time exit after ~24 minutes without progress, and an immediate
//     sell when the curve completes (graduates).
//
// Everything is deterministic: no wall-clock time, no randomness, no
// network, no iteration over unordered keys (candidate mints are always
// scanned in sorted order). Two runs on the same data produce the same
// action log, byte for byte.

import * as readline from "node:readline";

// ---------------------------------------------------------------------------
// Constants (all sizes in lamports; 1 SOL = 1_000_000_000 lamports)
// ---------------------------------------------------------------------------

const LAMPORTS_PER_SOL = 1_000_000_000n;

// Entry sizing.
const BUY_SIZE_LAMPORTS = 50_000_000n; // 0.05 SOL per coin.
const MIN_BUY_LAMPORTS = 10_000_000n; // 0.01 SOL, the minimum round trip.
const MAX_ORDER_BPS_OF_REAL_RESERVE = 90; // harness cap is 100 bps; stay under.
const MAX_NEW_ENTRIES_PER_BATCH = 3;
const MAX_SLIPPAGE_BPS = 500;

// Momentum gate.
const ENTRY_MIN_TRADES = 6;
const ENTRY_MIN_BUYS = 4;
const ENTRY_MAX_TRADES = 40;
const ENTRY_MAX_AGE_SLOTS = 3600; // about 24 minutes of slots.
const ENTRY_MIN_RISE_NUM = 110; // price >= 1.10x creation price.
const ENTRY_MAX_RISE_NUM = 150; // price <= 1.50x creation price (no chasing).
const ENTRY_MIN_REAL_SOL_LAMPORTS = 2_000_000_000n; // 2 SOL of real reserves.
const ENTRY_BUY_DOMINANCE_NUM = 2; // buy SOL >= 2x sell SOL.

// Exits, expressed as price multiples of the entry price.
const TAKE_PROFIT_NUM = 250; // 2.50x: bank the big run.
const ARM_NUM = 150; // 1.50x: arm the trailing floor.
const ARM_FLOOR_NUM = 105; // 1.05x: trailing floor once armed.
const STOP_LOSS_NUM = 80; // 0.80x: cut the loser.
const TIME_EXIT_SLOTS = 3600; // about 24 minutes.
const TIME_EXIT_MAX_NUM = 105; // time exit only below 1.05x.

// ---------------------------------------------------------------------------
// Protocol shapes (only the fields this bot reads)
// ---------------------------------------------------------------------------

interface HelloMessage {
  type: "hello";
  capital: { lamports: string };
  caps: {
    max_open_positions: number;
    max_order_bps_of_real_reserve: number;
    max_orders_per_batch: number;
  };
  latency_slots: number;
}

interface TradeEvent {
  event: "TradeEvent";
  mint: string;
  sol_amount: string;
  token_amount: string;
  is_buy: boolean;
  virtual_sol_reserves: string;
  virtual_token_reserves: string;
  real_sol_reserves: string;
  slot: number;
}

interface CreateEvent {
  event: "CreateEvent";
  mint: string;
  virtual_sol_reserves: string;
  virtual_token_reserves: string;
  slot: number;
}

interface CompleteEvent {
  event: "CompleteEvent";
  mint: string;
  slot: number;
}

type ChainEvent = TradeEvent | CreateEvent | CompleteEvent;

interface Mark {
  mint: string;
  slot: number;
  virtual_token_reserves: string;
  virtual_quote_reserves: string;
  real_token_reserves: string;
  real_quote_reserves: string;
}

interface Fill {
  client_id: string;
  mint: string;
  side: "buy" | "sell";
  status: "filled" | "rejected" | "failed";
}

interface AccountPosition {
  mint: string;
  token_amount: string;
  cost_lamports: string;
}

interface BatchMessage {
  type: "batch";
  seq: number;
  slot: number;
  events: ChainEvent[];
  marks: Mark[];
  fills: Fill[];
  account: { cash_lamports: string; positions: AccountPosition[] };
}

type Order =
  | {
      side: "buy";
      client_id: string;
      mint: string;
      quote_lamports: string;
      max_slippage_bps: number;
    }
  | {
      side: "sell";
      client_id: string;
      mint: string;
      token_amount: string;
      max_slippage_bps: number;
    };

// ---------------------------------------------------------------------------
// Per-coin tracking
// ---------------------------------------------------------------------------

interface CoinState {
  createdSlot: number;
  firstPrice: number; // SOL per token at creation (virtual reserves ratio).
  lastPrice: number; // latest SOL per token.
  trades: number;
  buys: number;
  buySol: bigint;
  sellSol: bigint;
  realSol: bigint;
  complete: boolean;
}

interface HeldInfo {
  entryPrice: number; // SOL per token, from cost / tokens.
  firstSeenSlot: number;
  peakMultiple: number; // highest price / entry price seen so far.
  armed: boolean; // true once the price has run to ARM_NUM.
}

function toBig(value: string | undefined): bigint {
  if (!value) return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function priceOf(virtualSol: bigint, virtualToken: bigint): number {
  if (virtualToken <= 0n || virtualSol <= 0n) return 0;
  return Number(virtualSol) / Number(virtualToken);
}

// ---------------------------------------------------------------------------
// Bot state
// ---------------------------------------------------------------------------

const coins = new Map<string, CoinState>();
const tradedMints = new Set<string>(); // mints we already entered once.
const pendingBuys = new Map<string, string>(); // client_id -> mint.
const held = new Map<string, HeldInfo>();
let orderCounter = 0;
let maxOpenPositions = 5;
let maxOrdersPerBatch = 16;
let cashLamports = 0n;

function nextClientId(kind: "b" | "s"): string {
  orderCounter += 1;
  return `${kind}${orderCounter}`;
}

// ---------------------------------------------------------------------------
// Event handling
// ---------------------------------------------------------------------------

function ensureCoin(mint: string, slot: number, price: number): CoinState {
  let coin = coins.get(mint);
  if (!coin) {
    coin = {
      createdSlot: slot,
      firstPrice: price,
      lastPrice: price,
      trades: 0,
      buys: 0,
      buySol: 0n,
      sellSol: 0n,
      realSol: 0n,
      complete: false,
    };
    coins.set(mint, coin);
  }
  return coin;
}

function applyEvent(event: ChainEvent, batchSlot: number): void {
  if (event.event === "CreateEvent") {
    const price = priceOf(
      toBig(event.virtual_sol_reserves),
      toBig(event.virtual_token_reserves),
    );
    // A coin first seen through a trade keeps that trade's price as its
    // creation price; a later CreateEvent never rewrites it.
    const coin = ensureCoin(event.mint, event.slot, price);
    if (price > 0) coin.lastPrice = price;
    return;
  }
  if (event.event === "TradeEvent") {
    const price = priceOf(
      toBig(event.virtual_sol_reserves),
      toBig(event.virtual_token_reserves),
    );
    const coin = ensureCoin(event.mint, event.slot, price);
    coin.trades += 1;
    const sol = toBig(event.sol_amount);
    if (event.is_buy) {
      coin.buys += 1;
      coin.buySol += sol;
    } else {
      coin.sellSol += sol;
    }
    if (price > 0) coin.lastPrice = price;
    const real = toBig(event.real_sol_reserves);
    if (real > 0n) coin.realSol = real;
    return;
  }
  // CompleteEvent: the curve graduated; the coin leaves the universe.
  const coin = coins.get(event.mint);
  if (coin) coin.complete = true;
}

function applyMarks(marks: Mark[]): void {
  for (const mark of marks) {
    const coin = coins.get(mark.mint);
    if (!coin) continue;
    const price = priceOf(
      toBig(mark.virtual_quote_reserves),
      toBig(mark.virtual_token_reserves),
    );
    if (price > 0) coin.lastPrice = price;
    const real = toBig(mark.real_quote_reserves);
    if (real > 0n) coin.realSol = real;
  }
}

function applyFills(fills: Fill[]): void {
  for (const fill of fills) {
    if (!pendingBuys.has(fill.client_id)) continue;
    pendingBuys.delete(fill.client_id);
    // A buy that did not fill leaves the mint spent: one entry per mint.
  }
}

// ---------------------------------------------------------------------------
// Position bookkeeping (account snapshot is authoritative)
// ---------------------------------------------------------------------------

function refreshHeld(batch: BatchMessage): void {
  const seen = new Set<string>();
  for (const position of batch.account.positions) {
    const tokens = toBig(position.token_amount);
    const cost = toBig(position.cost_lamports);
    if (tokens <= 0n) continue;
    seen.add(position.mint);
    const entryPrice = cost > 0n ? Number(cost) / Number(tokens) : 0;
    const existing = held.get(position.mint);
    if (existing) {
      if (entryPrice > 0 && existing.entryPrice === 0) {
        existing.entryPrice = entryPrice;
      }
      continue;
    }
    held.set(position.mint, {
      entryPrice,
      firstSeenSlot: batch.slot,
      peakMultiple: 0,
      armed: false,
    });
  }
  // Drop coins we no longer hold (sold or flattened).
  for (const mint of [...held.keys()]) {
    if (!seen.has(mint)) held.delete(mint);
  }
}

// ---------------------------------------------------------------------------
// Decisions for one batch
// ---------------------------------------------------------------------------

function entryIsOpen(coin: CoinState, batchSlot: number): boolean {
  if (coin.complete) return false;
  if (coin.trades < ENTRY_MIN_TRADES) return false;
  if (coin.trades > ENTRY_MAX_TRADES) return false;
  if (coin.buys < ENTRY_MIN_BUYS) return false;
  if (batchSlot - coin.createdSlot > ENTRY_MAX_AGE_SLOTS) return false;
  if (coin.firstPrice <= 0 || coin.lastPrice <= 0) return false;
  const riseNum = Math.floor((coin.lastPrice / coin.firstPrice) * 100);
  if (riseNum < ENTRY_MIN_RISE_NUM) return false;
  if (riseNum > ENTRY_MAX_RISE_NUM) return false;
  if (coin.buySol < coin.sellSol * BigInt(ENTRY_BUY_DOMINANCE_NUM)) return false;
  if (coin.realSol < ENTRY_MIN_REAL_SOL_LAMPORTS) return false;
  return true;
}

function decideOrders(batch: BatchMessage): Order[] {
  const orders: Order[] = [];
  const openCount =
    batch.account.positions.length + pendingBuys.size;

  // --- Exits first: manage what we already hold. ---
  for (const position of batch.account.positions) {
    if (orders.length >= maxOrdersPerBatch) break;
    const mint = position.mint;
    const tokens = toBig(position.token_amount);
    if (tokens <= 0n) continue;
    const info = held.get(mint);
    const coin = coins.get(mint);
    const currentPrice = coin ? coin.lastPrice : 0;
    if (!info || info.entryPrice <= 0) continue;
    // No price data for this mint in the stream: treat it as flat so
    // the time exit below can still free the slot instead of leaving
    // the position stuck forever.
    const multiple =
      currentPrice > 0 ? (currentPrice / info.entryPrice) * 100 : 100;
    if (multiple > info.peakMultiple) info.peakMultiple = multiple;
    if (multiple >= ARM_NUM) info.armed = true;

    let sell = false;
    if (coin && coin.complete) sell = true; // graduated: take what is there.
    else if (multiple >= TAKE_PROFIT_NUM) sell = true;
    else if (info.armed && multiple <= ARM_FLOOR_NUM) sell = true;
    else if (multiple <= STOP_LOSS_NUM) sell = true;
    else if (
      batch.slot - info.firstSeenSlot > TIME_EXIT_SLOTS &&
      multiple < TIME_EXIT_MAX_NUM
    ) {
      sell = true;
    }
    if (!sell) continue;
    orders.push({
      side: "sell",
      client_id: nextClientId("s"),
      mint,
      token_amount: position.token_amount,
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    });
  }

  // --- Entries: fresh momentum, while a slot is free. ---
  // Positions we are selling this batch are still open until their
  // fills land, so they still count against the open-position cap;
  // sells never free a slot for an entry in the same batch.
  const freeSlots = Math.max(0, maxOpenPositions - openCount);
  const entriesAllowed = Math.min(
    MAX_NEW_ENTRIES_PER_BATCH,
    freeSlots,
    maxOrdersPerBatch - orders.length,
  );
  if (entriesAllowed > 0 && cashLamports > MIN_BUY_LAMPORTS) {
    let added = 0;
    const candidates = [...coins.keys()].sort();
    for (const mint of candidates) {
      if (added >= entriesAllowed) break;
      if (orders.length >= maxOrdersPerBatch) break;
      if (tradedMints.has(mint)) continue;
      if (held.has(mint)) continue;
      const coin = coins.get(mint);
      if (!coin) continue;
      if (!entryIsOpen(coin, batch.slot)) continue;
      // Size: fixed buy, capped under 1% of real reserves, floored at
      // the minimum round trip the guardrail counts.
      const reserveCap =
        (coin.realSol * BigInt(MAX_ORDER_BPS_OF_REAL_RESERVE)) / 10000n;
      let size = BUY_SIZE_LAMPORTS;
      if (size > reserveCap) size = reserveCap;
      if (size < MIN_BUY_LAMPORTS) continue;
      if (size > cashLamports - 500_000n) continue;
      tradedMints.add(mint);
      const clientId = nextClientId("b");
      pendingBuys.set(clientId, mint);
      orders.push({
        side: "buy",
        client_id: clientId,
        mint,
        quote_lamports: size.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      added += 1;
    }
  }

  return orders;
}

// ---------------------------------------------------------------------------
// Main loop: read hello / batch / done lines, answer every batch.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const lines = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  for await (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let message: {
      type?: string;
      seq?: number;
      slot?: number;
      events?: ChainEvent[];
      marks?: Mark[];
      fills?: Fill[];
      account?: { cash_lamports: string; positions: AccountPosition[] };
      capital?: { lamports: string };
      caps?: {
        max_open_positions: number;
        max_order_bps_of_real_reserve: number;
        max_orders_per_batch: number;
      };
    };
    try {
      message = JSON.parse(trimmed) as typeof message;
    } catch {
      process.stderr.write("bot: skipping unparsable line\n");
      continue;
    }

    if (message.type === "hello") {
      if (message.capital) cashLamports = toBig(message.capital.lamports);
      if (message.caps) {
        maxOpenPositions = message.caps.max_open_positions;
        maxOrdersPerBatch = message.caps.max_orders_per_batch;
      }
      continue;
    }

    if (message.type === "done") {
      break;
    }

    if (message.type !== "batch") continue;
    const batch = message as BatchMessage;

    for (const event of batch.events) applyEvent(event, batch.slot);
    applyMarks(batch.marks);
    applyFills(batch.fills);
    cashLamports = toBig(batch.account.cash_lamports);
    refreshHeld(batch);

    const orders = decideOrders(batch);
    const reply = JSON.stringify({ type: "reply", seq: batch.seq, orders });
    process.stdout.write(reply + "\n");
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`bot: fatal ${String(error)}\n`);
  process.exit(1);
});
