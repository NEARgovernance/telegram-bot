import fetch from "node-fetch";
import dotenv from "dotenv";
import {
  addChat,
  removeChat,
  getAllChats,
  updateChatActivity,
} from "./mongo.js";
import {
  fetchProposal,
  fetchRecentProposals,
  fetchRecentActiveProposals,
} from "./index.js";
import {
  discussProposal,
  checkRateLimit,
  endDiscussion,
  createGovernanceAgentCompletion,
} from "./llm.js";

dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const conversationContext = new Map();
const activeDiscussions = new Map();

function escapeHtml(text) {
  if (!text) return "";
  return text
    .toString()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

async function isUserAdmin(chatId, userId) {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          user_id: userId,
        }),
      }
    );

    const result = await res.json();
    if (!result.ok) {
      console.warn(`⚠️ Failed to check admin status: ${result.description}`);
      return false;
    }

    // Check if user is admin or owner
    return ["administrator", "creator"].includes(result.result.status);
  } catch (error) {
    console.error("❌ Error checking admin status:", error);
    return false;
  }
}

function getConversationContext(chatId) {
  if (!conversationContext.has(chatId)) {
    conversationContext.set(chatId, []);
  }
  return conversationContext.get(chatId);
}

function addToConversationContext(chatId, role, content) {
  const context = getConversationContext(chatId);
  context.push({ role, content });

  // Keep only last 10 messages for context
  if (context.length > 10) {
    context.splice(0, context.length - 10);
  }

  conversationContext.set(chatId, context);
}

function clearConversationContext(chatId) {
  conversationContext.delete(chatId);
}

function getActiveDiscussion(chatId) {
  return activeDiscussions.get(chatId);
}

function setActiveDiscussion(chatId, proposalId) {
  activeDiscussions.set(chatId, proposalId);
}

function clearActiveDiscussion(chatId) {
  activeDiscussions.delete(chatId);
}

export async function sendMessage(text, chatId) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: false,
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const result = await res.json();

    if (!res.ok) {
      console.error(`❌ Failed to send to ${chatId}: ${result.description}`);

      // Remove inactive chats
      if (result.error_code === 400 || result.error_code === 403) {
        console.log(`🗑️  Removing inactive chat ${chatId}`);
        await removeChat(chatId);
      }
      return false;
    }

    return true;
  } catch (err) {
    console.error(`❌ Network error sending to ${chatId}:`, err.message);
    return false;
  }
}

export async function sendMessageWithKeyboard(text, chatId, keyboard) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: keyboard,
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const result = await res.json();
    return res.ok;
  } catch (err) {
    console.error(`❌ Error sending keyboard to ${chatId}:`, err.message);
    return false;
  }
}

export async function sendMessageToAllChats(text) {
  const chats = await getAllChats();
  console.log(`📤 Sending notification to ${chats.length} chats`);

  let successCount = 0;

  for (const chat of chats) {
    try {
      const success = await sendMessage(text, chat.chatId);
      if (success) {
        successCount++;
        await updateChatActivity(chat.chatId);
      }

      // Rate limiting - Telegram allows 30 messages per second
      await new Promise((resolve) => setTimeout(resolve, 35));
    } catch (error) {
      console.error(`❌ Failed to send to chat ${chat.chatId}:`, error);
    }
  }

  console.log(`✅ Sent to ${successCount}/${chats.length} chats`);
  return successCount;
}

// Main update handler for webhooks
export async function handleTelegramUpdate(update) {
  try {
    if (update.message) {
      await handleMessage(update.message);
    } else if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
    } else if (update.my_chat_member) {
      await handleChatMemberUpdate(update.my_chat_member);
    }
  } catch (error) {
    console.error("❌ Update handling error:", error);
    throw error; // Re-throw for webhook error handling
  }
}

