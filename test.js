import { runTest } from './index.js';

runTest()
  .then(() => {
    console.log("✅ Test completed");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ Error running test:", err);
    process.exit(1);
  });