// Trade-count launch sniper for the 24-hour pump.fun replay sprint.
//
// The read that drives everything: by the time a coin shows momentum it has
// usually already topped. The money is at the launch, in the first trades,
// before the crowd — and the way to keep it is to cut losers fast and let the
// rare runner run. So this bot only ever buys a coin while it is still young
// (ten trades or fewer on its tape), only when the opening tape looks honest,
// and exits on a fixed set of rules the moment the story breaks.
//
// Entry (decided while the coin is young):
//   * rug filter on the opening tape: the creator's own buy in the create
//     slot is real skin in the game (0.05–1.5 SOL, not nothing and not a
//     bundle about to dump), the creator has not sold, only a handful of
//     other wallets bought in (a launch bundled by many wallets is a dump
//     in waiting), sells have not overwhelmed buys, and no single sell is
//     large against the real SOL reserve;
//   * the curve holds real SOL in a tradeable band, and its price has not
//     already run away from the create price;
//   * recent flow is positive: net SOL in over the last few slots, from at
//     least one distinct recent buyer.
//
// Sizing: one buy per coin, up to `stakeSol`, capped at 1% of the curve's
// real SOL reserve (the harness cap) and at least `minBuySol` to be worth
// the transaction fee.
//
// Exits: the position is cut at a stop loss against cost, or the moment the
// creator sells. It is banked in full at the first take-profit level. In
// between, a trailing stop protects a gain once the position is up a little:
// after rising at least `trailArm`, a fall of `trail` from the best value
// seen exits. A fade in recent flow or a single whale sell also exits, and a
// position held too long is closed unless it is well up. Once the curve is
// near bonding completion (real SOL close to the ~85 SOL target) the bot
// rides it — the harness closes it at the final reserves, usually the best
// exit available — so fade, trail and whale exits pause while riding.
//
// Guardrail pacing: the competition ranks below every entry that misses it,
// so the bot must finish with round trips of >= 0.01 SOL on >= 20 coins and
// a drawdown <= 50%. The sniper trades far more than that on its own, but a
// pace check (own fills and coins vs elapsed block time) opens tiny probe
// round trips on liquid curves whenever the bot falls behind pace.
//
// Deterministic by construction: no clock, no randomness, iteration only
// over insertion-ordered maps fed by the batch stream.

import type { BatchMsg, Mint, OrderAsk, ReplayBook } from "./main.ts";

export interface SniperParams {
  /** Most trades a coin may have on its tape when a first buy is decided. */
  maxEntryTrades: number;
  /** SOL to put into one position in total. */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Real SOL reserve window at decision time. */
  minRqSol: number;
  maxRqSol: number;
  /** Creator's own buys in the create slot: at least / at most this many SOL.
   *  A creator with real skin in the game dumps far less often than one who
   *  bought nothing or one who bought a bundle. */
  minDevBuySol: number;
  maxDevBuySol: number;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Distinct non-creator buyers before entry: at least / at most. */
  minBuyers: number;
  maxBuyers: number;
  /** Lamports sold by others / lamports bought, at most (as a share). */
  maxSellRatio: number;
  /** Largest single non-creator sell, as a share of real SOL before it, at most. */
  maxBigSellShare: number;
  /** Price now over the create price, minus 1: window. */
  minRunup: number;
  maxRunup: number;
  /** Recent-flow window (slots) and what it must show. */
  flowWindow: number;
  minFlowSol: number;
  minRecentBuyers: number;
  /** Slippage on buys (bps); sells always go out wide open. */
  buySlipBps: number;
  /** Exits. */
  stopLoss: number;
  /** Take-profit: sell the whole position once it is worth this much over cost. */
  takeProfit: number;
  /** Trailing stop: once up at least trailArm, exit on a fall of trail from the best value. */
  trailArm: number;
  trail: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** The time limit does not apply while the position is up at least this much. */
  holdIfUp: number;
  /** Exit when net SOL over fadeWindow slots falls below -fadeNetSol. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Hold on (no fade, trail or whale exit) once the curve's real SOL passes this. */
  rideRqSol: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most sniper positions open at once (the rest of max_open_positions is for probes). */
  maxMain: number;
  /** Guardrail pacing: pace the run toward at least this many coins / fills. */
  targetCoins: number;
  targetFills: number;
  /** Seconds of block time the pace is measured over. */
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
}

