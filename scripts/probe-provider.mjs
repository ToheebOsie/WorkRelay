import { requestProviderQuote } from '../src/market/near-a2a-quotes.js';

const [handle, ...briefParts] = process.argv.slice(2);
const brief = briefParts.join(' ').trim();
if (!handle || !brief) {
  console.error('Usage: npm run probe -- <provider-handle> "<brief>"');
  process.exit(1);
}
const result = await requestProviderQuote({
  agent: { handle },
  workPackage: {
    brief,
    acceptanceCriteria: ['Return a concise result with source URLs where factual claims are made.']
  },
  requestId: `workrelay-probe-${handle}-${Date.now()}`
});
console.log(JSON.stringify({
  ...result,
  safety: { paymentHeaderSent: false, walletSignatureCreated: false, paymentSent: false, hiringStarted: false }
}, null, 2));