async function handleNaturalLanguageMessage(message) {
  const chat = message.chat;
  const text = message.text;
  const from = message.from;

  if (!checkRateLimit(from.id)) {
    await sendMessage(
      "⏱️ You're sending messages too quickly. Please wait a moment before asking again.",
      chat.id
    );
    return;
  }

  const activeProposalId = getActiveDiscussion(chat.id);

  if (activeProposalId) {
    try {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendChatAction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chat.id,
          action: "typing",
        }),
      });

      const proposal = await fetchProposal(activeProposalId);

      const history = getConversationContext(chat.id);
      const response = await discussProposal(
        text,
        proposal,
        chat.id.toString(),
        false,
        history
      );

      await sendMessage(`🤖 ${response}`, chat.id);

      addToConversationContext(chat.id, "user", text);
      addToConversationContext(chat.id, "assistant", response);
    } catch (error) {
      console.error("❌ Error in discussion:", error);
      await sendMessage(
        "🤖 Sorry, I'm having trouble right now. Please try again later.",
        chat.id
      );
    }
  }
}

async function handleMessage(message) {
  if (!message?.chat?.id || !message?.from) {
    console.warn("⚠️ Invalid message structure");
    return;
  }

  const chat = message.chat;
  const text = message.text;
  const from = message.from;

  if (!text) return; // Ignore non-text messages for now

  console.log(
    `📨 Message from ${from.first_name} in ${chat.type} ${chat.id}: ${text}`
  );

  if (text.startsWith("/")) {
    await handleCommand(message);
    return;
  }

  if (chat.type === "private") {
    const chats = await getAllChats();
    const isSubscribed = chats.some(
      (existingChat) => existingChat.chatId === chat.id.toString()
    );

    if (!isSubscribed) {
      await addChat(chat.id, chat.type, from.first_name);
      await sendMessage(
        `👋 Hi ${from.first_name}!\n\n` +
          `I've subscribed you to governance notifications. You'll receive updates when:\n\n` +
          `📥 New proposals are created\n` +
          `🗳️ Proposals are approved\n\n` +
          `Use /help for commands or /stop to unsubscribe.`,
        chat.id
      );
    }
  }

  await handleNaturalLanguageMessage(message);
}