export const DEFAULT_SNIPER: SniperParams = {
  maxEntryTrades: 10,
  stakeSol: 0.3,
  minBuySol: 0.005,
  minRqSol: 3.0,
  maxRqSol: 30,
  minDevBuySol: 0.05,
  maxDevBuySol: 1.5,
  skipDevSold: true,
  minBuyers: 2,
  maxBuyers: 8,
  maxSellRatio: 0.5,
  maxBigSellShare: 0.2,
  minRunup: -0.05,
  maxRunup: 0.6,
  flowWindow: 10,
  minFlowSol: 0.05,
  minRecentBuyers: 1,
  buySlipBps: 10_000,
  stopLoss: 0.15,
  takeProfit: 0.2,
  trailArm: 0.1,
  trail: 0.15,
  maxHold: 300,
  holdIfUp: 1.0,
  fadeWindow: 20,
  fadeNetSol: 1.0,
  bigSellSol: 3,
  exitOnDevSell: true,
  rideRqSol: 70,
  cooldown: 150,
  maxEntries: 1,
  maxMain: 5,
  targetCoins: 40,
  targetFills: 160,
  paceSecs: 86_400,
  probeSol: 0.02,
  maxProbes: 1,
  maxExposureSol: 3,
};

const LAMPORTS = 1e9;
/** Protocol + creator fee per side, as a share of the trade (95 + 30 bps). */
const CURVE_FEE = 0.0125;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
}

interface Tape {
  created: number | null;
  creator: string | null;
  createPrice: number;
  devBuy: number;
  devSold: boolean;
  buyers: Set<string>;
  bought: number;
  soldByOthers: number;
  bigSellShare: number;
  trades: TapeTrade[];
  entries: number;
  lastExit: number;
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
}

interface Open {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  devSoldAtOpen: boolean;
  lastValue: number;
}

