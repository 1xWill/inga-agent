# Inga.Live Agent Arena

Compare and operate autonomous AI trading agents on Polymarket prediction markets. Each agent uses OpenRouter-hosted LLMs with live web search to discover markets, evaluate outcomes, plan sizing through spread/depth/risk gates, and execute trades in **paper** or **live** mode. A Next.js dashboard tracks real-time positions, activity timelines, market evaluations, and portfolio equity curves across agents.

### Tech Stack
- **Runtime & UI:** TypeScript, Node 20+, Next.js 15, React 19, Tailwind CSS
- **Markets & Intelligence:** Polymarket Gamma + CLOB APIs, OpenRouter Chat Completions (with Web Search plugin)
- **Persistence:** SQLite (`better-sqlite3`) for local paper trading; PostgreSQL (`pg`) for production multi-service deployments

---

## 1. Quickstart: Run the Demo Locally

Prerequisites: **Node 20.10+** and **npm 10+**.

### Step 1: Instant Dashboard Demo (Zero API Keys)
Seed local SQLite (`data/inga.sqlite`) with sample multi-agent positions, market evaluations, trade fills, and 72-hour equity curves, then start the Next.js server:

```bash
npm install
npm run demo:seed
npm run dev
```

Open **http://localhost:3000** to explore the dashboard across all 5 agents (`GPT 5`, `GROK 4`, `CLAUDE 4.5`, `DEEPSEEK V3.1`, `QWEN3 MAX`):
- **Positions tab:** Per-agent cash, open holdings, mark-to-market unrealized P&L, TP/SL targets, and expandable closed rounds.
- **Activities tab:** Chronological feed of buys, exits, and planner decisions with LLM rationales and citations.
- **Evaluations tab:** Quick/deep market research summaries with links out to Polymarket.

### Step 2: Run Live AI Paper Trading
By default, all agents in `config/agents.json` have `"paperTrading": true`. To watch an agent discover live Polymarket markets, research them via OpenRouter web search, and simulate fills into `data/inga.sqlite`:

1. Copy the environment template and set your `OPENROUTER_API_KEY`:
   ```bash
   cp .env.example .env
   ```
2. Run a single evaluation/monitoring cycle or a bounded 3-minute demo for an agent:
   ```bash
   # Single cycle (persists to data/inga.sqlite by default)
   npm run agent:once -- --agent agent_grok

   # Or run a bounded 3-minute paper loop
   npm run agent:demo3m -- --agent agent_grok
   ```
3. Keep `npm run dev` running—the dashboard automatically refreshes as new evaluations, instructions, and simulated fills land in `data/inga.sqlite`.

---

## 2. Architecture & Pipeline Flow

```text
[CLI / Worker Scheduler]
   │
   ├─ 1. Discovery (shared cache optional)
   │      └─ Keyword search + composite feeds (endingSoon, updatedAt, volume, liquidity, trending)
   ├─ 2. Event Prep
   │      └─ Sibling market expansion, CLOB token ID resolution, order book & fee hydration
   ├─ 3. LLM Decisions
   │      ├─ Quick phase: filter candidates (trade vs. no-trade + primary outcome)
   │      └─ Deep phase: position sizing, TP/SL targets, multi-leg & rotation proposals
   ├─ 4. Planner & Risk Gates
   │      └─ Enforce spread, top-of-book depth, net edge (bps), and per-trade/market/run exposure caps
   ├─ 5. Execution
   │      ├─ Paper mode: simulate fills against live order books and persist to SQLite
   │      └─ Live mode: preflight balances/allowances, auto-approve if configured, submit CLOB orders
   ├─ 6. Monitor Loop
   │      ├─ Numeric phase: mandatory on-chain auto-redeem for resolved markets + programmatic TP/SL/time exits
   │      └─ LLM phase: re-evaluate open positions (hold / close / reduce / buy_more)
   └─ 7. Exits & Refreshers
          └─ Order book marks refresher, live order status/TTL refresher, portfolio history snapshots

[Next.js Server]
   └─ SSR Dashboard (app/page.tsx) + internal /api/* routes → React UI (Positions • Activities • Evaluations)
```

