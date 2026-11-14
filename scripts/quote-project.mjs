import { searchAgents } from '../src/market/near-agent-market.js';
import { createProjectPlan, validateProjectPlan } from '../src/contractor/project-planner.js';
import { buildProcurementProposal, validateProcurementProposal } from '../src/procurement/quote-and-procure.js';

const [budgetArg, ...objectiveParts] = process.argv.slice(2);
const budget = Number(budgetArg);
const objective = objectiveParts.join(' ').trim();
const supportedNetworks = new Set(['eip155:8453', 'eip155:137', 'eip155:42161']);
const allowedNetworks = String(process.env.X402_ALLOWED_NETWORKS || '').split(',').map((value) => value.trim()).filter(Boolean);
let allowedAssetsByNetwork = {};
try {
  allowedAssetsByNetwork = JSON.parse(process.env.X402_ALLOWED_ASSETS_JSON || '{}');
} catch {
  console.error('X402_ALLOWED_ASSETS_JSON must be valid JSON.');
  process.exit(1);
}
if (allowedNetworks.some((network) => !supportedNetworks.has(network))) {
  console.error('Only current NEAR Agent Payments buyer networks are supported: eip155:8453 (Base), eip155:137 (Polygon), eip155:42161 (Arbitrum).');
  process.exit(1);
}
for (const [network, assets] of Object.entries(allowedAssetsByNetwork)) {
  if (!supportedNetworks.has(network) || !Array.isArray(assets) || !assets.length || assets.some((asset) => typeof asset !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(asset))) {
    console.error(`Invalid X402 asset configuration for ${network}; configure verified EVM USDC contract addresses only.`);
    process.exit(1);
  }
}
if (Object.keys(allowedAssetsByNetwork).some((network) => !allowedNetworks.includes(network))) {
  console.error('Every configured asset network must also be present in X402_ALLOWED_NETWORKS.');
  process.exit(1);
}
const allowedAssets = [...new Set(Object.values(allowedAssetsByNetwork).flat())];
const assetDecimals = Number(process.env.X402_ASSET_DECIMALS || '6');

if (!Number.isFinite(budget) || budget <= 0 || !objective) {
  console.error('Usage: npm run quote -- <budget> <objective>');
  process.exitCode = 1;
} else if (!Number.isInteger(assetDecimals) || assetDecimals < 0 || assetDecimals > 18) {
  console.error('X402_ASSET_DECIMALS must be an integer from 0 to 18.');
  process.exitCode = 1;
} else {
  try {
    const discovery = await searchAgents({ query: 'research' });
    const agents = discovery?.data?.agents ?? discovery?.data?.data?.agents ?? discovery?.data?.result?.agents ?? [];
    const plan = createProjectPlan({ objective, budget, agents });
    const planCheck = validateProjectPlan(plan);
    if (!planCheck.valid) throw new Error(`Draft plan failed validation: ${planCheck.errors.join('; ')}`);
    const proposal = await buildProcurementProposal(plan, {
      allowedAssets, allowedNetworks, allowedAssetsByNetwork,
      requireV2PaymentChallenge: true, assetDecimals
    });
    const proposalCheck = validateProcurementProposal(proposal);
    console.log(JSON.stringify({ plan, proposal, validation: proposalCheck, paymentConfiguration: {
      networks: allowedNetworks, assetAllowlistConfigured: allowedAssets.length > 0,
      note: 'No implicit network or token defaults. Empty allowlists keep provider quotes review-only.'
    } }, null, 2));
    if (!proposalCheck.valid) process.exitCode = 1;
  } catch (error) {
    console.error(`Could not prepare procurement proposal: ${error.message}`);
    process.exitCode = 1;
  }
}
