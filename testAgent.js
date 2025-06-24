import { createGovernanceAgentCompletion, discussProposal } from "./llm.js";

async function testAnthropicIntegration() {
  console.log("🧪 Testing Anthropic integration...\n");

  // Test 1: Basic completion
  console.log("Test 1: Basic governance question");
  try {
    const response1 = await createGovernanceAgentCompletion(
      "What is NEAR governance and how does voting work?"
    );
    console.log("✅ Success:", response1.substring(0, 100) + "...\n");
  } catch (error) {
    console.log("❌ Failed:", error.message, "\n");
  }

  // Test 2: Proposal discussion
  console.log("Test 2: Proposal discussion");
  const mockProposal = {
    id: 42,
    title: "Increase Developer Grants Budget",
    status: "InProgress",
    proposer_id: "near-foundation.near",
    description:
      "This proposal aims to increase the developer grants budget from 1M to 2M NEAR to support more ecosystem projects.",
  };

  try {
    const response2 = await discussProposal(
      "Tell me about this proposal",
      mockProposal,
      "test-user-123",
      true // isFirstMessage
    );
    console.log("✅ Success:", response2.substring(0, 100) + "...\n");
  } catch (error) {
    console.log("❌ Failed:", error.message, "\n");
  }

  // Test 3: Follow-up question
  console.log("Test 3: Follow-up question");
  try {
    const response3 = await discussProposal(
      "What are the potential risks of this proposal?",
      mockProposal,
      "test-user-123",
      false // not first message
    );
    console.log("✅ Success:", response3.substring(0, 100) + "...\n");
  } catch (error) {
    console.log("❌ Failed:", error.message, "\n");
  }

  console.log("🏁 Testing complete!");
}

// Run the test
testAnthropicIntegration().catch(console.error);
