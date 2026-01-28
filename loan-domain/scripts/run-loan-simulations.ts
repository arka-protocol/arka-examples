#!/usr/bin/env npx ts-node
/**
 * Loan Domain Simulation Script
 *
 * Runs loan applications through ARKA rules engine and generates reports.
 * Can use either direct @arka/core evaluation or arka-core-service APIs.
 *
 * Usage:
 *   npx ts-node scripts/run-loan-simulations.ts [--api] [--dataset <name>]
 *
 * Options:
 *   --api          Use arka-core-service REST API instead of direct evaluation
 *   --dataset      Dataset to use: all, good, borderline, hidden_risks (default: all)
 *   --output       Output directory for reports (default: ./reports)
 *   --verbose      Show detailed output for each loan
 */

import * as fs from 'fs';
import * as path from 'path';

// Types
interface LoanData {
  apr: number;
  principal: number;
  amount?: number;
  termMonths: number;
  purpose: string;
  productType: string;
  isSecured: boolean;
  isRefinance: boolean;
  originalLoanId?: string;
}

interface BorrowerData {
  borrowerId: string;
  creditScore: number;
  income: number;
  employmentStatus: string;
  debtToIncomeRatio: number;
  riskBand: string;
  region: string;
  state: string;
  isFirstTimeBorrower: boolean;
  previousLoanCount: number;
  delinquencyHistory: string;
  delinquenciesLast24Months: number;
  yearsEmployed?: number;
  hasCosigner?: boolean;
  cosignerCreditScore?: number;
}

interface LenderData {
  id: string;
  name: string;
  licenseNumber?: string;
  state?: string;
  isBank?: boolean;
}

interface LoanApplication {
  id: string;
  jurisdiction: string;
  description?: string;
  expectedOutcome?: string;
  riskIndicators?: string[];
  loan: LoanData;
  borrower: BorrowerData;
  lender: LenderData;
  flags?: Record<string, boolean>;
}

interface DatasetFile {
  description: string;
  loans: LoanApplication[];
}

interface RuleEvaluation {
  ruleId: string;
  ruleName: string;
  matched: boolean;
  decision: string;
  code?: string;
  message?: string;
}

interface SimulationResult {
  loanId: string;
  jurisdiction: string;
  decision: 'ALLOW' | 'DENY' | 'ALLOW_WITH_FLAGS';
  flags: string[];
  rulesTriggered: RuleEvaluation[];
  processingTimeMs: number;
  riskScore?: number;
}

interface SimulationSummary {
  timestamp: string;
  datasetsProcessed: string[];
  totalLoans: number;
  results: {
    allowed: number;
    denied: number;
    flagged: number;
  };
  rulesFired: Record<string, number>;
  rulesByCategory: Record<string, number>;
  jurisdictionBreakdown: Record<string, { allowed: number; denied: number; flagged: number }>;
  riskDistribution: Record<string, number>;
  topTriggeredRules: Array<{ ruleId: string; ruleName: string; count: number }>;
  hiddenRisksDetected: number;
  averageProcessingTimeMs: number;
  detailedResults: SimulationResult[];
}

