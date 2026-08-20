# Human interventions and messaging

An intervention is a durable control-plane record representing a reason automation cannot safely continue without policy, credentials, a decision, or an operator action. It is not merely a chat message: persistence is the source of truth, while channels are replaceable notification/reply transports.

## Lifecycle

1. Runtime, harness, verification, capability, or MCP code creates a typed intervention with a scope (`task`, `run`, or `agent`).
2. The runtime store commits it before channel delivery.
3. Configured channels receive a notification with a stable human-friendly `DK-…` code.
4. The human replies to that exact message, includes its code, or asks a PM client to resolve the record through MCP.
5. The intervention service performs an idempotent terminal transition and records the action, answer, resolver identity, and timestamps.
6. The PM/runtime requests a supported audited retry/resume control. Exact continuation of an interrupted workflow call across daemon restarts is not implemented yet.

Channel delivery failure never deletes the intervention or fabricates a response. The operator can always inspect and resolve the durable record through MCP.

## Kinds and expected actions

| Kind               | Typical cause                                                 | Safe response                                                                        |
| ------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `product-decision` | Several materially different behaviors are valid              | Give a concise decision as free text.                                                |
| `auth`             | Harness/tracker/SCM/channel needs authentication              | Authenticate out-of-band, then `retry`; never paste a token into chat.               |
| `quota`            | Provider credit/billing limit                                 | Restore quota or switch through an audited control, then retry.                      |
| `rate-limit`       | Bounded retries exhausted                                     | Wait or change the provider/profile, then retry.                                     |
| `approval`         | Managed capability or protected operation has a reviewed plan | Reply `approve` only after matching the plan; an approval alone does not execute it. |
| `agent-failure`    | Workflow/PR lifecycle failed                                  | Read diagnostics/proofs, correct the cause, then retry.                              |
| `stuck-agent`      | No useful progress/terminal state                             | Interrupt, instruct, restart, or switch profile when the harness supports it.        |

The normalized resolution actions are `retry`, `switch-harness`, `approve`, `stop`, and `free-text`. Direct daemon replies map the literal `retry`, `stop`/`cancel`, `approve`, and `switch-harness <profileId>`; every other non-empty message becomes free text. A switch still passes through runtime capability/compatibility checks and should use the exact reviewed lowercase profile ID. MCP remains the least ambiguous control for profile switching.

## Notification and reply examples

```text
🍳 Dark Kitchen — Intervention

Code: DK-01ABC23
Kind: product-decision
Summary: Should the API return 404 or an empty list for an unknown owner?

How to respond (reply to THIS message, or quote the Code):
  • your answer → route it to this question
  • retry → resume the task
  • stop → block the task
```

When only one intervention is pending in a conversation, a plain reply can be routed to it. With concurrent interventions, use the provider's reply-to gesture or include the code:

```text
DK-01ABC23 Return 404 and add an error body.
```

Codes are scoped to the same transport and conversation. They are not authorization tokens.

## Correlation and idempotency

Resolution priority is:

1. exact quoted/replied-to outbound message ID;
2. unique `DK-…` code in the same conversation;
3. conversation fallback only when exactly one intervention is pending there.

Inbound provider message IDs are replay keys. Concurrent processing of the same update is coalesced, a successful reply deactivates every correlation for that intervention, and repeated resolve calls return the already resolved record. Oversized, empty, malformed-timestamp, wrong-channel, wrong-conversation, or unauthorized messages are ignored.

The intervention, outbound message/code correlations, processed inbound message receipts, and terminal resolution are durable across daemon restarts in the stock SQLite store. A delayed provider redelivery is therefore routed at most once after restart. MCP remains the fallback when the provider has lost the original message, a channel is unavailable, or an operator cannot safely identify the intended intervention.

## Delivery behavior

The gateway retries a failed send a bounded number of times with exponential backoff while the process is running. Multiple channel adapters connect independently, so one unavailable provider does not prevent another healthy adapter from starting. Notifications longer than provider limits are truncated with a visible marker; the durable intervention retains its bounded full summary/details. The delivery queue itself is not persisted and open undelivered interventions are not automatically re-emitted after restart; MCP is the recovery path.

Delivery correlation is created only after the provider returns a real message ID. A failed send remains auditable and must not create a false reply target.

## Telegram

```yaml
channels:
  - id: owner-telegram
    kind: telegram
    tokenEnv: TELEGRAM_BOT_TOKEN
    defaultTarget: '123456789'
    allowedSenderIds: ['123456789']
```

The direct Telegram adapter:

- uses long polling by default, with `drop_pending_updates: false`;
- sends plain text so arbitrary intervention content cannot break Markdown parsing;
- treats `defaultTarget` as the allowed inbound chat for stock daemon composition;
- supports optional sender allowlists and authenticated HTTPS webhook mode from project config;
- validates Telegram callback payload size;
- limits webhook bodies, validates the secret header with constant-time comparison, and binds webhook listeners to loopback by default;
- uses Telegram's real `message_id` for reply correlation.

Polling is the stock default. Webhook mode is explicit:

```yaml
channels:
  - id: owner-telegram
    kind: telegram
    tokenEnv: TELEGRAM_BOT_TOKEN
    defaultTarget: '123456789'
    allowedSenderIds: ['123456789']
    telegramMode: webhook
    url: https://dark-kitchen.example
    webhookPort: 8443
    webhookPath: /telegram-webhook
    webhookSecretEnv: TELEGRAM_WEBHOOK_SECRET
```

