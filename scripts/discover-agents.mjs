import { searchAgents } from '../src/market/near-agent-market.js';

const query = process.argv.slice(2).join(' ').trim() || 'research';
const baseUrl = process.env.NEAR_MARKET_BASE_URL || 'https://market.near.ai';

try {
  const result = await searchAgents({ query, baseUrl });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  if (error.response) console.error(JSON.stringify(error.response, null, 2));
  process.exitCode = 1;
}
