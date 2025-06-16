import dotenv from 'dotenv';
dotenv.config();

['VOTING_CONTRACT','TELEGRAM_BOT_TOKEN','MONGO_URI','WEBHOOK_URL'].forEach(key => {
  if (!process.env[key]) {
    console.error(`❌ Missing required environment variable: ${key}`);
    console.error(`💡 Please check your .env file and ensure ${key} is set`);
    process.exit(1);
  }
});

const VOTING_CONTRACT = process.env.VOTING_CONTRACT;
const NEAR_RPC_URL = process.env.NEAR_RPC_URL || 'https://rpc.testnet.near.org';
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

import http from 'http';
import fetch from 'node-fetch';
import WebSocket from 'ws';
import { handleTelegramUpdate, sendMessageToAllChats, setupWebhook, escapeHtml } from './telegram.js';
import { getStatus, setStatus, closeMongo, addChat, removeChat, getAllChats, updateChatActivity } from './mongo.js';
// import { EventStreamClient } from '@intear/inevents-websocket-client';

// Event stream client
let eventClient;
let isConnecting = false;
let reconnectAttempts = 0;
const maxReconnectAttempts = 5;

// Utility to enforce RPC request timeouts
async function fetchWithTimeout(url, opts = {}, timeout = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
}

// HTTP server for Telegram webhooks
const server = http.createServer(async (req, res) => {
  const startTime = Date.now();

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers','Content-Type,X-Telegram-Bot-Api-Secret-Token');
    return res.writeHead(204) && res.end();
  }

  try {
    if (req.method === 'GET' && req.url === '/') {
    // health check
    const chats = await getAllChats();
    res.writeHead(200);
    res.end(JSON.stringify({
        status: 'GovBot is running!',
        mode: 'webhook + inevents',
        contract: VOTING_CONTRACT,
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime()),
        eventStream: eventClient ? 'connected' : 'disconnected',
        subscribedChats: chats.length
    }));
    return;
    }

    if (req.method === 'POST' && req.url === '/webhook') {
      // Verify webhook secret
      if (WEBHOOK_SECRET) {
        const provided = req.headers['x-telegram-bot-api-secret-token'];
        if (provided !== WEBHOOK_SECRET) {
          console.warn('❌ Invalid webhook secret');
          res.writeHead(401);
          return res.end(JSON.stringify({ error: 'Unauthorized' }));
        }
      }

      // Parse body
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', async () => {
        try {
          const update = JSON.parse(body);
          if (!update || typeof update.update_id !== 'number') {
            console.warn('⚠️ Invalid payload');
            res.writeHead(400);
            return res.end(JSON.stringify({ error: 'Invalid payload' }));
          }

          console.log(`📥 Processing Telegram update ${update.update_id}`);
          await handleTelegramUpdate(update);

          const duration = Date.now() - startTime;
          console.log(`✅ Webhook processed in ${duration}ms`);
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          const duration = Date.now() - startTime;
          console.error(`❌ Webhook error after ${duration}ms:`, err);
          const status = err.name === 'ValidationError' ? 200 : 500;
          res.writeHead(status);
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // 404
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (err) {
    console.error('💥 Server error:', err);
    res.writeHead(500);
    res.end(JSON.stringify({ error: 'Server error' }));
  }
});

// Blockchain event monitoring
async function startEventStream() {
  if (isConnecting) {
    console.log('⏳ Event stream connection already in progress');
    return;
  }

  isConnecting = true;

  try {
    if (eventClient) {
      eventClient.close();
      eventClient = null;
    }

    console.log('🔗 Connecting to Intear WebSocket API...');
    eventClient = new WebSocket('wss://ws-events-v3-testnet.intear.tech/events/log_nep297');

    eventClient.on('open', () => {
      console.log('✅ WebSocket connected');
      const contractFilter = {
        "And": [
          { "path": "event_standard", "operator": { "Equals": "venear" } },
          { "path": "account_id", "operator": { "Equals": VOTING_CONTRACT } }
        ]
      };

      eventClient.send(JSON.stringify(contractFilter));
      console.log('📤 Filter sent to WebSocket');

      reconnectAttempts = 0;
      isConnecting = false;
    });

    eventClient.on('message', async (data) => {
      try {
        const text = data.toString();
        if (!text.startsWith('{') && !text.startsWith('[')) {
          console.log('📨 WebSocket message (non-JSON):', text);
          return;
        }

        const events = JSON.parse(text);
        console.log('📥 Received', Array.isArray(events) ? events.length : 1, 'event(s)');

        const eventArray = Array.isArray(events) ? events : [events];

        for (const event of eventArray) {
          console.log('📥 Processing blockchain event:', JSON.stringify(event, null, 2));
          const proposalId = extractProposalId(event);
          const eventType = extractEventType(event);
          const accountId = extractAccountId(event);

          if (accountId && accountId !== VOTING_CONTRACT) continue;
          if (!proposalId || !eventType) continue;

          console.log(`📋 Processing ${eventType} for proposal ${proposalId}`);
          const eventDetails = extractProposalDetails(event);

          if (eventType === 'approve_proposal' || eventType.includes('approve')) {
            await handleProposalApproval(proposalId, eventDetails);
          } else if (eventType === 'create_proposal' || eventType.includes('create')) {
            await handleNewProposal(proposalId, eventDetails);
          }
        }
      } catch (err) {
        console.error('❌ Event processing error:', err);
      }
    });

    eventClient.on('close', () => {
      console.log('🔌 WebSocket closed. Reconnecting...');
      eventClient = null;

      if (reconnectAttempts < maxReconnectAttempts) {
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
        reconnectAttempts++;

        setTimeout(() => {
          console.log(`🔄 Retry attempt ${reconnectAttempts}/${maxReconnectAttempts} in ${delay}ms`);
          isConnecting = false;
          startEventStream();
        }, delay);
      } else {
        console.error('❌ Max reconnection attempts reached');
        console.log('⚠️ Event stream disabled, but webhook functionality continues');
        isConnecting = false;
      }
    });

    eventClient.on('error', (err) => {
      console.error('❌ WebSocket error:', err.message);
      if (eventClient) {
        eventClient.close();
        eventClient = null;
      }
    });
  } catch (err) {
    console.error('❌ Failed to create WebSocket:', err);
    isConnecting = false;
  }
}

// Helper functions to extract data from events
function extractProposalId(event) {
  return event.event_data?.[0]?.proposal_id ||
         event.data?.[0]?.proposal_id ||
         event.proposal_id ||
         event.data?.proposal_id ||
         event.args?.proposal_id ||
         event.event?.proposal_id ||
         (Array.isArray(event.data) && event.data.find(item => item?.proposal_id)?.proposal_id);
}

function extractEventType(event) {
  return event.event_event ||
         event.event_type ||
         event.type ||
         event.kind ||
         event.method ||
         event.event?.type ||
         event.data?.event_type;
}

function extractAccountId(event) {
  return event.account_id ||
         event.contract_id ||
         event.data?.account_id ||
         event.event_data?.[0]?.account_id ||
         event.data?.[0]?.account_id ||
         event.event?.contract_id ||
         event.event?.account_id;
}

function extractProposalDetails(event) {
  const eventData = event.event_data?.[0] || event.data?.[0] || {};

  return {
    proposalId: eventData.proposal_id,
    title: eventData.title,
    description: eventData.description,
    link: eventData.link,
    proposerId: eventData.proposer_id,
    votingOptions: eventData.voting_options
  };
}

// Handle proposal approval
async function handleNewProposal(proposalId, eventDetails) {
  try {
    console.log(`📝 Processing new proposal ${proposalId}`);

    let proposal = null;
    let title = eventDetails.title || `Proposal #${proposalId}`;
    let description = eventDetails.description || '';
    let link = eventDetails.link;

    if (!eventDetails.title || !eventDetails.description) {
      try {
        proposal = await fetchProposal(proposalId);
        title = eventDetails.title || proposal.title || `Proposal #${proposalId}`;
        description = eventDetails.description || proposal.description || '';
        link = eventDetails.link || proposal.link;
      } catch (error) {
        console.warn(`⚠️ Could not fetch full proposal details for ${proposalId}:`, error.message);
      }
    }

    const linkText = link ? `\n\n🔗 <a href="${link}">Vote Here</a>` : '';

    // Format deadline (only if we fetched contract data)
    let deadlineText = '';
    if (proposal && (proposal.deadline || proposal.voting_end)) {
      const deadline = new Date(proposal.deadline || proposal.voting_end);
      const now = new Date();
      const timeLeft = deadline - now;

      if (timeLeft > 0) {
        const days = Math.floor(timeLeft / (1000 * 60 * 60 * 24));
        const hours = Math.floor((timeLeft % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        deadlineText = `\n⏰ <b>Deadline:</b> ${days}d ${hours}h remaining`;
      }
    }

    // Format voting snapshot info (only if we fetched contract data)
    let snapshotText = '';
    if (proposal && (proposal.snapshot_block || proposal.voting_power_snapshot)) {
      const totalVotingPower = proposal.total_voting_power || 'Unknown';
      snapshotText = `\n📊 <b>Voting Power:</b> ${totalVotingPower} veNEAR`;
    }

    const message = `📥 <b>New Proposal</b>\n\n<b>${escapeHtml(title)}</b>\n\n${escapeHtml(description)}${deadlineText}${snapshotText}${linkText}`;

    const sentCount = await sendMessageToAllChats(message);
    await setStatus(proposalId, 'Seen');

    console.log(`📤 Sent creation notifications for proposal ${proposalId} to ${sentCount} chats`);
  } catch (error) {
    console.error(`❌ Failed to process new proposal ${proposalId}:`, error.message);
  }
}

// Handle proposal approval
async function handleProposalApproval(proposalId, eventDetails) {
  try {
    const status = await getStatus(proposalId);
    if (status === 'Approved') {
      console.log(`⏭️  Proposal ${proposalId} already processed`);
      return;
    }

    console.log(`✅ Processing approval for proposal ${proposalId}`);

    let proposal = null;
    let title = eventDetails.title || `Proposal #${proposalId}`;
    let description = eventDetails.description || '';
    let link = eventDetails.link;

    try {
      proposal = await fetchProposal(proposalId);
      title = eventDetails.title || proposal.title || `Proposal #${proposalId}`;
      description = eventDetails.description || proposal.description || '';
      link = eventDetails.link || proposal.link;
    } catch (error) {
      console.warn(`⚠️ Could not fetch full proposal details for ${proposalId}:`, error.message);
    }

    const linkText = link ? `\n\n🔗 <a href="${link}">Vote Here</a>` : '';

    let snapshotText = '';
    if (proposal && proposal.snapshot_block) {
      const totalVotingPower = proposal.total_voting_power || 'Unknown';
      const snapshotBlock = proposal.snapshot_block;
      snapshotText = `\n\n📊 <b>Voting Snapshot:</b>\n` +
                    `   Block: ${snapshotBlock}\n` +
                    `   Total Power: ${totalVotingPower} veNEAR`;
    }

    const message = `🗳️ <b>Proposal Approved for Voting</b>\n\n<b>${escapeHtml(title)}</b>\n\n${escapeHtml(description)}${snapshotText}${linkText}`;

    const sentCount = await sendMessageToAllChats(message);
    await setStatus(proposalId, 'Approved');

    console.log(`📤 Sent approval notifications for proposal ${proposalId} to ${sentCount} chats`);
  } catch (error) {
    console.error(`❌ Failed to process approval ${proposalId}:`, error.message);
  }
}

// Fetch proposal details from NEAR RPC
async function fetchProposal(proposalId) {
  const id = parseInt(proposalId);
  console.log(`🔍 Fetching proposal ID: ${id} (type: ${typeof id})`);

  const payload = {
    jsonrpc: '2.0',
    id: '1',
    method: 'query',
    params: {
      request_type: 'call_function',
      finality: 'final',
      account_id: VOTING_CONTRACT,
      method_name: 'get_proposal',
      args_base64: Buffer.from(JSON.stringify({ proposal_id: id })).toString('base64'),
    }
  };

  console.log(`🔍 RPC URL: ${NEAR_RPC_URL}`);
  console.log(`🔍 Contract: ${VOTING_CONTRACT}`);
  console.log(`🔍 Args object:`, { proposal_id: id });
  console.log(`🔍 Args base64:`, payload.params.args_base64);
  console.log(`🔍 Full payload:`, JSON.stringify(payload, null, 2));

  const res = await fetchWithTimeout(NEAR_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, 10000);

  console.log(`🔍 Response status: ${res.status}`);

  if (!res.ok) {
    throw new Error(`RPC request failed: ${res.status}`);
  }

  const json = await res.json();
  // console.log(`🔍 Response:`, JSON.stringify(json, null, 2));

  if (json.error) {
    throw new Error(`RPC error: ${json.error.message}`);
  }

  if (!json.result || !json.result.result || json.result.result.length === 0) {
    throw new Error(`Proposal ${proposalId} does not exist`);
  }

  // Convert byte array to string, then parse JSON
  const bytes = json.result.result;
  const raw = Buffer.from(bytes).toString('utf-8');
  const proposal = JSON.parse(raw);

  return proposal;
}

async function fetchRecentProposals(count = 5) {
  try {
    // First, get the total number of proposals
    const totalRes = await fetchWithTimeout(NEAR_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        method: 'query',
        params: {
          request_type: 'call_function',
          finality: 'final',
          account_id: VOTING_CONTRACT,
          method_name: 'get_num_proposals',
          args_base64: Buffer.from(JSON.stringify({})).toString('base64'),
        },
      })
    }, 10000);

    if (!totalRes.ok) {
      throw new Error(`Failed to get proposal count: ${totalRes.status}`);
    }

    const totalJson = await totalRes.json();
    if (totalJson.error) {
      throw new Error(`RPC error getting count: ${totalJson.error.message}`);
    }

    const totalCount = JSON.parse(Buffer.from(totalJson.result.result).toString('utf-8'));

    if (totalCount === 0) {
      return [];
    }

    // Calculate the starting index for the most recent proposals
    const fromIndex = Math.max(0, totalCount - count);

    // Fetch proposals using get_proposals method
    const proposalsRes = await fetchWithTimeout(NEAR_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        method: 'query',
        params: {
          request_type: 'call_function',
          finality: 'final',
          account_id: VOTING_CONTRACT,
          method_name: 'get_proposals',
          args_base64: Buffer.from(JSON.stringify({
            from_index: fromIndex,
            limit: count
          })).toString('base64'),
        },
      })
    }, 10000);

    if (!proposalsRes.ok) {
      throw new Error(`Failed to get proposals: ${proposalsRes.status}`);
    }

    const proposalsJson = await proposalsRes.json();
    if (proposalsJson.error) {
      throw new Error(`RPC error getting proposals: ${proposalsJson.error.message}`);
    }

    const proposals = JSON.parse(Buffer.from(proposalsJson.result.result).toString('utf-8'));

    // Reverse to show most recent first and add IDs
    return proposals.map((proposal, index) => ({
      id: fromIndex + index,
      ...proposal
    })).reverse();

  } catch (error) {
    console.error('❌ Error fetching recent proposals:', error);
    throw error;
  }
}