async function handleCommand(message) {
  const chat = message.chat;
  const text = message.text.toLowerCase();
  const from = message.from;
  const chatName = chat.type === "private" ? from.first_name : chat.title;

  const cleanedText = text.replace(/@\w+/, "");
  const [command, ...args] = cleanedText.slice(1).split(" ");

  switch (command) {
    case "start":
      await addChat(chat.id, chat.type, chatName);
      const keyboard = {
        inline_keyboard: [
          [{ text: "📊 Recent Proposals", callback_data: "recent_proposals" }],
          [{ text: "⚙️ Settings", callback_data: "settings" }],
          [{ text: "❓ Help", callback_data: "help" }],
        ],
      };
      await sendMessageWithKeyboard(
        `🤖 <b>Welcome to Governance Bot!</b>\n\n` +
          `✅ You're now subscribed to notifications.\n\n` +
          `🤖 <b>AI Discussion Available!</b>\nUse /discuss [proposal_id] to start an interactive discussion about any proposal.\n\n` +
          `I'll notify you about:\n` +
          `📥 New proposals\n` +
          `🗳️ Proposal approvals\n\n` +
          `What would you like to do?`,
        chat.id,
        keyboard
      );
      break;

    case "stop":
    case "unsubscribe":
      // Admin-only restriction for groups
      if (chat.type !== "private") {
        const isAdmin = await isUserAdmin(chat.id, from.id);
        if (!isAdmin) {
          await sendMessage(
            `🛡️ <b>Admin Required</b>\n\n` +
              `Only ${chat.type} administrators can unsubscribe from governance notifications.\n\n` +
              `<b>Alternative options:</b>\n` +
              `• DM me privately with /stop for personal notifications\n` +
              `• Mute this chat in Telegram settings\n` +
              `• Ask an admin to run /stop`,
            chat.id
          );
          return;
        }

        // Log admin action
        console.log(
          `🛡️ Admin ${from.first_name} (${from.id}) unsubscribing ${chat.type} ${chat.id}`
        );
      }

      await removeChat(chat.id);
      clearConversationContext(chat.id);
      clearActiveDiscussion(chat.id);

      await endDiscussion(chat.id.toString());

      const chatType = chat.type === "private" ? "You" : `This ${chat.type}`;
      await sendMessage(
        `😔 ${chatType} ${
          chat.type === "private" ? "have" : "has"
        } been unsubscribed from governance notifications.\n\n` +
          `Send /start anytime to subscribe again!`,
        chat.id
      );
      break;

    case "status":
      const allChats = await getAllChats();
      const isSubscribed = allChats.some(
        (existingChat) => existingChat.chatId === chat.id.toString()
      );

      let statusText = isSubscribed
        ? `✅ This ${chat.type} chat is subscribed to governance notifications.`
        : `❌ This ${chat.type} chat is not subscribed.\n\nSend /start to subscribe!`;

      statusText += `\n\n🤖 AI discussion is available.`;
      const activeProposalId = getActiveDiscussion(chat.id);
      if (activeProposalId) {
        statusText += `\n💬 Currently discussing proposal #${activeProposalId}`;
      }

      await sendMessage(statusText, chat.id);
      break;

    case "proposal":
      if (args.length > 0) {
        const proposalId = args[0];
        if (isNaN(proposalId) || parseInt(proposalId) < 0) {
          await sendMessage(
            `❌ Please provide a valid proposal ID (positive number).`,
            chat.id
          );
          return;
        }
        await handleProposalQuery(chat.id, proposalId);
      } else {
        try {
          await sendMessage(`🔍 Fetching most recent proposal...`, chat.id);

          const recentProposals = await fetchRecentProposals(1);

          if (!recentProposals || recentProposals.length === 0) {
            await sendMessage(`📭 No proposals found.`, chat.id);
            return;
          }

          const mostRecentId = recentProposals[0].id;
          await handleProposalQuery(chat.id, mostRecentId);
        } catch (error) {
          console.error("❌ Error fetching most recent proposal:", error);
          await sendMessage(
            `❌ Failed to fetch the most recent proposal.\n\nPlease specify a proposal ID: /proposal [ID]`,
            chat.id
          );
        }
      }
      break;

    case "recent":
      const requestedCount = args.length > 0 ? parseInt(args[0]) : 5;
      const maxCount = 10;
      const count = Math.min(Math.max(requestedCount, 1), maxCount);

      await handleRecentProposals(chat.id, count);
      break;

    case "active":
      const requestedApprovedCount = args.length > 0 ? parseInt(args[0]) : 5;
      const maxApprovedCount = 10;
      const approvedCount = Math.min(
        Math.max(requestedApprovedCount, 1),
        maxApprovedCount
      );

      await handleRecentActiveProposals(chat.id, approvedCount);
      break;

    case "discuss":
      if (args.length > 0) {
        if (args[0] === "off" || args[0] === "end" || args[0] === "stop") {
          await endDiscussion(chat.id.toString());

          clearActiveDiscussion(chat.id);
          clearConversationContext(chat.id);
          await sendMessage(
            "💬 Discussion ended. Start a new discussion anytime with /discuss [proposal_id]",
            chat.id
          );
        } else {
          await handleDiscussCommand(chat.id, args[0]);
        }
      } else {
        const activeProposalId = getActiveDiscussion(chat.id);
        if (activeProposalId) {
          await sendMessage(
            `💬 Currently discussing proposal #${activeProposalId}. Ask me anything about it, or use /discuss stop to end.`,
            chat.id
          );
        } else {
          await sendMessage(
            "💬 Start a proposal discussion: /discuss [proposal_id]\n\nExample: /discuss 42",
            chat.id
          );
        }
      }
      break;

    case "help":
      await sendMessage(
        `🤖 <b>Governance Bot Help</b>\n\n` +
          `<b>📋 Commands:</b>\n` +
          `/start - Subscribe to notifications\n` +
          `/stop - Unsubscribe from notifications\n` +
          `/status - Check subscription\n` +
          `/proposal [ID] - Get proposal details\n` +
          `/recent [count] - Show latest proposals\n` +
          `/active [count] - Show recent approved proposals\n` +
          `/discuss [ID] - Start AI discussion about a proposal\n` +
          `/help - Show this help menu\n\n` +
          `<b>🔔 Notifications You'll Get:</b>\n` +
          `📥 New proposals up for review\n` +
          `🗳️ Proposals approved for voting\n` +
          `\n<b>🤖 AI Features:</b>\nUse /discuss to talk with GovBot about a specific proposal\n` +
          `<i>⚡ Let us know any questions!</i>`,
        chat.id
      );
      break;

    default:
      await sendMessage(
        `❓ Unknown command: /${command}\n\nUse /help to see available commands.`,
        chat.id
      );
  }
}

