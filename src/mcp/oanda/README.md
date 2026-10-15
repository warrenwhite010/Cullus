# `oanda-trading` MCP server

An OANDA trading desk exposed as MCP tools, plus the shared parameter file that
lets the model tune the **OandaVisualBot** macOS app while it runs.

Two things live here:

- **Analysis and execution tools** the model calls directly (this server talks to
  the OANDA v20 REST API, so it works whether or not the Swift app is running).
- **`~/.assistant/oanda-bot.json`** — one parameter set read by this server, by
  the backtester, and by the app at the top of every polling cycle. Changing it is
  how a backtested improvement reaches the live bot without a rebuild.

## Setup

1. **Settings → Connections → OANDA**: API token (OANDA portal → Manage API
   Access) and account ID (e.g. `001-004-1234567-001`).
2. Leave **Environment** blank or set `practice`. Only the exact string `live`
   selects the live host, so a typo cannot point this at real money.
3. `npm run build`, then restart Cullus Ai assistant.

Environment variables work too, and are what the Swift app already reads:
`OANDA_API_TOKEN`, `OANDA_ACCOUNT_ID`, `OANDA_ENVIRONMENT`,
`OANDA_BOT_PARAMS_PATH`.

## Safety model

The server is **locked (read-only) by default**. Locked means every analytical
tool works and the four order tools refuse. Unlock with the 🔒 toggle next to
`oanda-trading` in Settings → Connections.

Three independent gates, because any one of them could be one bug away from a
filled trade nobody asked for:

| Gate | Where | What it stops |
|---|---|---|
| Tool withholding | `mcpManager` read-only filter | The order tools are not offered to the model at all |
| Fast refusal | `handle()` in `server.ts` | An order tool called anyway returns `refused: read-only` before any network call |
| API refusal | `OandaApi.requireTrading` | Any code path that reaches submission throws |

On top of that, **every order tool requires `confirm: true`**. Without it the
tool prices the trade, runs all risk checks, and returns the plan — a dry run.

## Tools

### Analysis (always available)

| Tool | Use it for |
|---|---|
| `oanda_status` | NAV, margin, open trades, open risk vs. the ceiling, session clock, FIFO state. Start here. |
| `oanda_market_scan` | The flagship. Per instrument, **using that pair's own profile**: bid/ask/spread, ATR, ADX, its strategies' signals, session verdict, FIFO state, consensus score, risk-based size, and every blocker. |
| `oanda_trade_consensus` | "Does this trade look good?" — a signed −100…+100 score across M15/H1/H4 plus per-strategy votes, a take/lean/wait/avoid verdict, cautions, and the sized order it implies. |
| `oanda_rank_instruments` | Which pairs are worth trading and with which strategy. Tests each strategy on each pair **separately** out of sample and emits ready-to-apply profiles. |
| `oanda_session_clock` | Which centres are quoting, overlaps, weekend gap, 17:00 ET rollover, per-pair tradeability and liquidity score. DST-correct. |
| `oanda_fifo_check` | Would this entry open a position or silently reduce one? What is the only legal close order? |
| `oanda_candles` | Historical candles with ATR/ADX/RSI/SMA attached, for ad-hoc analysis. |
| `oanda_position_size` | Risk budget → units. Never pick a round number by hand. |
| `oanda_backtest` | Current or patched parameters over real history: expectancy in R, profit factor, max drawdown, per-strategy and per-instrument breakdown. |
| `oanda_optimize` | Walk-forward grid search. Pass `perInstrument: true` — a global fit is the compromise that suits no pair. |
| `oanda_trade_review` | Post-mortem on real **closed** trades, with a diagnosis of what the exit mix implies. |
| `oanda_open_trade_review` | The live counterpart: for every trade **open right now** — entry vs. current exit price, unrealised P/L, pips to its own stop and target, progress in R, days held, financing accrued, and what happens if either bracket is hit. Flags a missing stop, an inverted reward:risk, and a trade 1R in front with its stop still behind entry. |
| `oanda_trade_roi` | Is this worth the risk? Reward-to-risk from the brackets, the break-even hit rate they imply, expectancy at **this account's own** historical hit rate for the pair, and the drag from spread and carry. Works on an open trade (`tradeID`) or a proposal (`instrument` + `direction`). |
| `oanda_pretrade_research` | The qualitative half: web search on the pair, the calendar for both currencies, and rate expectations per central bank — with source URLs and excerpts, plus the session clock and next rollover. Returns evidence and a checklist, never a verdict. |
| `oanda_get_params` | Read the shared parameter file. |

### Mutating (hidden while locked)

