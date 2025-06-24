import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

const MAX_ANTHROPIC_CALLS_PER_DAY = 1000;
const ANTHROPIC_USAGE_RESET_HOUR = 0;

const activeThreads = new Map();
const rateLimiter = new Map();
const anthropicUsageTracker = new Map();
const RATE_LIMIT_WINDOW = 60_000;
const MAX_REQUESTS_PER_WINDOW = 10;

export function checkRateLimit(userId) {
  const now = Date.now();
  const times = rateLimiter.get(userId) || [];
  const recent = times.filter((t) => now - t < RATE_LIMIT_WINDOW);
  if (recent.length >= MAX_REQUESTS_PER_WINDOW) {
    return false;
  }
  recent.push(now);
  rateLimiter.set(userId, recent);
  return true;
}

function checkAnthropicDailyLimit() {
  const now = new Date();
  const today = now.toISOString().split("T")[0];

  const currentHour = now.getUTCHours();
  const lastResetKey = "lastReset";
  const lastReset = anthropicUsageTracker.get(lastResetKey);

  if (
    !lastReset ||
    (currentHour >= ANTHROPIC_USAGE_RESET_HOUR && today !== lastReset)
  ) {
    console.log(`🔄 Resetting Anthropic usage counter for ${today}`);
    anthropicUsageTracker.clear();
    anthropicUsageTracker.set(lastResetKey, today);
    anthropicUsageTracker.set("dailyCount", 0);
  }

  const dailyCount = anthropicUsageTracker.get("dailyCount") || 0;

  if (dailyCount >= MAX_ANTHROPIC_CALLS_PER_DAY) {
    console.warn(
      `⚠️ Daily Anthropic limit reached: ${dailyCount}/${MAX_ANTHROPIC_CALLS_PER_DAY}`
    );
    return false;
  }

  return true;
}

function incrementAnthropicUsage() {
  const dailyCount = anthropicUsageTracker.get("dailyCount") || 0;
  anthropicUsageTracker.set("dailyCount", dailyCount + 1);

  const newCount = dailyCount + 1;
  console.log(
    `📊 Anthropic usage: ${newCount}/${MAX_ANTHROPIC_CALLS_PER_DAY} today`
  );

  if (newCount >= MAX_ANTHROPIC_CALLS_PER_DAY * 0.9) {
    console.warn(
      `⚠️ Approaching daily Anthropic limit: ${newCount}/${MAX_ANTHROPIC_CALLS_PER_DAY}`
    );
  }

  return newCount;
}

function getConversationHistory(userId) {
  if (!activeThreads.has(userId)) {
    activeThreads.set(userId, []);
  }
  return activeThreads.get(userId);
}

function addToConversationHistory(userId, role, content) {
  const history = getConversationHistory(userId);
  history.push({ role, content });

  if (history.length > 10) {
    history.splice(0, history.length - 10);
  }

  activeThreads.set(userId, history);
}