async function handleProposalQuery(chatId, proposalId) {
  try {
    await sendMessage(`🔍 Checking proposal ${proposalId}...`, chatId);

    const proposal = await fetchProposal(proposalId);

    if (!proposal) {
      await sendMessage(`❌ Proposal ${proposalId} not found.`, chatId);
      return;
    }

    const status = proposal.status || "Unknown";
    const getStatusDisplay = (status) => {
      switch (status) {
        case "Created":
          return { text: "Under Review", emoji: "👀" };
        case "Finished":
          return { text: "Finished", emoji: "✅" };
        case "InProgress":
          return { text: "Active", emoji: "🔄" };
        case "Rejected":
          return { text: "Rejected", emoji: "❌" };
        default:
          return { text: status || "Unknown", emoji: "❓" };
      }
    };

    const statusDisplay = getStatusDisplay(status);

    // Calculate total votes for voting power display
    let totalVotes = 0;
    let totalVotingPower = 0;

    if (proposal.votes && Array.isArray(proposal.votes)) {
      totalVotes = proposal.votes.reduce(
        (sum, vote) => sum + (vote.total_votes || 0),
        0
      );
      totalVotingPower = proposal.votes.reduce(
        (sum, vote) => sum + (vote.total_voting_power || 0),
        0
      );
    }

    // Deadline formatting
    let deadlineSection = "";
    if (proposal.voting_start_time_ns && proposal.voting_duration_ns) {
      const startTime = parseInt(proposal.voting_start_time_ns) / 1000000;
      const duration = parseInt(proposal.voting_duration_ns) / 1000000;
      const endTime = startTime + duration;
      const now = Date.now();

      const startDate = new Date(startTime).toLocaleDateString();
      const endDate = new Date(endTime).toLocaleDateString();

      deadlineSection = `\n⏰ <b>Voting Period:</b>\n`;
      deadlineSection += `   Started: ${startDate}\n`;
      deadlineSection += `   Ends: ${endDate}\n`;

      if (now < startTime) {
        const daysToStart = Math.ceil(
          (startTime - now) / (1000 * 60 * 60 * 24)
        );
        deadlineSection += `   ⏳ Voting starts in ${daysToStart} days\n`;
      } else if (now < endTime) {
        const timeLeft = endTime - now;
        const daysLeft = Math.floor(timeLeft / (1000 * 60 * 60 * 24));
        const hoursLeft = Math.floor(
          (timeLeft % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)
        );
        deadlineSection += `   ⏳ Time remaining: ${daysLeft}d ${hoursLeft}h\n`;
      } else {
        deadlineSection += `   ❌ Voting period ended\n`;
      }
    }

    // Voting power snapshot
    let snapshotSection = "";
    if (proposal.snapshot_and_state) {
      const snapshot = proposal.snapshot_and_state;
      snapshotSection = `\n📸 <b>Voting Snapshot:</b>\n`;

      if (snapshot.total_venear) {
        const totalPower = parseInt(snapshot.total_venear);
        const powerDisplay = (totalPower / 1e24).toFixed(0);
        snapshotSection += `   💪 Total veNEAR: ${powerDisplay}\n`;
      }

      if (snapshot.snapshot?.block_height) {
        snapshotSection += `   ⛓️ Block: ${snapshot.snapshot.block_height}\n`;
      }

      if (snapshot.timestamp_ns) {
        const snapshotDate = new Date(
          parseInt(snapshot.timestamp_ns) / 1000000
        ).toLocaleDateString();
        snapshotSection += `   📅 Date: ${snapshotDate}\n`;
      }
    }

    // Voting options and results
    let votingResultsSection = "";
    if (status === "Created") {
      votingResultsSection = `\n📋 <b>Status:</b> Pending Review\n`;
    } else if (
      proposal.voting_options &&
      Array.isArray(proposal.voting_options)
    ) {
      votingResultsSection = `\n📊 <b>Voting Results:</b>\n`;
      proposal.voting_options.forEach((option, index) => {
        const votes = proposal.votes?.[index]?.total_votes || 0;
        const percentage =
          totalVotes > 0 ? ((votes / totalVotes) * 100).toFixed(1) : "0";

        const emoji =
          proposal.voting_options.length <= 10
            ? ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"][
                index
              ]
            : "";

        votingResultsSection += `   ${emoji}${emoji ? " " : ""}${escapeHtml(
          option
        )}: ${percentage}% (${votes} votes)\n`;
      });

      // Add voting power summary if there are votes
      if (totalVotes > 0) {
        const powerDisplay = (totalVotingPower / 1e24).toFixed(0);
        votingResultsSection += `\n   💪 Total Voting Power Used: ${powerDisplay} veNEAR\n`;
        votingResultsSection += `   🗳️ Total Votes: ${totalVotes}\n`;
      }
    } else {
      votingResultsSection = `\n📊 <b>Voting Results:</b>\n   🔘 No voting options...\n`;
    }

    // Proposer and reviewer info
    let participantsSection = "";
    if (proposal.proposer_id || proposal.reviewer_id) {
      participantsSection = `\n👥 <b>Participants:</b>\n`;
      if (proposal.proposer_id) {
        participantsSection += `   📝 Proposer: ${escapeHtml(
          proposal.proposer_id
        )}\n`;
      }
      if (proposal.reviewer_id) {
        participantsSection += `   👀 Reviewer: ${escapeHtml(
          proposal.reviewer_id
        )}\n`;
      }
    }

    // Creation time
    let creationInfo = "";
    if (proposal.creation_time_ns) {
      const creationDate = new Date(
        parseInt(proposal.creation_time_ns) / 1000000
      );
      creationInfo = `\n⌚ <b>Created:</b> ${creationDate.toLocaleDateString()} ${creationDate.toLocaleTimeString()}`;
    }

    const message =
      `📋 <b>Proposal #${proposalId} Details</b>\n\n` +
      `${escapeHtml(proposal.title) || "Untitled"}\n\n` +
      `${escapeHtml(proposal.description) || "No description provided..."}\n` +
      `${creationInfo}` +
      `${participantsSection}` +
      `${deadlineSection}` +
      `${snapshotSection}` +
      `${votingResultsSection}` +
      `\n🗳️ <a href="https://near.vote/proposal/${proposalId}">VOTE HERE</a>` +
      (proposal.link
        ? `\n🔗 <a href="${escapeHtml(proposal.link)}">More Info</a>`
        : "");

    const MAX_MESSAGE_LENGTH = 4096;
    const truncatedMessage =
      message.length > MAX_MESSAGE_LENGTH
        ? message.substring(0, MAX_MESSAGE_LENGTH - 50) +
          "\n\n... (message truncated)"
        : message;

    await sendMessage(truncatedMessage, chatId);
  } catch (error) {
    console.error(`❌ Error fetching proposal ${proposalId}:`, error);
    await sendMessage(
      `❌ Failed to fetch proposal ${proposalId}. Please check the ID and try again.`,
      chatId
    );
  }
}