async function fetchRecentActiveProposals(count = 5) {
  try {
    // Get the total number of reviewed proposals approved for voting
    const totalRes = await fetchWithTimeout(NEAR_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        method: 'query',
        params: {
          request_type: 'call_function',
          finality: 'final',
          account_id: VOTING_CONTRACT,
          method_name: 'get_num_approved_proposals',
          args_base64: Buffer.from(JSON.stringify({})).toString('base64'),
        },
      })
    }, 10000);

    if (!totalRes.ok) {
      throw new Error(`Failed to get active proposal count: ${totalRes.status}`);
    }

    const totalJson = await totalRes.json();
    if (totalJson.error) {
      throw new Error(`RPC error getting active proposal count: ${totalJson.error.message}`);
    }

    const totalCount = JSON.parse(Buffer.from(totalJson.result.result).toString('utf-8'));

    if (totalCount === 0) {
      return [];
    }

    // Calculate the starting index for the most recent approved proposals
    const fromIndex = Math.max(0, totalCount - count);

    // Fetch active proposals using get_approved_proposals method
    const proposalsRes = await fetchWithTimeout(NEAR_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        method: 'query',
        params: {
          request_type: 'call_function',
          finality: 'final',
          account_id: VOTING_CONTRACT,
          method_name: 'get_approved_proposals',
          args_base64: Buffer.from(JSON.stringify({
            from_index: fromIndex,
            limit: count
          })).toString('base64'),
        },
      })
    }, 10000);

    if (!proposalsRes.ok) {
      throw new Error(`Failed to get active proposals: ${proposalsRes.status}`);
    }

    const proposalsJson = await proposalsRes.json();
    if (proposalsJson.error) {
      throw new Error(`RPC error getting active proposals: ${proposalsJson.error.message}`);
    }

    const proposals = JSON.parse(Buffer.from(proposalsJson.result.result).toString('utf-8'));

    // Reverse to show most recent first and add proper IDs
    return proposals.map((proposal, index) => ({
      id: fromIndex + index,
      ...proposal
    })).reverse();

  } catch (error) {
    console.error('❌ Error fetching recent active proposals:', error);
    throw error;
  }
}

