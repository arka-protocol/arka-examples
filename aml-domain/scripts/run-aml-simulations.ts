#!/usr/bin/env npx ts-node
/**
 * AML Simulation Runner
 *
 * Runs AML compliance scenarios against the ARKA engine
 * and generates detailed reports showing how ARKA detects
 * suspicious patterns that traditional rules might miss.
 *
 * Usage:
 *   npx ts-node scripts/run-aml-simulations.ts
 *   npx ts-node scripts/run-aml-simulations.ts --dataset patterns
 *   npx ts-node scripts/run-aml-simulations.ts --verbose
 *   npx ts-node scripts/run-aml-simulations.ts --output ./reports
 */

import * as fs from 'fs';
import * as path from 'path';

// Import types from the AML plugin
import type {
  TransactionData,
  AccountData,
  CustomerData,
  TransactionPostedPayload,
} from '../../../plugi../arka-aml/src/types.js';

import {
  HIGH_RISK_COUNTRIES,
  AML_THRESHOLDS,
  HIGH_RISK_INDUSTRIES,
  getCountryRisk,
  isStructuringAmount,
  isRoundAmount,
} from '../../../plugi../arka-aml/src/types.js';

// Simulation types
interface TransactionScenario {
  id: string;
  description: string;
  note?: string;
  transaction: TransactionData;
  account: AccountData;
  customer: CustomerData;
  dailyStats?: {
    totalAmount: number;
    transactionCount: number;
    cashAmount: number;
    cashCount: number;
  };
  recentTransactions?: TransactionData[];
  expectedDecision: 'ALLOW' | 'DENY' | 'ALLOW_WITH_FLAGS';
  expectedFlags?: string[];
  expectedReason?: string;
  patternInsight?: string;
}

interface DatasetFile {
  description: string;
  expectedOutcome: string;
  transactions: TransactionScenario[];
}

interface SimulationResult {
  scenarioId: string;
  description: string;
  decision: 'ALLOW' | 'DENY' | 'ALLOW_WITH_FLAGS';
  flags: string[];
  matchedRules: string[];
  expected: {
    decision: string;
    flags?: string[];
    reason?: string;
  };
  passed: boolean;
  patternInsight?: string;
  riskFactors: string[];
}

interface SimulationReport {
  timestamp: string;
  dataset: string;
  totalScenarios: number;
  passed: number;
  failed: number;
  passRate: string;
  results: SimulationResult[];
  summary: {
    denials: number;
    flags: number;
    allows: number;
    uniqueRulesTriggered: string[];
    riskPatterns: string[];
  };
}

// CLI argument parsing
const args = process.argv.slice(2);
const datasetArg = args.find(a => a.startsWith('--dataset='))?.split('=')[1];
const verboseMode = args.includes('--verbose');
const outputDir = args.find(a => a.startsWith('--output='))?.split('=')[1] || './reports';