async function handleDiscussCommand(chatId, proposalId) {
  if (isNaN(proposalId) || parseInt(proposalId) < 0) {
    await sendMessage(
      "❌ Please provide a valid proposal ID (positive number).",
      chatId
    );
    return;
  }

  try {
    await sendMessage(
      `🔍 Loading proposal ${proposalId} for discussion...`,
      chatId
    );

    const proposal = await fetchProposal(proposalId);
    if (!proposal) {
      await sendMessage(`❌ Proposal ${proposalId} not found.`, chatId);
      return;
    }

    setActiveDiscussion(chatId, proposalId);

    const userMessage =
      "Please provide a friendly introduction to this proposal to start our discussion.";

    addToConversationContext(chatId, "user", userMessage);

    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        action: "typing",
      }),
    });

    const history = getConversationContext(chatId);

    const introduction = await discussProposal(
      userMessage,
      proposal,
      chatId.toString(),
      /* isFirstMessage = */ true,
      history
    );

    const response =
      `💬 <b>Started discussion about Proposal #${proposalId}</b>\n\n` +
      `<b>${escapeHtml(proposal.title || "Untitled")}</b>\n\n` +
      `🤖 ${introduction}\n\n` +
      `💡 Just start chatting with me about this proposal!\n\n` +
      `Use /discuss stop to end this discussion.`;

    await sendMessage(response, chatId);

    addToConversationContext(chatId, "assistant", introduction);
  } catch (error) {
    console.error(
      `❌ Error starting discussion for proposal ${proposalId}:`,
      error
    );
    await sendMessage(
      `❌ Failed to start discussion about proposal ${proposalId}. Please try again later.`,
      chatId
    );
  }
}

