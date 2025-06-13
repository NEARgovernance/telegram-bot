import dotenv from 'dotenv';
import WebSocket from 'ws';
import fetch from 'node-fetch';
import { sendMessage } from './telegram.js';
import { getStatus, setStatus } from './mongo.js';

dotenv.config();

const VOTING_CONTRACT = process.env.VOTING_CONTRACT; // e.g. vote.hos03.testnet
const NEAR_RPC_URL = process.env.NEAR_RPC_URL || 'https://rpc.testnet.near.org';

async function fetchProposal(proposalId) {
  const res = await fetch(NEAR_RPC_URL, {
    method: 'POST',
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: '1',
      method: 'query',
      params: {
        request_type: 'call_function',
        finality: 'final',
        account_id: VOTING_CONTRACT,
        method_name: 'get_proposal',
        args_base64: Buffer.from(JSON.stringify({ proposal_id: proposalId })).toString('base64'),
      },
    }),
    headers: { 'Content-Type': 'application/json' },
  });

  const json = await res.json();
  const raw = Buffer.from(json.result.result).toString('utf-8');
  return JSON.parse(raw);
}

function startWebSocket() {
  const ws = new WebSocket('wss://ws-events-v3-testnet.intear.tech/events/log_nep297');

  ws.on('open', () => {
    console.log('WebSocket connected');
    ws.send(JSON.stringify({
    "And": [
        {
        "path": "event_standard",
        "operator": {
            "Equals": "venear"
        }
        },
        {
        "path": "event_event",
        "operator": {
            "Equals": "proposal_approve"
        }
        },
        {
        "path": "account_id",
        "operator": {
            "Equals": VOTING_CONTRACT
        }
        }
    ]
    }));
  });

ws.on('message', async (data) => {
  const text = data.toString();
  if (!text.startsWith('{') && !text.startsWith('[')) {
    console.error('WS RAW (not JSON):', text);
    return;
  }

  try {
    const events = JSON.parse(text);
    console.log('WS parsed:', events);

    for (const event of events) {
      const proposalId = event.data?.[0]?.proposal_id;
      if (proposalId === undefined) continue;

      const status = await getStatus(proposalId);
      if (status === 'Approved') continue;

      console.log(`Detected approval for proposal ID: ${proposalId}`);
      const proposal = await fetchProposal(proposalId);
      const title = proposal?.title || `Proposal #${proposalId}`;
      await sendMessage(`🗳️ *Proposal Approved:*\n${title}`);
      await setStatus(proposalId, 'Approved');
    }
  } catch (err) {
    console.error('WS message error:', err.message);
  }
});

  ws.on('close', () => {
    console.log('WebSocket closed. Reconnecting...');
    setTimeout(startWebSocket, 1000);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
}

startWebSocket();

export async function runTest() {
  const dummyId = 5;
  const proposal = await fetchProposal(dummyId);
  await sendMessage(`*Proposal Approved for Voting:*\n${proposal?.title || 'No title'}`);
  await setStatus(dummyId, 'Approved');
}