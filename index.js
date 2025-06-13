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

    const filter = {
      "And": [
        {
          "path": "event_standard",
          "operator": { "Equals": "venear" }
        },
        {
          "path": "account_id",
          "operator": { "Equals": VOTING_CONTRACT }
        }
      ]
    };

    ws.send(JSON.stringify(filter));
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
        console.log('Full event object:', JSON.stringify(event, null, 2));

        const proposalId = event.event_data?.[0]?.proposal_id || event.data?.[0]?.proposal_id;
        const eventType = event.event_event;

        console.log('proposalId:', proposalId, 'eventType:', eventType);

        if (proposalId === undefined || !eventType) {
            console.log('Skipping event - missing proposalId or eventType');
            continue;
        }

        if (eventType === 'proposal_approve') {
          const status = await getStatus(proposalId);
          if (status === 'Approved') continue;

          console.log(`Detected approval for proposal ID: ${proposalId}`);
          const proposal = await fetchProposal(proposalId);
          const title = proposal?.title || `Proposal #${proposalId}`;
          await sendMessage(`🗳️ *Proposal Approved:*\n*${title}*`);
          await setStatus(proposalId, 'Approved');
        }

        if (eventType === 'create_proposal') {
        console.log(`Detected new proposal: ${proposalId}`);
        const proposal = await fetchProposal(proposalId);
        const title = proposal?.title || `Proposal #${proposalId}`;

        await sendMessage(`📥 Proposal Created:\n${title}`);
        }
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
  const title = proposal?.title || 'No title';
  await sendMessage(`🗳️ Proposal Approved:\n${title}`);
  await setStatus(dummyId, 'Approved');
}
