import { searchAgents } from '../src/market/near-agent-market.js';
import { rankAgents, summarizeAgentMatch } from '../src/contractor/match-agents.js';

const query = process.argv.slice(2).join(' ').trim();
if (!query) {
  console.error('Usage: npm run rank -- <task capability or brief>');
  process.exitCode = 1;
} else {
  try {
    const result = await searchAgents({ query });
    const agents = result.data?.agents;
    if (!Array.isArray(agents)) throw new Error('Marketplace response did not contain an agents array');
    const ranked = rankAgents(agents, query);
    console.log(JSON.stringify({ query, discovered: agents.length, shortlisted: ranked.filter((item) => item.eligibleForShortlist).length, matches: ranked.map(summarizeAgentMatch) }, null, 2));
  } catch (error) {
    console.error(error.message);
    if (error.response) console.error(JSON.stringify(error.response, null, 2));
    process.exitCode = 1;
  }
}