async function handleRecentProposals(chatId, count = 5) {
  try {
    await sendMessage(`🔍 Fetching ${count} most recent proposals...`, chatId);

    const proposals = await fetchRecentProposals(count);

    if (!proposals || proposals.length === 0) {
      await sendMessage(`📭 No proposals found.`, chatId);
      return;
    }

    // Format the proposals list with more details
    let message = `📋 <b>${proposals.length} Most Recent Proposals</b>\n\n`;

    // Status emoji
    const getStatusDisplay = (status) => {
      switch (status) {
        case "Created":
          return { text: "Under Review", emoji: "👀" };
        case "Finished":
          return { text: "Finished", emoji: "✅" };
        case "InProgress":
          return { text: "Active", emoji: "🗳️" };
        case "Rejected":
          return { text: "Rejected", emoji: "❌" };
        default:
          return { text: status || "Unknown", emoji: "📄" };
      }
    };

    for (const proposal of proposals) {
      const title = escapeHtml(proposal.title) || `Proposal #${proposal.id}`;
      const status = proposal.status || "Unknown";
      const statusDisplay = getStatusDisplay(status);

      // Format deadline
      let deadlineInfo = "";
      if (proposal.voting_start_time_ns && proposal.voting_duration_ns) {
        const startTime = parseInt(proposal.voting_start_time_ns) / 1000000;
        const duration = parseInt(proposal.voting_duration_ns) / 1000000;
        const endTime = startTime + duration;
        const now = Date.now();

        if (now < startTime) {
          const timeToStart = Math.floor(
            (startTime - now) / (1000 * 60 * 60 * 24)
          );
          deadlineInfo = ` | Starts in ${timeToStart}d`;
        } else if (now < endTime) {
          const timeLeft = Math.floor((endTime - now) / (1000 * 60 * 60 * 24));
          deadlineInfo = ` | ${timeLeft}d left`;
        } else {
          deadlineInfo = " | Ended";
        }
      }

      // Calculate voting summary
      let votingSummary = "";
      let votingPowerInfo = "";

      if (status === "Created" || status === "Rejected") {
        // Created and Rejected proposals have no voting data
        votingSummary = status === "Created" ? " | Pending Review" : "";
      } else {
        // For InProgress and Finished statuses, show voting results if available
        if (
          proposal.votes &&
          Array.isArray(proposal.votes) &&
          proposal.votes.length > 0
        ) {
          // Calculate total voting power and total votes across all options
          const totalVotingPower = proposal.votes.reduce(
            (sum, v) => sum + (v.total_voting_power || 0),
            0
          );
          const totalVotes = proposal.votes.reduce(
            (sum, v) => sum + (v.total_votes || 0),
            0
          );

          if (totalVotes > 0) {
            // Find the option with the most voting power
            const valueArray = proposal.votes.map(
              (v) => v.total_voting_power || 0
            );
            const maxValue = Math.max(...valueArray);
            const winningIndex = valueArray.findIndex((v) => v === maxValue);
            const winningPercentage = (
              (maxValue / totalVotingPower) *
              100
            ).toFixed(0);

            // Get the option name if available
            let optionName = "";
            if (
              proposal.voting_options &&
              proposal.voting_options[winningIndex]
            ) {
              optionName = proposal.voting_options[winningIndex];
            } else {
              optionName = `Option ${winningIndex + 1}`;
            }

            // Show winning option and percentage
            votingSummary = ` | ${winningPercentage}% ${optionName}`;

            // Show voting power and vote count on separate lines
            const powerDisplay = (totalVotingPower / 1e24).toFixed(0);
            votingPowerInfo = `\n   💪 ${powerDisplay} veNEAR\n   🗳️ ${totalVotes} votes`;
          } else {
            votingSummary = " | No votes yet";
          }
        } else if (
          proposal.total_votes &&
          proposal.total_votes.total_votes > 0
        ) {
          // Fallback to total_votes if votes array not available
          const totalVotes = proposal.total_votes.total_votes;
          votingSummary = ` | ${totalVotes} votes`;
        } else {
          votingSummary = " | No votes yet";
        }
      }

      // Proposer info
      const proposer = proposal.proposer_id ? `by ${proposal.proposer_id}` : "";

      // Build message line with near.vote link
      message += `<a href="https://near.vote/proposal/${proposal.id}">Proposal #${proposal.id}</a>\n`;
      message += `<b>${title}</b>\n`;

      if (status === "Created") {
        // For Created status, skip showing "Under Review"
        message += `   ${proposer}${votingSummary}${deadlineInfo}\n\n`;
      } else if (status === "Rejected") {
        // For Rejected status, show status but no voting data
        message += `   ${statusDisplay.text}${proposer}${deadlineInfo}\n\n`;
      } else {
        // For all other statuses (Finished, InProgress), show status AND voting results
        message += `   ${statusDisplay.text}${proposer}${votingSummary}${deadlineInfo}${votingPowerInfo}\n\n`;
      }
    }

    message += `💡 Use <code>/proposal [ID]</code> for details or click the links above to review and vote.`;

    // Split message if too long
    if (message.length > 4000) {
      const parts = message.split("\n\n");
      let currentMessage = `📋 <b>${proposals.length} Most Recent Proposals</b>\n\n`;

      for (const part of parts) {
        if (currentMessage.length + part.length > 3800) {
          await sendMessage(currentMessage, chatId);
          currentMessage = part + "\n\n";
        } else {
          currentMessage += part + "\n\n";
        }
      }

      if (currentMessage.trim()) {
        await sendMessage(
          currentMessage + `💡 Use <code>/proposal [ID]</code> for details`,
          chatId
        );
      }
    } else {
      await sendMessage(message, chatId);
    }
  } catch (error) {
    console.error(`❌ Error fetching recent proposals:`, error);
    await sendMessage(
      `❌ Failed to fetch recent proposals. Please try again later.`,
      chatId
    );
  }
}