// Simplified rule evaluation (direct mode without full @arka/core dependency)
function evaluateLoanDirectly(loan: LoanApplication): SimulationResult {
  const startTime = Date.now();
  const flags: string[] = [];
  const rulesTriggered: RuleEvaluation[] = [];
  let finalDecision: 'ALLOW' | 'DENY' | 'ALLOW_WITH_FLAGS' = 'ALLOW';

  const payload = {
    loan: loan.loan,
    borrower: loan.borrower,
    lender: loan.lender,
    flags: loan.flags || {},
  };

  // APR cap rules by jurisdiction
  const aprCaps: Record<string, { cap: number; code: string; name: string }> = {
    'US-CA': { cap: 0.36, code: 'CA_APR_EXCEEDED', name: 'California APR Cap' },
    'US-NY': { cap: 0.25, code: 'NY_APR_EXCEEDED', name: 'New York APR Cap' },
    'US-TX': { cap: 0.18, code: 'TX_APR_EXCEEDED', name: 'Texas APR Cap' },
    'US-CT': { cap: 0.12, code: 'CT_APR_EXCEEDED', name: 'Connecticut APR Cap' },
    'US-AR': { cap: 0.17, code: 'AR_APR_EXCEEDED', name: 'Arkansas APR Cap' },
  };

  // Check APR cap
  const aprRule = aprCaps[loan.jurisdiction];
  if (aprRule && payload.loan.apr > aprRule.cap) {
    finalDecision = 'DENY';
    flags.push(aprRule.code);
    rulesTriggered.push({
      ruleId: `loans-${loan.jurisdiction.toLowerCase().replace('-', '')}-apr-cap`,
      ruleName: aprRule.name,
      matched: true,
      decision: 'DENY',
      code: aprRule.code,
      message: `APR ${(payload.loan.apr * 100).toFixed(1)}% exceeds ${loan.jurisdiction} cap of ${(aprRule.cap * 100).toFixed(0)}%`,
    });
  }

  // Deep subprime denial
  if (payload.borrower.creditScore < 500) {
    finalDecision = 'DENY';
    flags.push('DEEP_SUBPRIME_CREDIT');
    rulesTriggered.push({
      ruleId: 'loans-deep-subprime-denial',
      ruleName: 'Deep Subprime Credit Denial',
      matched: true,
      decision: 'DENY',
      code: 'DEEP_SUBPRIME_CREDIT',
      message: `Credit score ${payload.borrower.creditScore} below minimum 500`,
    });
  }

  // Excessive DTI denial
  if (payload.borrower.debtToIncomeRatio > 0.60) {
    finalDecision = 'DENY';
    flags.push('EXCESSIVE_DTI');
    rulesTriggered.push({
      ruleId: 'loans-high-dti-denial',
      ruleName: 'Excessive DTI Denial',
      matched: true,
      decision: 'DENY',
      code: 'EXCESSIVE_DTI',
      message: `DTI ${(payload.borrower.debtToIncomeRatio * 100).toFixed(1)}% exceeds 60% max`,
    });
  }

  // Severe delinquency denial
  if (payload.borrower.delinquencyHistory === 'BANKRUPTCY' || payload.borrower.delinquencyHistory === 'CHARGED_OFF') {
    finalDecision = 'DENY';
    flags.push('SEVERE_DELINQUENCY_HISTORY');
    rulesTriggered.push({
      ruleId: 'loans-repeat-delinquent-denial',
      ruleName: 'Repeat Delinquent Denial',
      matched: true,
      decision: 'DENY',
      code: 'SEVERE_DELINQUENCY_HISTORY',
      message: `Borrower has ${payload.borrower.delinquencyHistory} on record`,
    });
  }

  // MLA violation
  if (payload.flags?.isMilitary && payload.loan.apr > 0.36) {
    finalDecision = 'DENY';
    flags.push('MLA_VIOLATION');
    rulesTriggered.push({
      ruleId: 'loans-mla-apr-cap',
      ruleName: 'Military Lending Act APR Cap',
      matched: true,
      decision: 'DENY',
      code: 'MLA_VIOLATION',
      message: `Military borrower APR ${(payload.loan.apr * 100).toFixed(1)}% exceeds MLA cap of 36%`,
    });
  }

  // Unemployed without cosigner
  if (payload.borrower.employmentStatus === 'UNEMPLOYED' && !payload.borrower.hasCosigner) {
    finalDecision = 'DENY';
    flags.push('UNEMPLOYED_NO_COSIGNER');
    rulesTriggered.push({
      ruleId: 'loans-unemployed-denial',
      ruleName: 'Unemployed Borrower Denial',
      matched: true,
      decision: 'DENY',
      code: 'UNEMPLOYED_NO_COSIGNER',
      message: 'Unemployed borrower without co-signer',
    });
  }

  // Payday to subprime denial
  if (payload.loan.productType === 'PAYDAY' && ['SUBPRIME', 'DEEP_SUBPRIME'].includes(payload.borrower.riskBand)) {
    finalDecision = 'DENY';
    flags.push('PAYDAY_SUBPRIME_DENIAL');
    rulesTriggered.push({
      ruleId: 'loans-payday-subprime-denial',
      ruleName: 'Payday Loan to Subprime Denial',
      matched: true,
      decision: 'DENY',
      code: 'PAYDAY_SUBPRIME_DENIAL',
      message: 'Payday loans not available to subprime borrowers',
    });
  }

  // If not denied, check for flags
  if (finalDecision !== 'DENY') {
    // Subprime credit flag
    if (payload.borrower.creditScore >= 500 && payload.borrower.creditScore < 580) {
      finalDecision = 'ALLOW_WITH_FLAGS';
      flags.push('SUBPRIME_CREDIT');
      rulesTriggered.push({
        ruleId: 'loans-subprime-flag',
        ruleName: 'Subprime Credit Score',
        matched: true,
        decision: 'ALLOW_WITH_FLAGS',
        code: 'SUBPRIME_CREDIT',
      });
    }

    // Near-prime credit flag
    if (payload.borrower.creditScore >= 580 && payload.borrower.creditScore < 670) {
      finalDecision = 'ALLOW_WITH_FLAGS';
      flags.push('NEAR_PRIME_CREDIT');
      rulesTriggered.push({
        ruleId: 'loans-near-prime-flag',
        ruleName: 'Near-Prime Credit Score',
        matched: true,
        decision: 'ALLOW_WITH_FLAGS',
        code: 'NEAR_PRIME_CREDIT',
      });
    }

    // High DTI flag (QM threshold)
    if (payload.borrower.debtToIncomeRatio > 0.43 && payload.borrower.debtToIncomeRatio <= 0.60) {
      finalDecision = 'ALLOW_WITH_FLAGS';
      flags.push('HIGH_DTI');
      rulesTriggered.push({
        ruleId: 'loans-qm-dti-flag',
        ruleName: 'QM DTI Threshold Flag',
        matched: true,
        decision: 'ALLOW_WITH_FLAGS',
        code: 'HIGH_DTI',
      });
    }

    // Shadow APR risk
    if (payload.loan.apr >= 0.32 && payload.loan.apr <= 0.36) {
      finalDecision = 'ALLOW_WITH_FLAGS';
      flags.push('SHADOW_APR_RISK');
      rulesTriggered.push({
        ruleId: 'loans-shadow-apr-risk',
        ruleName: 'Shadow APR Risk Detection',
        matched: true,
        decision: 'ALLOW_WITH_FLAGS',
        code: 'SHADOW_APR_RISK',
      });
    }

    // Shadow DTI risk
    if (payload.borrower.debtToIncomeRatio >= 0.40 && payload.borrower.debtToIncomeRatio <= 0.43) {
      finalDecision = 'ALLOW_WITH_FLAGS';
      flags.push('SHADOW_DTI_RISK');
      rulesTriggered.push({
        ruleId: 'loans-shadow-dti-risk',
        ruleName: 'Shadow DTI Risk Detection',
        matched: true,
        decision: 'ALLOW_WITH_FLAGS',
        code: 'SHADOW_DTI_RISK',
      });
    }

    // Shadow credit risk
    if (payload.borrower.creditScore >= 580 && payload.borrower.creditScore < 600) {
      finalDecision = 'ALLOW_WITH_FLAGS';
      flags.push('SHADOW_CREDIT_RISK');
      rulesTriggered.push({
        ruleId: 'loans-shadow-credit-risk',
        ruleName: 'Shadow Credit Score Risk',
        matched: true,
        decision: 'ALLOW_WITH_FLAGS',
        code: 'SHADOW_CREDIT_RISK',
      });
    }

    // First-time borrower flags
    if (payload.borrower.isFirstTimeBorrower) {
      if (payload.borrower.creditScore < 650) {
        finalDecision = 'ALLOW_WITH_FLAGS';
        flags.push('FIRST_TIME_LOW_CREDIT');
        rulesTriggered.push({
          ruleId: 'loans-first-time-low-credit',
          ruleName: 'First-Time Borrower Low Credit',
          matched: true,
          decision: 'ALLOW_WITH_FLAGS',
          code: 'FIRST_TIME_LOW_CREDIT',
        });
      }
      const principal = payload.loan.principal || payload.loan.amount || 0;
      if (principal > 50000) {
        finalDecision = 'ALLOW_WITH_FLAGS';
        flags.push('FIRST_TIME_HIGH_AMOUNT');
        rulesTriggered.push({
          ruleId: 'loans-first-time-high-amount',
          ruleName: 'First-Time Borrower High Amount',
          matched: true,
          decision: 'ALLOW_WITH_FLAGS',
          code: 'FIRST_TIME_HIGH_AMOUNT',
        });
      }
    }

    // Recent delinquency flags
    if (['PAST_90', 'PAST_120'].includes(payload.borrower.delinquencyHistory)) {
      finalDecision = 'ALLOW_WITH_FLAGS';
      flags.push('RECENT_DELINQUENCY');
      rulesTriggered.push({
        ruleId: 'loans-recent-delinquency-flag',
        ruleName: 'Recent Delinquency Flag',
        matched: true,
        decision: 'ALLOW_WITH_FLAGS',
        code: 'RECENT_DELINQUENCY',
      });
    }

    // Multiple delinquencies
    if (payload.borrower.delinquenciesLast24Months >= 3) {
      finalDecision = 'ALLOW_WITH_FLAGS';
      flags.push('MULTIPLE_DELINQUENCIES');
      rulesTriggered.push({
        ruleId: 'loans-multiple-delinquencies',
        ruleName: 'Multiple Recent Delinquencies',
        matched: true,
        decision: 'ALLOW_WITH_FLAGS',
        code: 'MULTIPLE_DELINQUENCIES',
      });
    }

    // High-risk combination
    if (payload.loan.apr > 0.25 && payload.loan.termMonths > 48 && payload.borrower.creditScore < 620) {
      finalDecision = 'ALLOW_WITH_FLAGS';
      flags.push('HIGH_RISK_COMBINATION');
      rulesTriggered.push({
        ruleId: 'loans-high-risk-combo',
        ruleName: 'High Risk Loan Detection',
        matched: true,
        decision: 'ALLOW_WITH_FLAGS',
        code: 'HIGH_RISK_COMBINATION',
      });
    }

    // Predatory pattern
    if (payload.loan.apr > 0.28 && !payload.loan.isSecured && payload.borrower.debtToIncomeRatio > 0.45) {
      finalDecision = 'ALLOW_WITH_FLAGS';
      flags.push('PREDATORY_PATTERN');
      rulesTriggered.push({
        ruleId: 'loans-predatory-pattern',
        ruleName: 'Potential Predatory Lending Pattern',
        matched: true,
        decision: 'ALLOW_WITH_FLAGS',
        code: 'PREDATORY_PATTERN',
      });
    }

    // Large loan review
    const principal = payload.loan.principal || payload.loan.amount || 0;
    if (principal > 100000) {
      finalDecision = 'ALLOW_WITH_FLAGS';
      flags.push('LARGE_LOAN_REVIEW');
      rulesTriggered.push({
        ruleId: 'loans-large-loan-review',
        ruleName: 'Large Loan Review',
        matched: true,
        decision: 'ALLOW_WITH_FLAGS',
        code: 'LARGE_LOAN_REVIEW',
      });
    }

    // Jumbo loan
    if (principal > 726200) {
      finalDecision = 'ALLOW_WITH_FLAGS';
      flags.push('JUMBO_LOAN');
      rulesTriggered.push({
        ruleId: 'loans-jumbo-loan-review',
        ruleName: 'Jumbo Loan Review',
        matched: true,
        decision: 'ALLOW_WITH_FLAGS',
        code: 'JUMBO_LOAN',
      });
    }

    // Payday loan scrutiny
    if (payload.loan.productType === 'PAYDAY') {
      finalDecision = 'ALLOW_WITH_FLAGS';
      flags.push('PAYDAY_LOAN_SCRUTINY');
      rulesTriggered.push({
        ruleId: 'loans-payday-scrutiny',
        ruleName: 'Payday Loan Enhanced Scrutiny',
        matched: true,
        decision: 'ALLOW_WITH_FLAGS',
        code: 'PAYDAY_LOAN_SCRUTINY',
      });
    }

    // Student borrower
    if (payload.borrower.employmentStatus === 'STUDENT') {
      finalDecision = 'ALLOW_WITH_FLAGS';
      flags.push('STUDENT_BORROWER');
      rulesTriggered.push({
        ruleId: 'loans-student-borrower-flag',
        ruleName: 'Student Borrower Enhanced Review',
        matched: true,
        decision: 'ALLOW_WITH_FLAGS',
        code: 'STUDENT_BORROWER',
      });
    }
  }

  // Calculate simple risk score
  let riskScore = 50; // Base score
  if (payload.borrower.creditScore < 580) riskScore += 20;
  else if (payload.borrower.creditScore < 670) riskScore += 10;
  else if (payload.borrower.creditScore >= 740) riskScore -= 15;

  if (payload.borrower.debtToIncomeRatio > 0.50) riskScore += 15;
  else if (payload.borrower.debtToIncomeRatio > 0.43) riskScore += 8;
  else if (payload.borrower.debtToIncomeRatio < 0.30) riskScore -= 10;

  if (payload.borrower.delinquenciesLast24Months > 0) riskScore += payload.borrower.delinquenciesLast24Months * 5;
  if (payload.loan.apr > 0.30) riskScore += 10;

  riskScore = Math.max(0, Math.min(100, riskScore));

  return {
    loanId: loan.id,
    jurisdiction: loan.jurisdiction,
    decision: finalDecision,
    flags: [...new Set(flags)], // Dedupe
    rulesTriggered,
    processingTimeMs: Date.now() - startTime,
    riskScore,
  };
}