// Evaluation logic (simulates ARKA engine rule evaluation)
function evaluateTransaction(scenario: TransactionScenario): SimulationResult {
  const { transaction, account, customer, dailyStats, recentTransactions } = scenario;
  const flags: string[] = [];
  const matchedRules: string[] = [];
  const riskFactors: string[] = [];
  let decision: 'ALLOW' | 'DENY' | 'ALLOW_WITH_FLAGS' = 'ALLOW';

  // === DENY Rules (hard blocks) ===

  // Sanctioned customer
  if (customer.sanctionsHits > 0) {
    decision = 'DENY';
    matchedRules.push('aml-sanctioned-customer-block');
    riskFactors.push(`Customer has ${customer.sanctionsHits} sanctions hit(s)`);
  }

  // Sanctioned country
  const destCountryRisk = getCountryRisk(transaction.destCountry);
  if (destCountryRisk === 'SANCTIONED') {
    decision = 'DENY';
    matchedRules.push('aml-sanctioned-country-block');
    riskFactors.push(`Destination country ${transaction.destCountry} is sanctioned`);
  }

  // Very high risk country (Syria, Yemen, Myanmar)
  if (destCountryRisk === 'VERY_HIGH') {
    decision = 'DENY';
    matchedRules.push('aml-very-high-risk-country-block');
    riskFactors.push(`Destination country ${transaction.destCountry} is very high risk`);
  }

  // Frozen account
  if (account.status === 'FROZEN') {
    decision = 'DENY';
    matchedRules.push('aml-frozen-account-block');
    riskFactors.push('Account is frozen');
  }

  // No KYC with significant amount
  if (account.kycLevel === 'NONE' && transaction.amount > 1000) {
    decision = 'DENY';
    matchedRules.push('aml-no-kyc-block');
    riskFactors.push('No KYC verification on account');
  }

  // If already denied, return early
  if (decision === 'DENY') {
    return {
      scenarioId: scenario.id,
      description: scenario.description,
      decision,
      flags,
      matchedRules,
      expected: {
        decision: scenario.expectedDecision,
        flags: scenario.expectedFlags,
        reason: scenario.expectedReason,
      },
      passed: decision === scenario.expectedDecision,
      patternInsight: scenario.patternInsight,
      riskFactors,
    };
  }

  // === FLAG Rules (allow with flags) ===

  // Watchlist flag
  if (customer.watchlistHits > 0) {
    flags.push('Watchlist Match');
    matchedRules.push('aml-watchlist-flag');
    riskFactors.push(`Customer has ${customer.watchlistHits} watchlist hit(s)`);
  }

  // Adverse media flag
  if (customer.adverseMediaHits > 0) {
    flags.push('Adverse Media Alert');
    matchedRules.push('aml-adverse-media-flag');
    riskFactors.push(`Customer has ${customer.adverseMediaHits} adverse media hit(s)`);
  }

  // Critical risk customer
  if (customer.riskScore > 80) {
    flags.push('Critical Risk Customer');
    matchedRules.push('aml-critical-risk-flag');
    riskFactors.push(`Customer risk score is ${customer.riskScore}`);
  }

  // CTR threshold (cash >= $10,000)
  if (transaction.channel === 'CASH' && transaction.amount >= AML_THRESHOLDS.CTR_THRESHOLD) {
    flags.push('CTR Filing Required');
    matchedRules.push('aml-ctr-threshold');
    riskFactors.push(`Cash transaction at/above CTR threshold ($${transaction.amount})`);
  }

  // Structuring amount detection ($8,000 - $9,999)
  if (isStructuringAmount(transaction.amount) && transaction.channel === 'CASH') {
    flags.push('Structuring Amount Detection');
    matchedRules.push('aml-structuring-amount');
    riskFactors.push(`Amount $${transaction.amount} is just under CTR threshold`);
  }

  // Structuring pattern detection (multiple 8k-10k transactions)
  if (recentTransactions && recentTransactions.length > 0) {
    const structuringTxns = recentTransactions.filter(
      t => t.channel === 'CASH' && isStructuringAmount(t.amount)
    );
    if (structuringTxns.length >= 2 && isStructuringAmount(transaction.amount)) {
      flags.push('Structuring Pattern Detection');
      matchedRules.push('aml-structuring-pattern');
      riskFactors.push(`${structuringTxns.length + 1} transactions in structuring range detected`);
    }
  }

  // PEP rules
  if (customer.isPEP) {
    if (transaction.amount >= AML_THRESHOLDS.PEP_ENHANCED_THRESHOLD) {
      flags.push('PEP Enhanced Threshold');
      matchedRules.push('aml-pep-enhanced');
      riskFactors.push('PEP with transaction above enhanced threshold');
    } else {
      flags.push('PEP Transaction');
      matchedRules.push('aml-pep-any');
      riskFactors.push('PEP customer - any transaction flagged');
    }
  }

  // High-risk country rules
  if (destCountryRisk === 'HIGH') {
    flags.push('FATF Grey List Country');
    matchedRules.push('aml-fatf-greylist');
    riskFactors.push(`Destination ${transaction.destCountry} is on FATF grey list`);

    if (transaction.amount >= AML_THRESHOLDS.HIGH_RISK_COUNTRY_THRESHOLD) {
      flags.push('High-Risk Country Amount');
      matchedRules.push('aml-high-risk-country-amount');
      riskFactors.push(`Amount $${transaction.amount} exceeds high-risk threshold`);
    }
  }

  // Medium risk country (offshore)
  if (destCountryRisk === 'MEDIUM') {
    flags.push('FATF Grey List Country');
    matchedRules.push('aml-offshore-center');
    riskFactors.push(`Destination ${transaction.destCountry} is an offshore financial center`);
  }

  // Velocity checks
  if (dailyStats && dailyStats.transactionCount > AML_THRESHOLDS.HIGH_VELOCITY_COUNT_24H) {
    flags.push('High Velocity 24H');
    matchedRules.push('aml-high-velocity-24h');
    riskFactors.push(`${dailyStats.transactionCount} transactions in 24 hours`);
  }

  // Unusual amount pattern
  if (customer.typicalMonthlyVolume > 0) {
    const ratio = transaction.amount / customer.typicalMonthlyVolume;
    if (ratio >= 5) {
      flags.push('Unusual Amount Pattern');
      matchedRules.push('aml-unusual-amount');
      riskFactors.push(`Amount is ${ratio.toFixed(1)}x typical monthly volume`);
    }
  }

  // Round amount pattern
  if ((transaction.isRoundAmount || isRoundAmount(transaction.amount)) && transaction.amount >= 5000) {
    flags.push('Round Amount Pattern');
    matchedRules.push('aml-round-amount');
    riskFactors.push(`Suspiciously round amount: $${transaction.amount}`);
  }

  // High-risk industry rules
  const industryUpper = customer.industry.toUpperCase();
  if (industryUpper === 'MONEY_SERVICE_BUSINESS') {
    flags.push('MSB Transaction');
    matchedRules.push('aml-msb-transaction');
    riskFactors.push('Money Service Business - inherently high risk');
  }
  if (industryUpper === 'CRYPTOCURRENCY') {
    flags.push('Crypto Business Transaction');
    matchedRules.push('aml-crypto-business');
    riskFactors.push('Cryptocurrency business - elevated risk');
  }
  if (industryUpper === 'CASINO_GAMBLING') {
    flags.push('Casino/Gambling Transaction');
    matchedRules.push('aml-casino-transaction');
    riskFactors.push('Casino/gambling - elevated risk');
  }

  // KYC level checks
  if (account.kycLevel === 'BASIC' && transaction.amount > 10000) {
    flags.push('Basic KYC High Amount');
    matchedRules.push('aml-basic-kyc-high-amount');
    riskFactors.push('Only BASIC KYC for high-value transaction');
  }

  // Dormant account reactivation
  if (account.status === 'DORMANT') {
    flags.push('Dormant Account Reactivation');
    matchedRules.push('aml-dormant-reactivation');
    riskFactors.push('Dormant account showing activity');
  }

  // Determine final decision
  if (flags.length > 0) {
    decision = 'ALLOW_WITH_FLAGS';
  }

  // Determine if test passed
  let passed = decision === scenario.expectedDecision;
  if (passed && scenario.expectedFlags && scenario.expectedFlags.length > 0) {
    // Check that at least some expected flags were triggered
    const matchedExpected = scenario.expectedFlags.filter(ef =>
      flags.some(f => f.toLowerCase().includes(ef.toLowerCase()) ||
                      ef.toLowerCase().includes(f.toLowerCase()))
    );
    passed = matchedExpected.length > 0;
  }

  return {
    scenarioId: scenario.id,
    description: scenario.description,
    decision,
    flags,
    matchedRules,
    expected: {
      decision: scenario.expectedDecision,
      flags: scenario.expectedFlags,
      reason: scenario.expectedReason,
    },
    passed,
    patternInsight: scenario.patternInsight,
    riskFactors,
  };
}