export async function createGovernanceAgentCompletion(userMessage) {
  console.log(`🚀 Sending request to Anthropic API`);
  console.log(`📝 Message: ${userMessage.substring(0, 100)}...`);

  if (!ANTHROPIC_API_KEY) {
    console.error(`❌ ANTHROPIC_API_KEY not found in environment variables`);
    return generateIntelligentFallback(userMessage);
  }

  if (!checkAnthropicDailyLimit()) {
    console.warn(`⚠️ Daily Anthropic limit exceeded, using fallback response`);
    return generateIntelligentFallback(userMessage);
  }

  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1000,
        temperature: 0.7,
        system: `You are a helpful AI assistant specialized in NEAR Protocol governance. You help users understand governance proposals, voting processes, and make informed decisions about NEAR ecosystem governance.

Key guidelines:
- Be conversational, helpful, and encouraging
- Focus on factual information about NEAR governance
- Help users understand complex proposals in simple terms
- Encourage participation in governance while being neutral on voting decisions
- Always use the specific voting options provided in the proposal data, never assume generic options
- If you don't know specific details about a proposal, suggest they check near.vote for the most current information
- Keep responses under 200 words unless asked for detailed analysis
- Be enthusiastic about governance participation while remaining objective`,
        messages: [
          {
            role: "user",
            content: userMessage,
          },
        ],
      }),
    });

    console.log(
      `📥 Anthropic Response: ${response.status} ${response.statusText}`
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Anthropic API Error:`, errorText);

      if (response.status === 401) {
        console.error(`❌ Invalid API key`);
      } else if (response.status === 429) {
        console.error(`❌ Rate limit exceeded`);
      }

      throw new Error(`Anthropic API ${response.status}: ${errorText}`);
    }

    const result = await response.json();

    if (!result.content || !result.content[0] || !result.content[0].text) {
      console.error("❌ Invalid response format:", result);
      throw new Error("Invalid response format from Anthropic");
    }

    incrementAnthropicUsage();

    const responseText = result.content[0].text;
    console.log(`✅ Got response: ${responseText.substring(0, 100)}...`);
    return responseText;
  } catch (error) {
    console.error(`❌ Anthropic API failed:`, error.message);
    return generateIntelligentFallback(userMessage);
  }
}

export async function discussProposal(
  userMessage,
  proposal,
  userId,
  isFirstMessage = false,
  history = []
) {
  try {
    console.log(`💬 Starting governance discussion - User: ${userId}`);
    console.log(
      `📋 Proposal: ${proposal.title || "Untitled"} (Status: ${
        proposal.status || "Unknown"
      })`
    );

    let governanceContext;

    if (isFirstMessage) {
      let votingOptionsText = "";
      if (proposal.voting_options && Array.isArray(proposal.voting_options)) {
        votingOptionsText = `\n- Voting Options: ${proposal.voting_options.join(
          ", "
        )}`;
      }

      let votingResultsText = "";
      if (
        proposal.votes &&
        Array.isArray(proposal.votes) &&
        proposal.votes.length > 0
      ) {
        const totalVotes = proposal.votes.reduce(
          (sum, v) => sum + (v.total_votes || 0),
          0
        );
        if (totalVotes > 0) {
          votingResultsText = "\n- Current Results:";
          proposal.voting_options?.forEach((option, index) => {
            const votes = proposal.votes[index]?.total_votes || 0;
            const percentage =
              totalVotes > 0 ? ((votes / totalVotes) * 100).toFixed(1) : "0";
            votingResultsText += `\n  • ${option}: ${percentage}% (${votes} votes)`;
          });
        }
      }

      governanceContext = `I'm starting a discussion about a NEAR governance proposal. Please provide a friendly, welcoming introduction to help the user understand this specific proposal:

**Proposal Details:**
- Title: "${proposal.title || "Untitled"}"
- Status: ${proposal.status || "Unknown"}
- Proposer: ${proposal.proposer_id || "Unknown"}
- Description: ${
        proposal.description || "No description available"
      }${votingOptionsText}${votingResultsText}

Please focus on:
- What this particular proposal is about in simple terms
- Its current status and what that means for voters
- The specific voting options available (use the exact options listed above, don't assume generic options)
- Why someone might be interested in discussing it
- Encouraging questions about the proposal

Keep it conversational, welcoming, and under 150 words. Focus specifically on THIS proposal and its actual voting options, not general governance information.`;
    } else {
      let votingOptionsText = "";
      if (proposal.voting_options && Array.isArray(proposal.voting_options)) {
        votingOptionsText = `\n- Available Voting Options: ${proposal.voting_options.join(
          ", "
        )}`;
      }

      let votingResultsText = "";
      if (
        proposal.votes &&
        Array.isArray(proposal.votes) &&
        proposal.votes.length > 0
      ) {
        const totalVotes = proposal.votes.reduce(
          (sum, v) => sum + (v.total_votes || 0),
          0
        );
        if (totalVotes > 0) {
          votingResultsText = "\n- Current Results:";
          proposal.voting_options?.forEach((option, index) => {
            const votes = proposal.votes[index]?.total_votes || 0;
            const percentage =
              totalVotes > 0 ? ((votes / totalVotes) * 100).toFixed(1) : "0";
            votingResultsText += `\n  • ${option}: ${percentage}% (${votes} votes)`;
          });
        }
      }

      governanceContext = `I'm discussing a NEAR governance proposal with a user. Please respond to their message helpfully:

**Proposal Context:**
- Title: "${proposal.title || "Untitled"}"
- Status: ${proposal.status || "Unknown"}
- Proposer: ${proposal.proposer_id || "Unknown"}
- Description: ${
        proposal.description || "No description available"
      }${votingOptionsText}${votingResultsText}

**User's Message:** "${userMessage}"

Please provide a helpful response that directly addresses what they're asking about this proposal. Be conversational and informative. When discussing voting, use the specific voting options listed above, not generic options. Keep responses under 200 words unless they ask for detailed analysis.`;
    }

    const response = await createGovernanceAgentCompletion(governanceContext);

    addToConversationHistory(userId, "user", userMessage);
    addToConversationHistory(userId, "assistant", response);

    console.log(`✅ Generated governance response for user ${userId}`);
    return response;
  } catch (err) {
    console.error(`❌ Governance discussion failed:`, err.message);
    return generateSmartFallbackResponse(userMessage, proposal);
  }
}