async function handleRecentActiveProposals(chatId, count = 5) {
  try {
    await sendMessage(
      `🔍 Fetching ${count} most recent approved proposals...`,
      chatId
    );
    const proposals = await fetchRecentActiveProposals(count);

    if (!proposals?.length) {
      await sendMessage(`📭 No approved proposals found.`, chatId);
      return;
    }

    let message = `🗳️ <b>${proposals.length} Most Recent Approved Proposals</b>\n\n`;

    for (const p of proposals) {
      // Header with link
      const title = escapeHtml(p.title) || `Untitled`;
      message += `<a href="https://near.vote/proposal/${p.id}">Proposal #${p.id}</a>\n`;
      message += `<b>${title}</b>\n`;

      // Deadline
      let now = Date.now(),
        endTimeMs;
      if (p.voting_start_time_ns && p.voting_duration_ns) {
        const startMs = parseInt(p.voting_start_time_ns, 10) / 1e6;
        const durMs = parseInt(p.voting_duration_ns, 10) / 1e6;
        endTimeMs = startMs + durMs;
      }
      if (endTimeMs) {
        if (now >= endTimeMs) {
          message += `   ⏰ Voting period ended\n`;
        } else {
          const msLeft = endTimeMs - now;
          const days = Math.floor(msLeft / 86400000);
          const hrs = Math.floor((msLeft % 86400000) / 3600000);
          message += `   ⏳ ${days}d ${hrs}h remaining to vote\n`;
        }
      } else {
        message += `   ⏳ Voting period info unavailable\n`;
      }

      // Results with participation summary
      const totalVotes = (p.votes || []).reduce(
        (sum, v) => sum + (v.total_votes || 0),
        0
      );
      const totalVotingPower = (p.votes || []).reduce(
        (sum, v) => sum + (v.total_voting_power || 0),
        0
      );

      if (Array.isArray(p.voting_options) && p.voting_options.length) {
        message += `   📊 <b>Results:</b>\n`;
        p.voting_options.forEach((opt, idx) => {
          const votes = p.votes?.[idx]?.total_votes || 0;
          const pct =
            totalVotes > 0 ? ((votes / totalVotes) * 100).toFixed(1) : "0.0";
          message += `     • ${escapeHtml(opt)}: ${pct}% (${votes} vote${
            votes === 1 ? "" : "s"
          })\n`;
        });

        // Add voting power and vote count
        if (totalVotes > 0) {
          const powerDisplay = (totalVotingPower / 1e24).toFixed(0);
          message += `   💪 ${powerDisplay} veNEAR\n`;
          message += `   🗳️ ${totalVotes} votes\n`;
        }
      } else {
        message += `   📊 No voting options available\n`;
      }

      message += `\n`;
    }

    message += `💡 Use <code>/proposal [ID]</code> for details or click the links above to review and vote.`;
    await sendMessage(message, chatId);
  } catch (err) {
    console.error("❌ Error fetching recent approved proposals:", err);
    await sendMessage(
      `❌ Failed to fetch recent approved proposals. Please try again later.`,
      chatId
    );
  }
}