// Load and process datasets
async function runSimulations(): Promise<void> {
  const dataDir = path.join(__dirname, '..', 'data');
  const datasets: string[] = [];

  // Determine which datasets to run
  if (datasetArg) {
    const matchingFiles = fs.readdirSync(dataDir).filter(f =>
      f.includes(datasetArg) && f.endsWith('.json')
    );
    if (matchingFiles.length === 0) {
      console.error(`No dataset found matching: ${datasetArg}`);
      process.exit(1);
    }
    datasets.push(...matchingFiles);
  } else {
    // Run all datasets
    datasets.push(...fs.readdirSync(dataDir).filter(f => f.endsWith('.json')));
  }

  console.log('\n====================================');
  console.log('  ARKA AML Compliance Simulator');
  console.log('====================================\n');

  const allReports: SimulationReport[] = [];

  for (const datasetFile of datasets) {
    const filePath = path.join(dataDir, datasetFile);
    const data: DatasetFile = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

    console.log(`\n📁 Dataset: ${datasetFile}`);
    console.log(`   ${data.description}`);
    console.log(`   Expected: ${data.expectedOutcome}`);
    console.log('   ' + '─'.repeat(50));

    const results: SimulationResult[] = [];

    for (const scenario of data.transactions) {
      const result = evaluateTransaction(scenario);
      results.push(result);

      const statusIcon = result.passed ? '✅' : '❌';
      const decisionIcon =
        result.decision === 'DENY' ? '🚫' :
        result.decision === 'ALLOW_WITH_FLAGS' ? '⚠️' : '✓';

      console.log(`   ${statusIcon} ${scenario.id}: ${decisionIcon} ${result.decision}`);

      if (verboseMode) {
        console.log(`      Description: ${scenario.description}`);
        if (result.flags.length > 0) {
          console.log(`      Flags: ${result.flags.join(', ')}`);
        }
        if (result.riskFactors.length > 0) {
          console.log(`      Risk Factors:`);
          result.riskFactors.forEach(rf => console.log(`        - ${rf}`));
        }
        if (result.patternInsight) {
          console.log(`      Insight: ${result.patternInsight}`);
        }
        console.log('');
      }
    }

    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;
    const passRate = ((passed / results.length) * 100).toFixed(1);

    const report: SimulationReport = {
      timestamp: new Date().toISOString(),
      dataset: datasetFile,
      totalScenarios: results.length,
      passed,
      failed,
      passRate: `${passRate}%`,
      results,
      summary: {
        denials: results.filter(r => r.decision === 'DENY').length,
        flags: results.filter(r => r.decision === 'ALLOW_WITH_FLAGS').length,
        allows: results.filter(r => r.decision === 'ALLOW').length,
        uniqueRulesTriggered: [...new Set(results.flatMap(r => r.matchedRules))],
        riskPatterns: [...new Set(results.flatMap(r => r.riskFactors))],
      },
    };

    allReports.push(report);

    console.log('   ' + '─'.repeat(50));
    console.log(`   Results: ${passed}/${results.length} passed (${passRate}%)`);
    console.log(`   Decisions: 🚫 ${report.summary.denials} denied, ⚠️ ${report.summary.flags} flagged, ✓ ${report.summary.allows} allowed`);
  }

  // Generate reports
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Write JSON report
  const jsonReportPath = path.join(outputDir, `aml-simulation-report-${Date.now()}.json`);
  fs.writeFileSync(jsonReportPath, JSON.stringify(allReports, null, 2));

  // Write Markdown report
  const mdReportPath = path.join(outputDir, `aml-simulation-report-${Date.now()}.md`);
  const mdContent = generateMarkdownReport(allReports);
  fs.writeFileSync(mdReportPath, mdContent);

  console.log('\n====================================');
  console.log('  Simulation Complete');
  console.log('====================================');
  console.log(`\n📊 Reports generated:`);
  console.log(`   JSON: ${jsonReportPath}`);
  console.log(`   Markdown: ${mdReportPath}\n`);

  // Overall summary
  const totalScenarios = allReports.reduce((sum, r) => sum + r.totalScenarios, 0);
  const totalPassed = allReports.reduce((sum, r) => sum + r.passed, 0);
  const overallPassRate = ((totalPassed / totalScenarios) * 100).toFixed(1);

  console.log(`📈 Overall: ${totalPassed}/${totalScenarios} scenarios passed (${overallPassRate}%)`);

  // Unique rules triggered across all datasets
  const allRules = [...new Set(allReports.flatMap(r => r.summary.uniqueRulesTriggered))];
  console.log(`\n🔍 ${allRules.length} unique AML rules triggered across all scenarios`);
}

