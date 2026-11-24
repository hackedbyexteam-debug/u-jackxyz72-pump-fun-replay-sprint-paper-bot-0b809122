# Pump.fun Replay Sprint — Paper Bot, Real Ranking

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/hackedbyexteam-debug/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/hackedbyexteam-debug/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A trade-count launch sniper for the [Pump.fun Replay Sprint](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) bounty on make.fun. It trades 10 SOL of paper money on a 24-hour replay of pump.fun bonding-curve activity; best net PnL wins.

## Idea

By the time a coin shows momentum it has usually already topped. The money is at the launch, in the first trades, before the crowd — and the way to keep it is to cut losers fast and let the rare runner run.

- **Entry, young only:** a coin is bought only while it still has ten trades or fewer on its tape, and only when the opening tape looks honest — the creator bought a real amount (0.05–1.5 SOL, not nothing and not a bundle), has not sold, only a handful of other wallets bought in, sells have not overwhelmed buys, and no single sell is large against the real SOL reserve.
- **Exits:** stop loss −15% against cost, or the moment the creator sells. The whole position is banked at +20%. In between, a trailing stop protects a gain once the position is up 10% (exit on a 15% fall from the peak). A fade in recent flow or a single whale sell also exits, and a position held too long is closed unless it is well up. Near bonding completion (real SOL ≥ 70) the bot rides the curve instead.
- **Guardrail pacing:** tiny probe round trips on liquid curves keep the bot on pace toward 40 coins / 160 fills over the 24 hours, so it clears the minimum bar of 20 coins with round trips of at least 0.01 SOL and a drawdown of at most 50%.

## Files

- `main.ts` — the replay client: speaks `agent-fun/replay/v2` on stdin/stdout, keeps curves, cash and positions current, and hands each batch to the strategy. No network, no clock, no randomness, so the two harness runs agree byte for byte.
- `strategy.ts` — the sniper: entry rug filter, exits, and pace probes.

## Run locally

```sh
node main.ts
```

The bot reads harness NDJSON lines on stdin and writes one reply per batch on stdout. Grade it with the kit's local grader:

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot <this-dir> --driver process
```