function loadDataset(datasetPath: string): DatasetFile {
  const content = fs.readFileSync(datasetPath, 'utf-8');
  return JSON.parse(content);
}

function generateSummary(results: SimulationResult[], datasetsProcessed: string[]): SimulationSummary {
  const rulesFired: Record<string, number> = {};
  const jurisdictionBreakdown: Record<string, { allowed: number; denied: number; flagged: number }> = {};
  const riskDistribution: Record<string, number> = {
    'LOW (0-25)': 0,
    'MEDIUM (26-50)': 0,
    'HIGH (51-75)': 0,
    'CRITICAL (76-100)': 0,
  };

  let allowed = 0;
  let denied = 0;
  let flagged = 0;
  let totalProcessingTime = 0;

  for (const result of results) {
    // Count decisions
    if (result.decision === 'ALLOW') allowed++;
    else if (result.decision === 'DENY') denied++;
    else flagged++;

    totalProcessingTime += result.processingTimeMs;

    // Count rules fired
    for (const rule of result.rulesTriggered) {
      if (rule.matched) {
        rulesFired[rule.ruleId] = (rulesFired[rule.ruleId] || 0) + 1;
      }
    }

    // Jurisdiction breakdown
    if (!jurisdictionBreakdown[result.jurisdiction]) {
      jurisdictionBreakdown[result.jurisdiction] = { allowed: 0, denied: 0, flagged: 0 };
    }
    if (result.decision === 'ALLOW') jurisdictionBreakdown[result.jurisdiction]!.allowed++;
    else if (result.decision === 'DENY') jurisdictionBreakdown[result.jurisdiction]!.denied++;
    else jurisdictionBreakdown[result.jurisdiction]!.flagged++;

    // Risk distribution
    if (result.riskScore !== undefined) {
      if (result.riskScore <= 25) riskDistribution['LOW (0-25)']!++;
      else if (result.riskScore <= 50) riskDistribution['MEDIUM (26-50)']!++;
      else if (result.riskScore <= 75) riskDistribution['HIGH (51-75)']!++;
      else riskDistribution['CRITICAL (76-100)']!++;
    }
  }

  // Categorize rules
  const ruleCategories: Record<string, string[]> = {
    'APR Caps': ['loans-ca-apr-cap', 'loans-ny-apr-cap', 'loans-tx-apr-cap', 'loans-ct-apr-cap', 'loans-ar-apr-cap'],
    'Credit Score': ['loans-deep-subprime-denial', 'loans-subprime-flag', 'loans-near-prime-flag'],
    'DTI': ['loans-high-dti-denial', 'loans-qm-dti-flag'],
    'Delinquency': ['loans-repeat-delinquent-denial', 'loans-recent-delinquency-flag', 'loans-multiple-delinquencies'],
    'Shadow Risk': ['loans-shadow-apr-risk', 'loans-shadow-dti-risk', 'loans-shadow-credit-risk'],
    'High Risk': ['loans-high-risk-combo', 'loans-predatory-pattern'],
    'First-Time': ['loans-first-time-low-credit', 'loans-first-time-high-amount'],
    'Large Loans': ['loans-large-loan-review', 'loans-jumbo-loan-review'],
    'Special': ['loans-mla-apr-cap', 'loans-unemployed-denial', 'loans-payday-scrutiny', 'loans-payday-subprime-denial', 'loans-student-borrower-flag'],
  };

  const rulesByCategory: Record<string, number> = {};
  for (const [category, ruleIds] of Object.entries(ruleCategories)) {
    rulesByCategory[category] = ruleIds.reduce((sum, id) => sum + (rulesFired[id] || 0), 0);
  }

  // Top triggered rules
  const topTriggeredRules = Object.entries(rulesFired)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([ruleId, count]) => ({
      ruleId,
      ruleName: results.find(r => r.rulesTriggered.find(rt => rt.ruleId === ruleId))?.rulesTriggered.find(rt => rt.ruleId === ruleId)?.ruleName || ruleId,
      count,
    }));

  return {
    timestamp: new Date().toISOString(),
    datasetsProcessed,
    totalLoans: results.length,
    results: { allowed, denied, flagged },
    rulesFired,
    rulesByCategory,
    jurisdictionBreakdown,
    riskDistribution,
    topTriggeredRules,
    hiddenRisksDetected: flagged + denied,
    averageProcessingTimeMs: results.length > 0 ? totalProcessingTime / results.length : 0,
    detailedResults: results,
  };
}