// Graceful shutdown
function setupGracefulShutdown() {
  const shutdown = async (signal) => {
    console.log(`🛑 Received ${signal}, shutting down...`);

    try {
      // Stop event stream
      if (eventClient) {
        console.log('🔌 Stopping event stream...');
        if (eventClient.readyState === WebSocket.OPEN) {
            eventClient.close();
        }
        eventClient = null;
      }

      // Close HTTP server
      await new Promise((resolve) => {
        server.close(() => {
          console.log('✅ HTTP server closed');
          resolve();
        });
      });

      // Close MongoDB
      await closeMongo();
      console.log('✅ Graceful shutdown completed');
      process.exit(0);
    } catch (error) {
      console.error('❌ Shutdown error:', error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught exception:', error);
    shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    console.error('❌ Unhandled rejection:', reason);
    shutdown('unhandledRejection');
  });
}

// Main startup
async function main() {
  console.log('🚀 Starting Governance Bot (Webhook + Inevents Mode)');
  console.log(`📋 Contract: ${VOTING_CONTRACT}`);
  console.log(`🌐 Port: ${PORT}`);

  const optionalVars = {
    WEBHOOK_URL: process.env.WEBHOOK_URL,
    WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
    MONGO_DB: process.env.MONGO_DB || 'govbot'
  };

  console.log('📋 Configuration:');
  Object.entries(optionalVars).forEach(([key, value]) => {
    console.log(`   ${key}: ${value ? '✅ Set' : '⚠️ Not set'}`);
  });

  setupGracefulShutdown();

  // Start HTTP server for Telegram webhooks
  const host = '0.0.0.0';
  const port = process.env.PORT || 3000;

  server.listen(port, host, () => {
    console.log(`🌐 HTTP webhook server running on ${host}:${port}`);
  });

  // Set up Telegram webhook
  if (process.env.WEBHOOK_URL) {
    try {
      await setupWebhook();
      console.log('✅ Telegram webhook configured');
    } catch (error) {
      console.error('❌ Webhook setup failed:', error);
      process.exit(1);
    }
  } else {
    console.warn('⚠️  WEBHOOK_URL not set - webhook not configured');
  }

  // Start blockchain event monitoring
  console.log('⛓️  Starting blockchain event monitoring...');
  await startEventStream();

  console.log('✅ Bot fully operational');
}

main().catch((error) => {
  console.error('❌ Startup failed:', error);
  process.exit(1);
});

export { fetchProposal, fetchRecentProposals, fetchRecentActiveProposals };
