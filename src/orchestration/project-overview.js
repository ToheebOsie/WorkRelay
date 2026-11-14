/**
 * Build a read-only, project-level view over the existing session lifecycle.
 * This is a presentation model only: it never grants approval, commissions work,
 * changes a payment state, or treats a simulation as live execution.
 */
export function buildProjectOverview(session, { commissioningConfigured = false } = {}) {
  if (!session || typeof session !== 'object') throw new TypeError('A project session is required.');

  const mode = session.mode === 'demo' ? 'SIMULATED' : 'LIVE_UNPAID_QUOTES';
  const plan = session.plan ?? null;
  const proposal = session.proposal ?? null;
  const execution = session.execution ?? null;
  const packages = Array.isArray(plan?.workPackages) ? plan.workPackages : [];
  const executionPackages = Array.isArray(execution?.packages) ? execution.packages : [];
  const acceptedCount = executionPackages.filter((item) => item.status === 'accepted' || item.acceptance?.status === 'accepted').length;
  const evaluatedCount = executionPackages.filter((item) => item.evaluation?.passed === true || item.evaluation?.status === 'structural_checks_passed').length;
  const allAccepted = executionPackages.length > 0 && acceptedCount === executionPackages.length;
  const hasExecution = Boolean(execution || session.executionId);
  const hasApprovedExecution = Boolean(session.executionId);

  let projectStatus = 'brief_received';
  let nextAction = 'Build a project plan and provider shortlist.';
  if (plan) {
    projectStatus = 'plan_ready';
    nextAction = 'Review the work breakdown, then compare provider quotes.';
  }
  if (proposal) {
    projectStatus = session.mode === 'demo' ? 'simulation_ready' : 'quotes_received';
    nextAction = session.mode === 'demo'
      ? 'Run the clearly labelled simulated execution to inspect the end-to-end workflow.'
      : commissioningConfigured
        ? 'Review the unpaid provider quotes, recipient checks and readiness. Exact proposal approval and a separate dispatch confirmation are required before any paid request.'
        : 'Review the unpaid provider quotes. Live commissioning remains disabled until an operator installs a reviewed server-side payment adapter and configures verified networks and assets.';
  }
  if (hasApprovedExecution && !execution) {
    projectStatus = 'approved_waiting_for_commissioning';
    nextAction = commissioningConfigured
      ? 'The exact proposal approval is recorded. Review the current dispatch preview and explicitly confirm a separate paid dispatch only if all safety gates pass.'
      : 'The exact proposal approval is recorded, but provider commissioning remains blocked because no reviewed server-side payment adapter is installed.';
  } else if (execution) {
    projectStatus = allAccepted ? 'all_deliverables_accepted' : execution.status === 'waiting_on_dependencies' ? 'waiting_on_dependencies' : 'delivery_under_review';
    nextAction = allAccepted
      ? 'All simulated deliverables have been human-accepted. Review or download the project report.'
      : execution.status === 'waiting_on_dependencies' ? 'Upstream packages are accepted. Run the next eligible dependent packages to continue the workflow.'
      : 'Inspect each deliverable, run structural checks, and record your human review decision.';
  }

  const steps = [
    {
      id: 'plan', label: 'Plan & match',
      status: plan ? 'complete' : 'current',
      detail: plan ? `${packages.length} work package(s) and provider candidates prepared.` : 'Submit a brief to start the contractor workflow.'
    },
    {
      id: 'quotes', label: session.mode === 'demo' ? 'Quote simulation' : 'Unpaid provider quotes',
      status: proposal ? 'complete' : plan ? 'current' : 'locked',
      detail: proposal
        ? (session.mode === 'demo' ? 'Illustrative prices only; not marketplace quotes.' : 'Provider quote responses retrieved without payment credentials.')
        : 'No quote comparison has been completed yet.'
    },
    {
      id: 'approval', label: 'Procurement approval',
      status: session.mode === 'demo' ? 'not_applicable' : hasApprovedExecution ? 'complete' : proposal ? 'blocked' : 'locked',
      detail: session.mode === 'demo'
        ? 'Not applicable: simulated credits are not money and cannot authorize spending.'
        : hasApprovedExecution
          ? 'The exact proposal approval is recorded. This does not mean a provider was commissioned or paid.'
          : proposal
            ? (commissioningConfigured ? 'Exact proposal-scoped approval is required after recipient review and fresh quote validation; approval does not itself commission work or transfer funds.' : 'Blocked until a reviewed server-side payment authorizer and per-network asset allowlist are configured; recipient verification remains an independent procurement gate.')
            : 'An exact, proposal-scoped approval is required before any future real expenditure.'
    },
    {
      id: 'execution', label: session.mode === 'demo' ? 'Simulated execution' : 'Live commissioning',
      status: execution ? 'complete' : session.executionId ? 'in_progress' : session.mode === 'demo' && proposal ? 'current' : session.mode !== 'demo' && proposal ? (commissioningConfigured ? 'current' : 'blocked') : 'locked',
      detail: execution
        ? `${executionPackages.length} simulated task(s); no external agent was hired.`
        : session.executionId
          ? (commissioningConfigured ? 'An approved execution record exists. Review its current dispatch preview; any paid provider request requires separate explicit confirmation.' : 'An approved execution record exists, but provider commissioning remains blocked because no reviewed server-side payment adapter is installed.')
          : session.mode === 'demo' && proposal
            ? 'Run the simulation to see package delivery, evaluation and reporting.'
            : session.mode !== 'demo' && proposal
              ? (commissioningConfigured ? 'A server-side adapter is configured, but this project still needs a ready dispatch preview and a separate explicit paid-dispatch confirmation. No task or payment has been created yet.' : 'Live provider commissioning is disabled until a reviewed server-side payment adapter and explicit network/asset allowlists are configured. No task or payment has been created.')
              : 'Execution is unavailable until procurement review is complete.'
    },
    {
      id: 'review', label: 'Evaluate & accept',
      status: !execution ? 'locked' : allAccepted ? 'complete' : 'current',
      detail: !execution
        ? 'Deliverable review begins after outputs are received.'
        : `${evaluatedCount}/${executionPackages.length} structurally evaluated; ${acceptedCount}/${executionPackages.length} human-accepted.`
    },
    {
      id: 'report', label: 'Project report',
      status: execution ? 'available' : 'locked',
      detail: execution
        ? 'A consolidated report with simulated output disclosures, content hashes, review state and payment disclaimer is available.'
        : 'The report becomes available when the execution path produces deliverables.'
    }
  ];

  return {
    mode,
    projectStatus,
    nextAction,
    steps,
    counts: {
      workPackages: packages.length,
      candidateSlots: packages.reduce((sum, item) => sum + (Array.isArray(item.providerCandidates) ? item.providerCandidates.length : 0), 0),
      quotedPackages: Array.isArray(proposal?.packages) ? proposal.packages.length : 0,
      executionPackages: executionPackages.length,
      structurallyEvaluated: evaluatedCount,
      humanAccepted: acceptedCount
    },
    safety: {
      liveSpendingEnabled: Boolean(commissioningConfigured),
      commissioningConfigured: Boolean(commissioningConfigured),
      hiringStarted: false,
      paymentAuthorized: false,
      paymentSent: false,
      approvalGranted: hasApprovedExecution,
      note: session.mode === 'demo'
        ? 'Demo credits and simulated outputs are not money, provider work, USDC or payment authorization.'
        : commissioningConfigured
          ? 'Live mode can request unpaid quotes. A server-side payment adapter is installed, but each project still requires clear recipient review, fresh quote validation, exact approval and separate dispatch confirmation.'
          : 'Live mode performs marketplace discovery and unpaid quote requests only. Commissioning and payment are disabled until an operator installs a reviewed server-side adapter and verified per-network asset allowlists.'
    }
  };
}
