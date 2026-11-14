import { searchAgents } from '../src/market/near-agent-market.js';
import { createProjectPlan, validateProjectPlan } from '../src/contractor/project-planner.js';

const [budgetArg, ...objectiveParts] = process.argv.slice(2);
const budget = Number(budgetArg);
const objective = objectiveParts.join(' ').trim();
if (!Number.isFinite(budget) || budget <= 0 || !objective) {
  console.error('Usage: npm run plan -- <budget> <objective>');
  process.exitCode = 1;
} else {
  try {
    const result = await searchAgents({ query: 'research' });
    const agents = result?.data?.agents ?? result?.agents ?? [];
    const plan = createProjectPlan({ objective, budget, agents });
    const validation = validateProjectPlan(plan);
    console.log(JSON.stringify({ ...plan, validation }, null, 2));
  } catch (error) {
    console.error(`Could not create plan from live marketplace discovery: ${error.message}`);
    process.exitCode = 1;
  }
}
