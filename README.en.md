# dsh-auto-continue

[中文说明](README.md) · English

When the provider rejects a model request for a reason that resending the same
request cannot fix (by default only `INVALID_REQUEST`), start a fresh turn after
15s / 60s / 240s and carry on — at most 3 times; once the budget is spent, the
decision goes back to the human.

What it does is exactly what a human does by typing "continue", except the plugin
does it for you, within a budget, and books it under its own durable message
source (`source.kind = 'auto-continue'`, rendered in the UI as a notice line
rather than impersonating something you said).

## Why not a request-level retry

| Fact | Source |
| --- | --- |
| A 400 is classified as `INVALID_REQUEST`; the retry plugin finds no such code in its retryable set and calls `next()`, ending the whole turn immediately | `packages/llm/llm-pi-ai/src/stream.ts:48-49`, `packages/llm/llm/src/retry-policy.ts:18-24`, `packages/llm/llm-retry/src/index.ts:215-217` |
| Adding it to `retryableCodes` was tried: same `retryId`, 10 backoffs, 130 seconds, every attempt a 400 | session log seq 630–660, `policyKey=["normal",10,[...,"INVALID_REQUEST",...],500,10000,0.1]` |
| A fresh turn after the failure (one new user message) does recover: 44 of 69 failure events succeeded afterwards, 12–53s later | full scan of 292 session logs |
| The only observation point is `reason.error` on `turn/end`: `llm-deepseek` throws on HTTP 4xx and never reaches the `agent/request-error` waterfall; only pi-ai finishes in-band | `packages/llm/llm-deepseek/src/adapter.ts:133-144`, `packages/core/agent-loop/src/agent.ts:375-385` |

Conclusion: **retrying the same body is a dead end; what recovers the run is a new
turn.** That is why this plugin works at turn level, not request level.

## Behaviour contract

State is booked per agent (in-process): `{ consecutive count, pending reservation, timer }`.
The newest `turn/end` has the final say.

1. On `turn/end` where `reason.kind === 'error'`, `reason.error.code` ∈ `codes`, and the
   session has a live registered agent → record a reservation.
2. None is recorded when: `reason.kind` is `aborted` / `max-tokens` / `completed`; the
   `code` is not in the set; the count already reached `maxContinues`; the session has an
   **active** goal (`skipActiveGoal`).
3. The timer is only started once `agent/status` turns `idle`, with delay
   `delaysMs[min(count, len-1)]`.
4. While waiting, any **non-plugin** `user/message` (a human, or a tool-jobs-style
   notification), any `turn/start`, or a transition to `running` → cancels this reservation.
5. When the timer fires it re-checks: plugin not unloaded, agent still registered and
   `status === 'idle'`, and the reservation still the current one → only then submit;
   afterwards `count += 1` and `agent.followup(...)`.
6. Any `assistant/message` (the model actually produced something) or any non-plugin
   `user/message` → count resets to 0.
7. If the submission itself throws → roll the count back and log a warning (a failed
   submission must not eat the budget).
8. Agent disposed, or plugin unloaded → clear timers and state.

The exact body the model sees (hard-coded; changing it changes behaviour):

```
Your previous request was rejected by the provider before it produced any output. Continue the task from the current state. (automatic recovery {n} of {N})
```

The one line you see: `auto-continue {n}/{N} — {code}`.

## Configuration

```yaml
- id: auto-continue
  name: dsh-auto-continue
  config:
    enabled: true
    codes: [INVALID_REQUEST]        # PI_AI_ERROR / UNKNOWN can be added, but think about their semantics first
    maxContinues: 3
    delaysMs: [15000, 60000, 240000] # may be shorter than maxContinues; the last value repeats
    skipActiveGoal: true
```

Invalid values (unknown keys, a zero or negative delay, a non-integer budget, an empty
`codes`) **throw at load time** rather than degrading silently.

## Install

```powershell
cd <path-to>\dsh-auto-continue
npm install            # for exactly one thing: createUserMessage / boundContextSummary from @deepseek-ai/dsh-llm
```

profile (`~/.dsh/profiles/<name>/package.json`):

```json
"dependencies": { "dsh-auto-continue": "link:<path-to>/dsh-auto-continue" },
"dsh": { "profile": { "bundles": [ "...", "dsh-auto-continue" ] } }
```

Then `pnpm install` (if it reports a lockfile conflict: `$env:CI='true'` plus
`--no-frozen-lockfile`), and **restart `dsh web`** — `patchReload: live` covers cordis
config only, not plugin code on the node side.

Dependency convention (following the existing layout of `dsh-tool-bridge`):
`@deepseek-ai/dsh-llm` appears in both `peerDependencies` and `devDependencies`, because
under a `link:` install Node resolves from the plugin's realpath and the profile's
`node_modules` is not an ancestor of it. After upgrading dsh, bump both in step
(`npm install @deepseek-ai/dsh-llm@<new version>`).

> If the "duplicate core package" symptom appears (every tool call reports
> `Cannot read properties of undefined (reading 'prepare')`), replace that one import line
> in `index.js` with 6 equivalent hand-written lines and the dependency edge disappears:
> `deepFreeze(structuredClone({ id: randomUUID(), role: 'user', content, source }))`
> — semantically identical to `createUserMessage` (`packages/llm/llm/src/message.ts:246-253`),
> at the cost of decoupling from the upstream constructor.

## Acceptance

```powershell
npm test                                     # state-machine unit tests (fake ctx, no DSH runtime)
node scripts/mock-gateway.mjs                # terminal 1: the first POST /responses returns 400, the rest go to the real gateway
dsh web --patch scripts/acceptance.overlay.yml   # terminal 2: redirects only the command-code baseURL
npm run stats                                # recovery rate from session logs (works before and after installing)
```

The mock end-to-end looks for three things: the failure line appears; an
`auto-continue 1/3 — INVALID_REQUEST` notice line appears; 15 seconds later the second
request succeeds and the task runs to completion.

`npm run stats` sample output (baseline: with the plugin not yet installed,
`automatic continuations: 0`):

```
INVALID_REQUEST turns:    69
automatic continuations:  0
```

## Known costs and risks

- **Deterministic variants are not recoverable.** Of the gateway's three kinds of 400,
  `unknown field "summary"` (9 times) and `reasoning_text must be passed back` (4 times)
  are problems in the request body itself, so a fresh turn fails the same way — those 3
  budget slots are pure loss. The real fix is either gateway-side, or turning off the
  corresponding reasoning fields.
- **It speaks for you when you are not there** (subagents included). That is why it lives
  out of tree and, by default, only acts on `INVALID_REQUEST`.
- **Goal sessions are skipped.** goal-round-driver disarms on `agent/error` and hands
  automatic work back to a human resume; this plugin must not route around that fence. To
  let it continue goal sessions, set `skipActiveGoal` to false (cost: the continuation
  happens outside the goal round count).
- **Subagents continue too.** Evidence: 7 subagent sessions hit the same error; not
  catching it directly corrupts the parent agent's `send_message` result.
- **In-process counters.** They reset on restart — after a restart there is no
  "just-failed idle agent", so persistence is unnecessary.

## Non-goals

No request-level degraded resend (disabling reasoning, lowering effort); no stuffing the
provider's trace_id into model context; no UI buttons or slash commands; no seizing
continuation authority on goal sessions; no cross-process persistent counters.

## License

[MIT](LICENSE)