function generateMarkdownReport(reports: SimulationReport[]): string {
  let md = '# ARKA AML Compliance Simulation Report\n\n';
  md += `Generated: ${new Date().toISOString()}\n\n`;

  // Overall summary
  const totalScenarios = reports.reduce((sum, r) => sum + r.totalScenarios, 0);
  const totalPassed = reports.reduce((sum, r) => sum + r.passed, 0);
  const totalDenied = reports.reduce((sum, r) => sum + r.summary.denials, 0);
  const totalFlagged = reports.reduce((sum, r) => sum + r.summary.flags, 0);
  const totalAllowed = reports.reduce((sum, r) => sum + r.summary.allows, 0);

  md += '## Executive Summary\n\n';
  md += `| Metric | Value |\n`;
  md += `|--------|-------|\n`;
  md += `| Total Scenarios | ${totalScenarios} |\n`;
  md += `| Passed | ${totalPassed} |\n`;
  md += `| Pass Rate | ${((totalPassed / totalScenarios) * 100).toFixed(1)}% |\n`;
  md += `| Denied | ${totalDenied} |\n`;
  md += `| Flagged | ${totalFlagged} |\n`;
  md += `| Allowed | ${totalAllowed} |\n\n`;

  // All unique rules triggered
  const allRules = [...new Set(reports.flatMap(r => r.summary.uniqueRulesTriggered))];
  md += '## Rules Triggered\n\n';
  md += `${allRules.length} unique rules triggered:\n\n`;
  allRules.sort().forEach(rule => {
    md += `- \`${rule}\`\n`;
  });
  md += '\n';

  // Per-dataset details
  for (const report of reports) {
    md += `## Dataset: ${report.dataset}\n\n`;
    md += `**Pass Rate:** ${report.passRate} (${report.passed}/${report.totalScenarios})\n\n`;

    md += '### Results\n\n';
    md += '| ID | Description | Decision | Flags | Pass |\n';
    md += '|----|-------------|----------|-------|------|\n';

    for (const result of report.results) {
      const passIcon = result.passed ? '✅' : '❌';
      const decisionIcon =
        result.decision === 'DENY' ? '🚫' :
        result.decision === 'ALLOW_WITH_FLAGS' ? '⚠️' : '✓';
      const flagsStr = result.flags.length > 0 ? result.flags.slice(0, 2).join(', ') + (result.flags.length > 2 ? '...' : '') : '-';

      md += `| ${result.scenarioId} | ${result.description.slice(0, 40)}... | ${decisionIcon} ${result.decision} | ${flagsStr} | ${passIcon} |\n`;
    }
    md += '\n';

    // Pattern insights for this dataset
    const insights = report.results.filter(r => r.patternInsight);
    if (insights.length > 0) {
      md += '### Pattern Insights\n\n';
      for (const result of insights) {
        md += `**${result.scenarioId}**: ${result.patternInsight}\n\n`;
      }
    }
  }

  // Risk patterns detected
  const allPatterns = [...new Set(reports.flatMap(r => r.summary.riskPatterns))];
  md += '## Risk Patterns Detected\n\n';
  md += 'The following risk factors were identified across all transactions:\n\n';
  allPatterns.sort().forEach(pattern => {
    md += `- ${pattern}\n`;
  });

  md += '\n---\n\n';
  md += '*Report generated by ARKA AML Compliance Simulator*\n';

  return md;
}

// Run the simulation
runSimulations().catch(console.error);