| Tool | Effect |
|---|---|
| `oanda_update_params` | Patch the live bot's parameters. Rejects unsafe values outright. |
| `oanda_create_order` | Risk-sized market or limit order with stop and target attached. |
| `oanda_update_trade_brackets` | Move a stop, target or trailing stop on an open trade. |
| `oanda_remove_position` | Close a position, fully or partially. FIFO-safe: the broker applies it server-side. |
| `oanda_close_trade` | Close **one** trade by ID, fully or partially — for when several trades share a pair and only one should go. Refuses before submission if the close would break FIFO, rather than letting the broker reject it. |
| `oanda_remove_pending_orders` | Cancel one or all pending orders. |

## Why the backtester's numbers are worth reading

It is deliberately pessimistic, because the alternative is a beautiful equity
curve that loses money on day one:

- entries fill at the **next** bar's open, so no decision uses a price it could
  not have known;
- the spread is charged on entry **and** exit, taken from a live quote where one
  is available;
- when a bar's range contains both the stop and the target, the **stop** wins;
- size is recomputed from the running equity, so a losing streak shrinks the
  position the way it would live.

A sanity check worth repeating after any change: run it on a random walk. If the
result is not close to break-even, the backtester is broken, not brilliant.

## US accounts: FIFO and no hedging

CFTC/NFA rules make a US OANDA account behave differently in two ways that break
naive bot logic, and `fifo.enabled` defaults to **on** because of them:

1. **No hedging.** You cannot be long and short the same instrument. An
   opposite-direction order *reduces or closes* the existing position. Since the
   strategies now emit shorts, without this guard a short signal on a pair the
   bot is already long would quietly flatten a winning position and log it as a
   new trade. `checkFifoEntry` refuses that and tells you to close first.
2. **FIFO closeout.** With several trades open on one instrument they must be
   closed oldest-first; a close by trade ID that skips an older one is rejected
   with `FIFO_VIOLATION`. So closes go through the *position* endpoint (the broker
   applies FIFO server-side), `risk.maxOpenTradesPerInstrument` is clamped to 1
   while FIFO is on, and `positionFill` is `REDUCE_FIRST` rather than the account
   default we cannot inspect.

`clearAllOrders()` in the app was iterating trades in whatever order the API
returned — an emergency flatten that could leave the newest positions open. It is
now oldest-first.

## Per-pair profiles

By default every pair is scanned with identical parameters, which is the wrong
default: majors trend, crosses range, and their ATRs differ by an order of
magnitude. A profile overrides any section for one instrument:

```json
{
  "profiles": {
    "EUR_USD": { "trend": { "enabled": true }, "meanReversion": { "enabled": false } },
    "USD_JPY": { "granularity": "H1", "riskMultiplier": 0.5 },
    "GBP_JPY": { "disabled": true, "notes": "No positive out-of-sample edge." }
  }
}
```

Generate them with `oanda_rank_instruments`, not by hand — a profile fitted by eye
is curve-fitting with extra steps. `riskMultiplier` is clamped to [0.25, 1.5] and
a disabled pair is dropped from the watchlist entirely.

## Sessions and timezones

Sessions resolve through the timezone database (`Intl` / `TimeZone`), so DST is
correct in both hemispheres — the previous code compared `getHours()` to hardcoded
numbers that assumed the machine was in New York, which drifted by an hour four
times a year across the US/UK/AU/JP switches and could not express an overlap.

- A pair is tradeable when one of **its own** currencies' centres is quoting, so
  EUR_USD is refused during the Asia-only session and USD_JPY is not.
- The London–New York overlap scores highest; `sessions.scaleSizeByLiquidity`
  turns that score into position size instead of an all-or-nothing decision.
- The weekend gap (Fri 17:00 → Sun 17:00 ET) and the 17:00 ET rollover window are
  hard blocks for FX. Crypto is exempt from all of it.

## Financing: the 17:00 ET charge, and why one day costs triple

Two *different* costs land at 17:00 New York, and they need different fixes:

| Cost | What it is | Handled by |
|---|---|---|
| Spread widening | The book thins out for a few minutes around the rollover | `sessions.blockRollover` — refuses **entries** in that window |
| Financing / carry | A charge on the **notional** of everything open at 17:00 | `carry.*` — prices it against the trade's risk |

Financing accrues on the base-currency notional, not on profit. A 25,000-unit
EUR_USD long at −3.1% annualised is about **$2.31/day** — 4.6% of a $50 risk
budget, every day it stays open.