### Pipeline Highlights
- **Discovery & Cooldowns:** Combines keyword search (`/public-search`) with randomized composite market feeds. Recently evaluated or traded markets enter a configurable cooldown window so agents do not burn tokens re-researching the same market every tick.
- **Two-Stage LLM Research:** Quick evaluation screens candidates cheaply; only survivors proceed to deep evaluation with full order book depth and portfolio context.
- **Depth-Aware Planner:** Computes expected fill price across order book levels, verifies net edge (`minEdgeBpsNet`), and clamps order size to available risk headroom (`perTradeMax`, `perMarketMaxPct`, `perRunMaxPct`). Once `dailyLossLimitPct` is breached for the day, new market evaluations pause while numeric exits continue protecting open positions.
- **Unified TP/SL & Resolution Handling:** Each position has a single effective take-profit and stop-loss target shared across the planner, monitor loop, exits loop, and UI. When a market resolves on Gamma, marks switch to payout (`0` or `1`) without hitting `/book`, and the numeric monitor automatically redeems winning ERC-1155 shares on Polygon.

---

## 3. Configuration Guide

All configuration lives in `config/` and is validated at runtime via Zod (`src/config/schema.ts`). No code changes are required to tune behavior or add agents.

### `config/agents.json`
Defines the competing agents. Top-level `defaults` merge into every agent entry before validation:

| Key | Type | Description | Notes |
| --- | --- | --- | --- |
| `id` | `string` | Stable agent identifier (e.g. `agent_grok`) | Used as foreign key across DB tables |
| `label` | `string` | UI display name | Shown in agent strip and tables |
| `logo` | `string` | Path under `public/` (e.g. `/logos/grok.png`) | UI avatar |
| `modelProvider` | `string` | `"openrouter"` | Default set in `defaults` |
| `model` | `string` | OpenRouter model ID (e.g. `x-ai/grok-4-fast`) | Configurable per agent |
| `paperTrading` | `boolean` | `true` for paper mode, `false` for live CLOB trading | Defaults to `true` |
| `enabled` | `boolean` | Include agent in runner loops and dashboard | Defaults to `true` |
| `walletPrivateKeyEnv` | `string` | Env var name holding the agent's Polygon L1 private key | Required only when `paperTrading: false` |
| `walletAddressEnv` | `string` | Env var name holding the agent's Polygon address | Optional; auto-derived from private key |
| `research.quickProfile` | `string` | Key in `runtime.llm.profiles` | Fast/low-token profile |
| `research.deepProfile` | `string` | Key in `runtime.llm.profiles` | Deep analysis profile |
| `execution.maxOpenPositions` | `number` | Max concurrent open positions per agent | Default `8` |
| `chartStyle` | `object` | `{ color, glyph }` for equity chart series | UI styling |

### `config/runtime.json`
Controls discovery, LLM profiles, prompts, gating, execution, risk, exits, and presentation:

- **`discovery.keywords` & `discovery.polling`:** Set `include` keywords, `excludeTags`, `marketFetchLimit` (markets evaluated per tick), and polling cadences (`marketFetchIntervalMinutes`, `positionMonitorIntervalMinutes`).
- **`discovery.marketData`:** Configure `compositeSorts` (`endingSoon`, `updatedAt`, `volume`, `liquidity`, `trending`), TTL bounds, order book hydration (`includeOrderBooks`), and CLOB token resolution strategies.
- **`cooldowns`:** `postDecisionMinutes` and `discoveryMinutes` suppress repeat evaluations.
- **`llm.profiles` & `llm.research`:** Token budgets, temperatures, timeouts, candidate caps (`preFilterInputCap`, `preFilterOutputCap`), Exa web search result limits (`webSearch.quickMaxResults`, `deepMaxResults`), and domain exclusions.
- **`llm.prompts.decision` & `llm.prompts.monitor`:** Inject custom operator instructions (`system[]` and `user[]` string arrays) prepended to the built-in quick, deep, and monitor prompts.
- **`decision.tradeEvaluation`:** `targetSelection.minConfidence`, `maxTargets`, `minEdgeBps`, and liquidity gating (`maxSpreadPct`, `minTopBookNotional`, `liquidityLevels`).
- **`decision.risk` & `decision.exits`:** Safety caps (`perTradeMax`, `perMarketMaxPct`, `perRunMaxPct`, `dailyLossLimitPct`) and exit thresholds (`takeProfitPct`, `stopLossPct`, `maxHoldingMinutes`, `consecutiveTriggers`, `minExitTopBookNotional`).
- **`execution`:** Sizing mode (`auto_scale_to_depth`), slippage model (`depth_aware`), capital rotation flags, and `live` submission controls (`dryRun`, `submitJitterMs`, `maxOrdersPerSecond`, `autoCancel`).
- **`portfolio` & `presentation`:** Initial paper balance (`balances.initialBalance`), marks refresh cadence, history retention/bucketing, and UI dust filter (`ui.minOpenQuantity`).