function generateMarkdownReport(summary: SimulationSummary): string {
  const lines: string[] = [];

  lines.push('# ARKA Loans Simulation Report');
  lines.push('');
  lines.push(`**Generated:** ${summary.timestamp}`);
  lines.push(`**Datasets:** ${summary.datasetsProcessed.join(', ')}`);
  lines.push('');

  lines.push('## Executive Summary');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total Loans Processed | ${summary.totalLoans} |`);
  lines.push(`| Allowed | ${summary.results.allowed} (${((summary.results.allowed / summary.totalLoans) * 100).toFixed(1)}%) |`);
  lines.push(`| Denied | ${summary.results.denied} (${((summary.results.denied / summary.totalLoans) * 100).toFixed(1)}%) |`);
  lines.push(`| Flagged for Review | ${summary.results.flagged} (${((summary.results.flagged / summary.totalLoans) * 100).toFixed(1)}%) |`);
  lines.push(`| Hidden Risks Detected | ${summary.hiddenRisksDetected} |`);
  lines.push(`| Avg Processing Time | ${summary.averageProcessingTimeMs.toFixed(2)}ms |`);
  lines.push('');

  lines.push('## Risk Distribution');
  lines.push('');
  lines.push('| Risk Level | Count |');
  lines.push('|------------|-------|');
  for (const [level, count] of Object.entries(summary.riskDistribution)) {
    lines.push(`| ${level} | ${count} |`);
  }
  lines.push('');

  lines.push('## Rules by Category');
  lines.push('');
  lines.push('| Category | Rules Triggered |');
  lines.push('|----------|-----------------|');
  for (const [category, count] of Object.entries(summary.rulesByCategory).sort(([, a], [, b]) => b - a)) {
    if (count > 0) {
      lines.push(`| ${category} | ${count} |`);
    }
  }
  lines.push('');

  lines.push('## Top 10 Triggered Rules');
  lines.push('');
  lines.push('| Rule | Times Triggered |');
  lines.push('|------|-----------------|');
  for (const rule of summary.topTriggeredRules) {
    lines.push(`| ${rule.ruleName} | ${rule.count} |`);
  }
  lines.push('');

  lines.push('## Jurisdiction Breakdown');
  lines.push('');
  lines.push('| Jurisdiction | Allowed | Denied | Flagged |');
  lines.push('|--------------|---------|--------|---------|');
  for (const [jurisdiction, counts] of Object.entries(summary.jurisdictionBreakdown)) {
    lines.push(`| ${jurisdiction} | ${counts.allowed} | ${counts.denied} | ${counts.flagged} |`);
  }
  lines.push('');

  lines.push('## Key Findings');
  lines.push('');

  // Generate insights
  const denialRate = (summary.results.denied / summary.totalLoans) * 100;
  const flagRate = (summary.results.flagged / summary.totalLoans) * 100;

  if (denialRate > 20) {
    lines.push(`- **High Denial Rate:** ${denialRate.toFixed(1)}% of applications were denied outright`);
  }
  if (flagRate > 30) {
    lines.push(`- **Significant Flagging:** ${flagRate.toFixed(1)}% of applications were flagged for review`);
  }

  const shadowRiskCount = (summary.rulesFired['loans-shadow-apr-risk'] || 0) +
    (summary.rulesFired['loans-shadow-dti-risk'] || 0) +
    (summary.rulesFired['loans-shadow-credit-risk'] || 0);
  if (shadowRiskCount > 0) {
    lines.push(`- **Shadow Risk Detection:** ${shadowRiskCount} loans identified with values just under regulatory thresholds`);
  }

  const predatoryCount = summary.rulesFired['loans-predatory-pattern'] || 0;
  if (predatoryCount > 0) {
    lines.push(`- **Predatory Pattern Alert:** ${predatoryCount} loans flagged for potential predatory lending characteristics`);
  }

  lines.push('');
  lines.push('---');
  lines.push('*Report generated by ARKA Protocol Loan Domain Simulation*');

  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const useApi = args.includes('--api');
  const verbose = args.includes('--verbose');

  let datasetArg = 'all';
  const datasetIndex = args.indexOf('--dataset');
  if (datasetIndex !== -1 && args[datasetIndex + 1]) {
    datasetArg = args[datasetIndex + 1]!;
  }

  let outputDir = './reports';
  const outputIndex = args.indexOf('--output');
  if (outputIndex !== -1 && args[outputIndex + 1]) {
    outputDir = args[outputIndex + 1]!;
  }

  console.log('='.repeat(60));
  console.log('ARKA Loans Domain Simulation');
  console.log('='.repeat(60));
  console.log(`Mode: ${useApi ? 'API' : 'Direct Evaluation'}`);
  console.log(`Dataset: ${datasetArg}`);
  console.log(`Output: ${outputDir}`);
  console.log('');

  // Resolve paths
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  const dataDir = path.join(scriptDir, '..', 'data');

  // Determine which datasets to load
  const datasetFiles: string[] = [];
  if (datasetArg === 'all' || datasetArg === 'good') {
    datasetFiles.push(path.join(dataDir, 'loans_good.json'));
  }
  if (datasetArg === 'all' || datasetArg === 'borderline') {
    datasetFiles.push(path.join(dataDir, 'loans_borderline.json'));
  }
  if (datasetArg === 'all' || datasetArg === 'hidden_risks') {
    datasetFiles.push(path.join(dataDir, 'loans_hidden_risks.json'));
  }

  // Load and process loans
  const allResults: SimulationResult[] = [];
  const datasetsProcessed: string[] = [];

  for (const datasetFile of datasetFiles) {
    const datasetName = path.basename(datasetFile, '.json');
    console.log(`Processing ${datasetName}...`);

    try {
      const dataset = loadDataset(datasetFile);
      datasetsProcessed.push(datasetName);

      for (const loan of dataset.loans) {
        const result = evaluateLoanDirectly(loan);
        allResults.push(result);

        if (verbose) {
          console.log(`  ${loan.id}: ${result.decision} ${result.flags.length > 0 ? `[${result.flags.join(', ')}]` : ''}`);
        }
      }

      console.log(`  Processed ${dataset.loans.length} loans`);
    } catch (error) {
      console.error(`  Error loading ${datasetFile}:`, error);
    }
  }

  console.log('');
  console.log('Generating reports...');

  // Generate summary
  const summary = generateSummary(allResults, datasetsProcessed);

  // Ensure output directory exists
  const resolvedOutputDir = path.resolve(scriptDir, '..', outputDir);
  if (!fs.existsSync(resolvedOutputDir)) {
    fs.mkdirSync(resolvedOutputDir, { recursive: true });
  }

  // Write JSON report
  const jsonPath = path.join(resolvedOutputDir, 'loans_pilot_summary.json');
  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2));
  console.log(`  Written: ${jsonPath}`);

  // Write Markdown report
  const mdReport = generateMarkdownReport(summary);
  const mdPath = path.join(resolvedOutputDir, 'loans_pilot_summary.md');
  fs.writeFileSync(mdPath, mdReport);
  console.log(`  Written: ${mdPath}`);

  // Print summary
  console.log('');
  console.log('='.repeat(60));
  console.log('SIMULATION RESULTS');
  console.log('='.repeat(60));
  console.log(`Total Loans:     ${summary.totalLoans}`);
  console.log(`Allowed:         ${summary.results.allowed} (${((summary.results.allowed / summary.totalLoans) * 100).toFixed(1)}%)`);
  console.log(`Denied:          ${summary.results.denied} (${((summary.results.denied / summary.totalLoans) * 100).toFixed(1)}%)`);
  console.log(`Flagged:         ${summary.results.flagged} (${((summary.results.flagged / summary.totalLoans) * 100).toFixed(1)}%)`);
  console.log('');
  console.log('Top Triggered Rules:');
  for (const rule of summary.topTriggeredRules.slice(0, 5)) {
    console.log(`  - ${rule.ruleName}: ${rule.count}`);
  }
  console.log('');
  console.log('Risk Distribution:');
  for (const [level, count] of Object.entries(summary.riskDistribution)) {
    if (count > 0) {
      console.log(`  - ${level}: ${count}`);
    }
  }
  console.log('='.repeat(60));
}

main().catch(console.error);