**And one weekday charges three days at once.** OANDA reports
`financingDaysOfWeek`, and for most FX pairs Wednesday has `daysCharged: 3` to
cover the weekend's value dates. That same position costs **$6.94** through the
Wednesday rollover — 13.9% of the risk budget. That is the "extra charge after
5pm": the same mechanism, on the one day it is tripled.

`oanda_carry_check` reports it for a proposed trade or the whole book. The gate
defaults to:

- refuse an entry whose next-rollover financing exceeds **10% of its risk**;
- refuse a **negative-carry** entry within **2 hours** of the tripled rollover —
  paying three days of interest for two hours of exposure.

It never blocks on the raw figure, and never when carry is positive: a trade that
*earns* its financing is a better trade. Per-pair overridable via
`profiles.<PAIR>.carry`.

**`checkRolloverCutoff()` was lying.** It used `Calendar.current`, so it fired at
16:55 in whatever timezone the machine was set to rather than New York; then it
printed `"Forcibly flattening trade ID: …"` for every open trade and flattened
nothing. Anyone reading that log would believe their positions had been closed
before rollover. It now reports the real charge from the account's own rates, and
only closes anything if `carry.flattenBeforeTripleRollover` is explicitly
enabled — off by default, because closing on a schedule closes winners as readily
as losers.

## Consensus

`oanda_trade_consensus` scores four independent reads — structure against both
SMAs, ADX strength, RSI extension, position in the recent range — on each
timeframe, weighted so **coarser timeframes carry more say**. The primary
timeframe decides *when*; the higher ones decide *whether*.

Momentum extremes reduce the score rather than flipping it: flipping would be a
mean-reversion bet dressed up as consensus. A signal that fights the higher
timeframe returns `avoid`, and the live bot refuses it.

## The intended loop

```text
oanda_status            → what am I working with?
oanda_session_clock     → is anything even open right now?
oanda_rank_instruments  → which pairs are worth trading, with which strategy?
oanda_optimize          → perInstrument: true, tune the survivors
oanda_update_params     → adopt; the app picks it up next cycle
oanda_market_scan       → what is set up, and what is blocking it?
oanda_trade_consensus   → does this specific trade look good?
oanda_pretrade_research → is there news or a release about to run it over?
oanda_trade_roi         → is the reward worth the risk at my real hit rate?
oanda_fifo_check        → will this order open or reduce?
oanda_create_order      → confirm: true

  ...then, while it is on:

oanda_open_trade_review     → where is it, in R, and is the stop still behind entry?
oanda_update_trade_brackets → 1R in front: move the stop to break-even
oanda_close_trade           → this one is done; leave the others alone
oanda_trade_review          → after ~30 live trades, what actually happened?
```

`oanda_optimize` and `oanda_rank_instruments` will often say *"nothing beat the
current parameters"* or *"no pair showed a durable edge."* Those are real results,
not failures — trading none of them beats trading all of them.

## Two features that ship OFF because they measured worse

`entry.partialTakeProfitFraction` and `entry.trailAfterR` are both `0` by default,
against the usual advice, because the backtester priced them and they cost money:

| Setting | Expectancy |
|---|---|
| Neither | **0.161R** |
| Break-even trail at 1R | 0.113R |
| Scale out 50% at 1R | 0.026R |
| Scale out 33% at 1R | 0.009R |

Scaling out caps the winners that pay for the losers without shrinking the losers;
a stop parked at entry converts would-be winners into scratches. That test ran on
synthetic series with no autocorrelation, which is the least favourable case for
both — so the machinery is fully implemented, backtested and per-pair
configurable. Price it on *your* pairs with
`oanda_backtest { "paramPatch": { "entry": { "partialTakeProfitFraction": 0.5 } } }`
before switching either on.

## Relationship to the Swift app

| Concern | Owner |
|---|---|
| Placing orders on a 60-second loop | OandaVisualBot (`BotEngine`) |
| Signals, sizing, risk vetoes | Both, from the same parameters |
| Parameters | `~/.assistant/oanda-bot.json` |
| Backtesting and tuning | This server |

`params.ts` and `OandaVisualBot/Trading/StrategyParameters.swift` are mirrors —
change one and change the other. Likewise `indicators.ts` and
`Trading/Indicators.swift`: if they disagree on what `ATR(14)` means, the
backtest describes a strategy nobody is running.

The Swift side clamps whatever it reads (`clampToSafeRanges`), so the worst a
bad parameter file can do is make the bot more conservative.

## No guarantees

Better risk mechanics improve the *distribution* of outcomes; they do not create
edge. Everything here is built so that a claim about profitability can be
checked rather than asserted — and so that a bad run costs a known fraction of
the account instead of an unknown one. Test on a practice account first, and keep
the server locked until a walk-forward result justifies unlocking it.