---

## 4. Going Live: Polymarket CLOB & Wallet Setup

When you are ready to move an agent from paper mode to real on-chain/CLOB execution on Polygon:

### Step 1: Configure Wallet & Derive L2 Credentials
Each live agent uses a dedicated Polygon EOA wallet funded with **USDC.e** (`0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`) and a small amount of **POL/MATIC** for approval gas.

1. Set the agent's L1 private key in `.env` (for example, `POLY_WALLET_KEY_GROK`).
2. Derive Polymarket L2 API credentials (`POLY_API_KEY_<SUFFIX>`, `POLY_API_SECRET_<SUFFIX>`, `POLY_API_PASSPHRASE_<SUFFIX>`):
   ```bash
   POLY_L1_PRIVATE_KEY=<your_private_key> npm run polymarket:keys -- --write .env
   ```
3. Verify account connectivity and balances:
   ```bash
   npm run polymarket:account -- --agent agent_grok --mode snapshot
   ```

### Step 2: Approve Spenders
- **Manual approval (recommended before first run):**
  ```bash
  npm run polymarket:approve-usdc -- --agent agent_grok --amount 25000
  ```
- **Automatic preflight approvals:** You can also set `POLY_AUTO_APPROVE_USDC=true` in `.env`. Before every live BUY or SELL, the execution helper checks `getBalanceAllowance` for the specific spender required by that market (standard exchange vs. `negRiskExchange` / `negRiskAdapter`), submits `approve` or ERC-1155 `setApprovalForAll` if needed, waits for confirmation, and only posts to the CLOB once allowance is verified.

### Step 3: Dry-Run Verification → Live Execution
1. In `config/agents.json`, set `"paperTrading": false` for the target agent.
2. Keep `"execution.live.dryRun": true` in `config/runtime.json` and run a bounded verification pass (requires Postgres configured via `DB_DRIVER=postgres` and `DATABASE_URL`):
   ```bash
   npm run agent:demo3m -- --agent agent_grok
   ```
3. Once verified, set `"execution.live.dryRun": false` in `config/runtime.json` and start the continuous runner:
   ```bash
   npm run agent:loop -- --agent agent_grok
   ```

---

## 5. Production Deployment (Postgres & Railway)

In production, run two services from this repository sharing a single PostgreSQL database:
- **Web Service (`inga-web`):** Runs `npm run build && npm run start` to serve the SSR Next.js dashboard.
- **Worker Service (`inga-worker`):** Runs `npm run db:migrate` on deploy, then `npm run agent:loop -- --all` (or one worker per agent) to execute discovery, monitoring, exits, and live portfolio snapshots.

### Required Production Environment Variables

| Variable | Service | Description |
| --- | --- | --- |
| `DB_DRIVER=postgres` | Web & Worker | Use PostgreSQL storage adapter |
| `DATABASE_URL` | Web & Worker | PostgreSQL connection string (keep `?sslmode=require` on Railway) |
| `PGPOOL_MAX=3` | Web & Worker | Bounds per-process pool connections (`PG_IDLE_TIMEOUT_MS=30000`, `PG_CONNECTION_TIMEOUT_MS=5000`) |
| `PG_APP_NAME` | Web & Worker | Set `inga-web` on web and `inga-worker` on worker for `pg_stat_activity` visibility |
| `OPENROUTER_API_KEY` | Web & Worker | OpenRouter API key for LLM calls |
| `INTERNAL_API_KEY` | Web & Worker | Shared secret required by `middleware.ts` for internal `/api/*` requests |
| `DISABLE_OPERATOR_API=true` | Web | Disables `/api/agent/*` trigger routes in production |
| `WORKER_ENABLE_AUTOCANCEL=true` | Worker only | Enables TTL cancellation of stale live orders on the worker (never set on Web) |
| `POLY_WALLET_KEY_<SUFFIX>` | Web & Worker | Per-agent L1 private key + `POLY_API_KEY_<SUFFIX>`, `POLY_API_SECRET_<SUFFIX>`, `POLY_API_PASSPHRASE_<SUFFIX>` |

### Internal API Gate (`middleware.ts`)
All `/api/*` endpoints are blocked from the public internet by `middleware.ts` unless the request originates from `localhost` (in development) or a private network host (`*.railway.internal`) and includes the header `x-inga-internal-key: $INTERNAL_API_KEY`. The main dashboard UI (`app/page.tsx`) renders server-side and reads directly from the storage layer without exposing `/api/*` to browsers.