function generateIntelligentFallback(userMessage) {
  const message = userMessage.toLowerCase();

  if (
    message.includes("proposal discussion") &&
    message.includes("introduction")
  ) {
    return `Welcome to this governance proposal discussion!

I'm here to help you understand this proposal better. You can ask me about:
- What this proposal aims to achieve
- How the voting process works
- The specific voting options available
- Key considerations for voters
- Timeline and deadlines
- How to participate

What specific aspect would you like to explore first?`;
  }

  if (message.includes("vote") || message.includes("voting")) {
    return `Here's how voting on NEAR governance proposals works:

**📋 Prerequisites:**
- You need veNEAR tokens (vote-escrowed NEAR)
- Connect your NEAR wallet to near.vote

**🗳️ Voting Process:**
1. Review the proposal details carefully
2. Consider the specific voting options available
3. Participate in community discussions
4. Cast your vote before the deadline
5. Your voting power depends on your veNEAR balance

**⏰ Important:** Make sure to vote before the voting period ends!

Would you like me to explain any of these steps in more detail?`;
  }

  return `I'm here to help with NEAR governance! I can assist with:

• Understanding proposal details and implications
• Explaining the voting process and requirements
• Discussing the specific voting options available
• Analyzing potential impacts on the NEAR ecosystem
• Providing context about governance decisions

What would you like to know about this proposal or NEAR governance in general?`;
}

function generateSmartFallbackResponse(userMessage, proposal) {
  const message = userMessage.toLowerCase();
  const title = proposal.title || "this proposal";
  const status = proposal.status || "unknown status";
  const proposer = proposal.proposer_id || "unknown proposer";

  if (message.includes("vote") || message.includes("how")) {
    let votingOptionsText = "";
    if (proposal.voting_options && Array.isArray(proposal.voting_options)) {
      votingOptionsText = `\n\nVoting options: ${proposal.voting_options.join(
        ", "
      )}`;
    }

    return `To vote on "${title}":

1. Visit near.vote/proposal/${proposal.id || ""}
2. Connect your NEAR wallet
3. You need veNEAR tokens to vote
4. Read the proposal carefully
5. Choose from the available options and cast your vote!${votingOptionsText}

This proposal is currently ${status}. Make sure to vote before the deadline!`;
  }

  return `I'm here to help with "${title}" by ${proposer}.

Visit near.vote/proposal/${proposal.id || ""} for full details and voting!

What would you like to know about this proposal or NEAR governance?`;
}

export async function endDiscussion(userId) {
  const threadId = activeThreads.get(userId);
  if (!threadId || !Array.isArray(threadId)) {
    console.log(`ℹ️ No active thread for user ${userId}`);
    return false;
  }

  console.log(`🛑 Ending discussion for user ${userId}`);
  activeThreads.delete(userId);
  return true;
}