async function handleCallbackQuery(callbackQuery) {
  const chat = callbackQuery.message.chat;
  const data = callbackQuery.data;
  const user = callbackQuery.from;

  console.log(`🎯 Callback: ${data} from ${user.first_name}`);

  // Handle different callback queries
  switch (data) {
    case "recent_proposals":
      await handleRecentProposals(chat.id, 5);
      break;
    case "settings":
      await sendMessage("⚙️ Settings feature coming soon!", chat.id);
      break;
    case "help":
      await handleCommand({
        chat: { id: chat.id, type: "private" },
        text: "/help",
        from: user,
      });
      break;
  }

  // Always answer callback query to remove loading state
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQuery.id,
      text: "Processing...",
    }),
  });
}

async function handleChatMemberUpdate(chatMember) {
  const chat = chatMember.chat;
  const newStatus = chatMember.new_chat_member.status;
  const oldStatus = chatMember.old_chat_member.status;

  console.log(
    `👥 Chat member update: ${oldStatus} -> ${newStatus} in ${chat.type} ${chat.id}`
  );

  // Bot was added to a group
  if (
    (newStatus === "member" || newStatus === "administrator") &&
    (oldStatus === "left" || oldStatus === "kicked")
  ) {
    console.log(`✅ Bot added to ${chat.type} ${chat.id}`);

    await addChat(chat.id, chat.type, chat.title);
    await sendMessage(
      `🤖 <b>Hello everyone!</b>\n\n` +
        `Thanks for adding me! I'll now send governance notifications here.\n\n` +
        `📥 New proposal alerts\n` +
        `🗳️ Approval notifications\n\n` +
        `Use /help for more info or /stop to unsubscribe.`,
      chat.id
    );
  }

  // Bot was removed from a group
  if (
    (newStatus === "left" || newStatus === "kicked") &&
    (oldStatus === "member" || oldStatus === "administrator")
  ) {
    console.log(`❌ Bot removed from ${chat.type} ${chat.id}`);
    await removeChat(chat.id);
  }
}

// Set up webhook with Telegram
export async function setupWebhook() {
  const webhookUrl = `${process.env.WEBHOOK_URL}/webhook`;

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: webhookUrl,
          secret_token: process.env.WEBHOOK_SECRET,
          allowed_updates: ["message", "callback_query", "my_chat_member"],
          drop_pending_updates: true,
        }),
      }
    );

    const result = await response.json();

    if (!result.ok) {
      throw new Error(`Webhook setup failed: ${result.description}`);
    }

    console.log(`✅ Webhook configured: ${webhookUrl}`);

    // Verify webhook
    const infoResponse = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`
    );
    const info = await infoResponse.json();

    if (info.ok && info.result.url) {
      console.log(
        `📋 Webhook active: ${info.result.pending_update_count} pending updates`
      );
    }
  } catch (error) {
    console.error("❌ Webhook setup error:", error);
    throw error;
  }
}

export { escapeHtml };
