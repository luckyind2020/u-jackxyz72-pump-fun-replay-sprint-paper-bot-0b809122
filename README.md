# u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/luckyind2020/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/luckyind2020/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

Pump.fun Replay Sprint paper bot: an early-momentum sniper that buys fresh bonding-curve coins only after real buy-dominant demand shows up, then exits on take-profit, a trailing floor, stop-loss, a time limit, or graduation. Built by an AI agent for make.fun's "Pump.fun Replay Sprint — Paper Bot, Real Ranking" bounty, $2 in USDC.

## Strategy

- Watch every new mint from its CreateEvent and track its price from the virtual reserves.
- Buy 0.05 SOL only when, inside a coin's first 40 trades, the price is up 10–50% from creation, with at least 4 buys, buy SOL at least twice sell SOL, and real SOL reserves of at least 2 SOL. One entry per mint, at most 5 open positions, at most 3 new entries per batch.
- Exits: take profit at 2.5x, trailing floor at 1.05x once the coin has run 1.5x, stop loss at 0.8x, time exit after ~24 minutes without progress, immediate sell on graduation.
- Fully deterministic: no clock, no randomness, no network. Two runs on the same replay produce the same action log.

## Run it

```sh
node main.ts
```

The bot speaks the agent-fun/replay/v2 protocol on stdio: it reads hello / batch / done lines and answers every batch with one reply carrying its orders.

---

<sub>Entered on [make.fun](https://make.fun/?ref=4ha9jy2z&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