### Optional: PgBouncer (Transaction Mode)
Each Node process uses a singleton pool capped at `PGPOOL_MAX=3`, which handles standard deployments without extra infrastructure. If you scale out to many serverless web replicas, you can place `edoburu/pgbouncer` (`POOL_MODE=transaction`, `DEFAULT_POOL_SIZE=5`) in front of Postgres and point `DATABASE_URL` to the internal PgBouncer host.

---

## 6. CLI Reference, Testing & Troubleshooting

### CLI Scripts
| Command | Description |
| --- | --- |
| `npm run dev` | Start local Next.js development server at `http://localhost:3000` |
| `npm run demo:seed` | Populate `data/inga.sqlite` with sample multi-agent demo data |
| `npm run build && npm run start` | Build and serve the production Next.js bundle |
| `npm run agent:once -- [--agent <id>] [--db <path>]` | Run one full monitor + discovery cycle (defaults to `data/inga.sqlite`) |
| `npm run agent:loop -- [--agent <id> \| --all]` | Start continuous discovery, monitor, and refresher loops |
| `npm run agent:demo3m -- [--agent <id>]` | Run agent loop for a bounded 180-second session |
| `npm run positions:close -- [--agent <id>] [--submit]` | Close open positions (simulates in paper mode; submits market SELLs in live mode with `--submit`) |
| `npm run positions:sync-live` | Reconcile Postgres `positions` table against live on-chain/CLOB conditional balances |
| `npm run polymarket:keys -- [--write .env]` | Derive L2 CLOB API credentials from `POLY_L1_PRIVATE_KEY` |
| `npm run polymarket:approve-usdc -- --agent <id>` | Set ERC-20 USDC.e allowances on Polygon for Polymarket exchange contracts |
| `npm run polymarket:account -- --agent <id> --mode <snapshot\|balance\|trades\|scope>` | Inspect live CLOB balances, allowances, and trade history |
| `npm run db:info -- [--file data/inga.sqlite]` | Print active SQLite file path and table row counts |
| `npm run db:migrate` | Run idempotent PostgreSQL schema migrations against `DATABASE_URL` |
| `npm run analyze:evaluations -- [--db data/inga.sqlite]` | Print statistical summary of recorded LLM market evaluations |
| `npm run test` | Run Vitest unit and live integration suite (requires `OPENROUTER_API_KEY`) |

### Troubleshooting
- **Dashboard is empty on first start:** Run `npm run demo:seed` for instant sample data, or run `npm run agent:once -- --agent agent_grok` with `OPENROUTER_API_KEY` set in `.env`.
- **`Missing OPENROUTER_API_KEY` when running tests or agents:** Copy `.env.example` to `.env` and set a valid OpenRouter key.
- **Live mode shows zero balance:** Verify `paperTrading: false` in `config/agents.json`, confirm `POLY_*` credentials for that agent suffix, and ensure the wallet holds USDC.e on Polygon (`chainId: 137`).
- **CLOB `400 not enough balance / allowance`:** Run `npm run polymarket:approve-usdc -- --agent <id>` or set `POLY_AUTO_APPROVE_USDC=true` in `.env` (requires MATIC for gas). Inspect spender-specific allowances with `npm run polymarket:account -- --agent <id> --mode scope`.

---

## 7. Repository Map

- `app/` — Next.js App Router UI (`app/page.tsx`, `app/components/`) and internal API routes (`app/api/`)
- `config/` — `agents.json` (agent definitions) and `runtime.json` (pipeline, LLM, risk, and UI settings)
- `src/agent/` — Core runner (`runner.ts`), CLI entrypoints (`cli.ts`, `demo.ts`), SQLite schema/repository (`db.ts`, `repository.ts`), and portfolio managers
- `src/agent/pipeline/` — Market discovery, event preparation, quick/deep LLM decisions, planner risk gates, monitor, and exits
- `src/clients/` — Polymarket Gamma/CLOB clients, live order client, OpenRouter client, and token ID resolver
- `src/server/` — Live account snapshot reconstruction, exits P&L attribution, and SSR page loaders
- `src/storage/` — Unified storage interface with SQLite (`sqlite.ts`) and PostgreSQL (`pg.ts`, `pgPool.ts`) adapters
- `scripts/` — Demo seeder, DB migration/inspection tools, and Polymarket operator CLIs
- `tests/` — Vitest unit and live integration test suites

---

## License

Released under the [MIT License](./LICENSE).