export function createSniper(p: SniperParams = DEFAULT_SNIPER) {
  const tapes = new Map<Mint, Tape>();
  const open = new Map<Mint, Open>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Mint, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Mint>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const tapeOf = (mint: Mint): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = {
        created: null,
        creator: null,
        createPrice: 0,
        devBuy: 0,
        devSold: false,
        buyers: new Set(),
        bought: 0,
        soldByOthers: 0,
        bigSellShare: 0,
        trades: [],
        entries: 0,
        lastExit: -1e12,
        done: false,
      };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) and distinct buyers over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): { net: number; buyers: number } => {
    let net = 0;
    const buyers = new Set<string>();
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
      if (tr.buy) buyers.add(tr.user);
    }
    return { net, buyers: buyers.size };
  };

  return {
    onBatch(book: ReplayBook, batch: BatchMsg): OrderAsk[] {
      const now = batch.slot;
      const bigSell = new Set<Mint>();
      const touched = new Set<Mint>();
      for (const f of batch.fills) {
        if (f.status === "filled" && !f.client_id.startsWith("_")) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null && typeof e.block_time === "number") {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === "CreateEvent") {
          const t = tapeOf(e.mint as string);
          t.created = e.slot as number;
          t.creator = e.creator as string;
          t.createPrice =
            Number(e.virtual_quote_reserves as string) / Number(e.virtual_token_reserves as string);
        } else if (e.event === "TradeEvent") {
          const t = tapeOf(e.mint as string);
          const sol = Number(e.sol_amount as string) / LAMPORTS;
          const isDev = t.creator !== null && e.user === t.creator;
          t.trades.push({
            slot: e.slot as number,
            buy: e.is_buy as boolean,
            sol,
            user: e.user as string,
          });
          touched.add(e.mint as string);
          if (e.is_buy) {
            t.bought += sol;
            if (isDev && e.slot === t.created) t.devBuy += sol;
            else if (!isDev) t.buyers.add(e.user as string);
          } else if (isDev) {
            t.devSold = true;
          } else {
            t.soldByOthers += sol;
            const rqBefore = Number(e.real_quote_reserves as string) / LAMPORTS + sol;
            if (rqBefore > 0) {
              const share = sol / rqBefore;
              if (share > t.bigSellShare) t.bigSellShare = share;
            }
          }
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint as string);
        }
      }
      // Prune old trades: only the fade/flow windows are ever read.
      const keep = Math.max(p.flowWindow, p.fadeWindow) + 5;
      for (const mint of touched) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Mint, number>();
      for (const f of book.inflight.values()) {
        pendingByMint.set(f.mint, (pendingByMint.get(f.mint) ?? 0) + 1);
      }

      const orders: OrderAsk[] = [];
      const cap = book.hello.caps.max_orders_per_batch;
      const tx = Number(book.feePerOrder()) / LAMPORTS;

      // Exits first: a position that must go outranks any new entry.
      for (const [mint, o] of open) {
        const lot = book.lots.get(mint);
        const curve = book.curves.get(mint);
        if (lot === undefined) {
          if (!pendingByMint.has(mint)) {
            open.delete(mint);
            const t = tapeOf(mint);
            if (o.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        o.filled = true;
        if (curve === undefined || curve.done) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.vQuote);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.vToken);
        const rqSol = (mk ? Number(mk.real_quote_reserves) : Number(curve.rQuote)) / LAMPORTS;
        const tokens = Number(lot.tokens);
        // Value of selling the whole position now, curve fee and tx fee deducted.
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(lot.cost) / LAMPORTS;
        if (value > o.peakValue) o.peakValue = value;
        o.lastValue = value;
        const t = tapeOf(mint);
        const riding = rqSol >= p.rideRqSol;
        let exit = o.exiting;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && p.exitOnDevSell && t.devSold && !o.devSoldAtOpen) exit = true;
        if (!exit && !riding && o.peakValue >= cost * (1 + p.trailArm) && value < o.peakValue * (1 - p.trail)) exit = true;
        if (!exit && !riding && flow(t, now, p.fadeWindow).net < -p.fadeNetSol) exit = true;
        if (!exit && !riding && bigSell.has(mint)) exit = true;
        if (!exit && now - o.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        if (exit) {
          o.exiting = true;
          if (pendingByMint.has(mint)) {
            let sellPending = false;
            for (const f of book.inflight.values()) {
              if (f.mint === mint && f.side === "sell") sellPending = true;
            }
            if (sellPending) continue;
          }
          if (orders.length >= cap) break;
          orders.push({ side: "sell", mint, amount: lot.tokens, maxSlippageBps: 10_000 });
          continue;
        }
        // Take-profit: bank the whole position once it is worth this much over cost.
        if (cost > 0 && value >= cost * (1 + p.takeProfit)) {
          if (pendingByMint.has(mint)) continue;
          if (orders.length >= cap) break;
          orders.push({ side: "sell", mint, amount: lot.tokens, maxSlippageBps: 10_000 });
          o.exiting = true;
        }
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const lot = book.lots.get(mint);
        const curve = book.curves.get(mint);
        if (lot === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.done || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: "sell", mint, amount: lot.tokens, maxSlippageBps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Entries: young coins that pass the rug filter, decided on their tape.
      let free = Number(book.spendable()) / LAMPORTS;
      let slotsLeft = book.hello.caps.max_open_positions - book.openSlots();
      let mainLeft = p.maxMain - open.size;
      let exposure = 0;
      for (const [mint, o] of open) {
        exposure += Math.max(o.invested, Number(book.lots.get(mint)?.cost ?? 0n) / LAMPORTS);
      }
      for (const mint of touched) {
        if (orders.length >= cap) break;
        const t = tapes.get(mint)!;
        const curve = book.curves.get(mint);
        if (curve === undefined || curve.done) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        if (slotsLeft <= 0 || mainLeft <= 0) break;
        if (t.done || open.has(mint)) continue;
        if (t.created === null) continue;
        // Young only: the tape must still be short when the first buy is decided.
        if (t.trades.length > p.maxEntryTrades) {
          t.done = true;
          continue;
        }
        if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
        const rqSol = Number(curve.rQuote) / LAMPORTS;
        if (rqSol < p.minRqSol || rqSol > p.maxRqSol) continue;
        // Rug filter on the opening tape.
        if (t.devBuy < p.minDevBuySol || t.devBuy > p.maxDevBuySol) {
          t.done = true;
          continue;
        }
        if (p.skipDevSold && t.devSold) {
          t.done = true;
          continue;
        }
        if (t.buyers.size < p.minBuyers || t.buyers.size > p.maxBuyers) continue;
        if (t.bought > 0 && t.soldByOthers > p.maxSellRatio * t.bought) continue;
        if (t.bigSellShare > p.maxBigSellShare) continue;
        const price = Number(curve.vQuote) / Number(curve.vToken);
        if (t.createPrice > 0) {
          const runup = price / t.createPrice - 1;
          if (runup < p.minRunup || runup > p.maxRunup) continue;
        }
        const fl = flow(t, now, p.flowWindow);
        if (fl.net < p.minFlowSol || fl.buyers < p.minRecentBuyers) continue;
        const capSol = Math.floor(Number(book.buyCap(mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: "buy", mint, amount: lamports, maxSlippageBps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        open.set(mint, {
          opened: now,
          peakValue: 0,
          invested: amount,
          exiting: false,
          filled: false,
          devSoldAtOpen: t.devSold,
          lastValue: 0,
        });
        t.entries++;
        slotsLeft--;
        mainLeft--;
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10_000) / book.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of touched) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (open.has(mint) || probes.has(mint) || pendingByMint.has(mint) || book.lots.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = book.curves.get(mint);
            if (curve === undefined || curve.done) continue;
            if (Number(curve.rQuote) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: "buy", mint, amount: BigInt(Math.floor(p.probeSol * LAMPORTS)), maxSlippageBps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