The public `url` must be HTTPS. `webhookSecretEnv` names an environment variable containing 1–256 Telegram-compatible `[A-Za-z0-9_-]` characters. The stock listener binds `127.0.0.1`; terminate TLS and authenticate/limit ingress at a same-host proxy. Publishing a container port alone does not expose a listener bound to container loopback, so a container deployment needs a same-network-namespace proxy or an embedding host that explicitly supplies a different bind address.

Commissioning:

1. Create the bot with BotFather and keep the token in `TELEGRAM_BOT_TOKEN`.
2. Start a private conversation with the bot and determine its numeric chat ID.
3. Set `defaultTarget` to that exact ID; for groups, review both the chat and sender authorization model.
4. Start Dark Kitchen in the foreground and confirm the channel connects.
5. Create a disposable intervention, reply to the exact message, and verify one durable resolution.
6. Redeliver the same update and confirm it does not resolve a second time.
7. Restart during an open intervention, deliver the delayed reply, and confirm durable correlation plus replay suppression.

Never send a GitHub token, API key, password, or authentication code as an intervention reply. The service redacts common patterns, but redaction is defense in depth rather than a safe credential channel.

## WhatsApp

```yaml
channels:
  - id: owner-whatsapp
    kind: whatsapp
    defaultTarget: '15551234567@c.us'
```

The adapter uses `whatsapp-web.js` with local authentication by default and renders a QR code in the terminal for pairing. Because WhatsApp's self-chat does not consistently emit message events, it also polls recent self-chat messages, deduplicates provider IDs across events/polling, ignores pre-connection history, and suppresses echoes of Dark Kitchen's own outbound body.

WhatsApp is an optional peer integration, not a core runtime dependency. Install the pinned compatible peer only on nodes that enable the channel:

```sh
# Global Dark Kitchen CLI
npm install --global whatsapp-web.js@1.34.7

# Or, beside a repository-local Dark Kitchen dependency
npm install --save-exact whatsapp-web.js@1.34.7
```

If the module is absent, channel startup reports an actionable error while other configured channel adapters continue independently.

Operational constraints:

- pairing requires an interactive terminal and persists user-owned browser/session state;
- a compatible local Chromium environment is required;
- the current adapter is suitable for a user's linked account, not a managed WhatsApp Business API deployment;
- avoid running two clients with the same local auth state;
- QR material and auth directories are sensitive and must not enter logs, backups shared with others, or container images.

## Discord, Slack, and iMessage

- Discord requires `discord.js@14.27.0`, a bot token, and a destination channel ID.
- Slack requires `@slack/bolt@3.22.0` plus bot and app-level tokens because the adapter uses Socket Mode.
- iMessage requires macOS plus permission to access the local Messages data. It is not appropriate for a Linux VPS.

Install only the peers used by that node, in the same global/local dependency location as Dark Kitchen:

```sh
# Global CLI
npm install --global discord.js@14.27.0 @slack/bolt@3.22.0

# Or repository-local CLI
npm install --save-exact discord.js@14.27.0 @slack/bolt@3.22.0
```

The peers are optional so a Telegram-only node does not receive unused bot SDKs. If an enabled peer is absent or its token pair is incomplete, that adapter logs an actionable connection failure while other channel kinds connect independently; if no configured channel can connect, channel startup fails rather than claiming notifications are available.

The direct daemon supports one configuration per channel kind in its unified transport. Distinct providers can run together; duplicate entries of the same kind are rejected.

## OpenClaw

`OpenClawGatewayAdapter` implements the same channel boundary over an authenticated WebSocket gateway, including reconnect/backoff and inbound chat event normalization. It is useful when an embedding deployment already routes Telegram/WhatsApp/Discord/Slack through OpenClaw.

The stock CLI daemon currently composes direct channel adapters, not `kind: openclaw`. A host that composes OpenClaw must preserve OpenClaw pairing/allowlists, use TLS for non-loopback gateways, keep its token out of URLs/logs, and test concurrent intervention correlation. Dark Kitchen core remains usable with no channel or OpenClaw configured.

## ChatGPT PM handoff

A human does not need to manipulate an agent terminal. A typical handoff is:

1. Telegram reports an intervention and the human replies with context.
2. The durable resolution becomes visible to the PM through `dk_get_intervention`/`dk_list_interventions`.
3. The PM inspects the task, run, agent, diagnostics, and relevant GitHub PR/check context.
4. The PM sends a follow-up, requests a supported session/run control, or deliberately starts a fresh task run.
5. An explicit task retry can reuse completed journal entries. Automatic startup recovery of the exact waiting workflow/session is still pending.

`retry` on a task-scoped daemon intervention resumes the supervisor and moves a GitHub task from `dk:blocked` back to `dk:ready`. `stop` marks it blocked and keeps it paused across restarts. Free-text resolves the question but does not automatically choose an unsupported runtime operation; the PM must perform the appropriate audited control.

## Security checklist

- Use a private conversation or tightly controlled group.
- Configure an explicit outbound target/inbound conversation allowlist.
- Use `allowedSenderIds` for shared conversations.
- Keep bot/app/gateway tokens in the service environment or secret manager.
- Keep Telegram webhooks on loopback behind an authenticated HTTPS proxy; require the Telegram secret header.
- Treat replies as untrusted text and never evaluate them as commands.
- Keep provider message IDs/codes scoped to transport + conversation.
- Verify duplicate, concurrent, delayed, malformed, oversized, and post-restart replies in staging.
- Keep MCP available as the durable fallback when a channel is down.
