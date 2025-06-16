# NEAR Governance Bot
A Telegram bot that delivers real-time notifications about NEAR governance proposals. It listens to on-chain events via the Intear `inevents` WebSocket client (using the NEP-297 standard) and processes Telegram webhook updates to manage subscriptions and commands.

## Features
- **New Proposal Alerts**: Notifies subscribed chats when new proposals are created.
- **Proposal Approval Alerts**: Notifies when proposals are approved for voting.
- **Rich Command Interface**: Full proposal management with detailed views and filtering.
- **Admin Controls**: Group administrators can manage bot subscriptions.
- **Auto-subscription**: Private chats automatically subscribe on first interaction.
- **Detailed Proposal Views**: Comprehensive formatting with voting results, deadlines, and snapshots.
- **Interactive Keyboards**: Quick access buttons for common actions.
- **Webhook Mode**: Fast responses via Telegram webhooks.
- **Rate Limiting**: Compliant with Telegram API limits.
- **Graceful Shutdown**: Proper cleanup of all connections and resources.
- **MongoDB Persistence**: Tracks proposals and subscriptions with automatic cleanup.

## Prerequisites
- Node.js v16 or higher
- npm or yarn
- MongoDB instance (Atlas or self-hosted)
- Telegram Bot Token (create via [@BotFather](https://t.me/BotFather))
- NEAR account with deployed governance contract supporting NEP-297 events

## Installation

1. Clone the repo:
    ```bash
    git clone https://github.com/NEARgovernance/telegram-bot.git
    cd telegram-bot
    ```

2. Install dependencies:
    ```bash
    npm install
    # or
    yarn install
    ```
3. Copy `.env.example` to `.env` and fill in the values:

```env
# Required
VOTING_CONTRACT=vote.hos03.testnet
TELEGRAM_BOT_TOKEN=your_bot_token
MONGO_URI=mongodb://localhost:27017
WEBHOOK_URL=https://your-domain.com

# Optional
WEBHOOK_SECRET=your_webhook_secret
```

## Usage
Start the bot:
```bash
node index.js
```
The HTTP server listens on `PORT` for Telegram webhook updates at `/webhook`.

### Commands
* `/start` — Subscribe this chat to governance updates.
* `/stop` or `/unsubscribe` — Unsubscribe from updates (admin-only in groups).
* `/status` — Check your subscription status.
* `/proposal [ID]` — Get detailed information about a specific proposal.
* `/recent [count]` — Show the most recent proposals (default 5, max 10).
* `/active [count]` — Show recent approved proposals currently voting (default 5, max 10).
* `/help` — Show help and available commands.

## Intear Event Stream Integration
The bot connects to the Intear event stream and process on-chain events.

It uses the `@intear/inevents-websocket-client` library to subscribe to NEAR contract events via Intear’s public WebSocket API.

KEY DETAILS:
* **NEP-297 Standard:** Listens for `log_nep297` events emitted by your governance contract.
* **Testnet Endpoint:** wss://ws-events-v3-testnet.intear.tech/events/log_nep297

### Contract Events Filter:
```js
{
  And: [
    { path: "account_id",   operator: { Equals: VOTING_CONTRACT } },
    { path: "event_standard", operator: { Equals: "venear" } }
  ]
}
```

### Event Parsing:
Flexible helpers check multiple fields in the payload to accommodate variations in contract implementations.

* `extractProposalId`
* `extractEventType`
* `extractAccountId`

## Environment Variables
| Variable             | Required | Description                                                            | Default |
| -------------------- | -------- | ---------------------------------------------------------------------- | ------- |
| `VOTING_CONTRACT`    | ✳️ Yes   | NEAR account ID of the governance contract (e.g., `vote.your.testnet`) | - |
| `TELEGRAM_BOT_TOKEN` | ✳️ Yes   | Telegram Bot API token from @BotFather                                 | - |
| `MONGO_URI`          | ✳️ Yes   | MongoDB connection URI                                                 | - |
| `WEBHOOK_URL`        | ✳️ Yes   | Public HTTPS URL for Telegram webhook (e.g., `https://your-domain.com`) | - |
| `WEBHOOK_SECRET`     | Optional | Secret token for securing webhook requests                             | - |
| `NEAR_RPC_URL`       | Optional | NEAR RPC endpoint                                                      | `https://rpc.testnet.near.org` |
| `PORT`               | Optional | Port for HTTP server                                                   | `3000` |
| `MONGO_DB`           | Optional | MongoDB database name                                                  | `govbot` |
| `MONGO_COLLECTION`   | Optional | Collection for tracking proposals | `seen_proposals` |

## License
This project is licensed under the MIT License.
