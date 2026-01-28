#!/bin/bash

# PACT Loan Domain Demo Script
# This script demonstrates the full flow of the PACT Protocol

set -e

CORE_URL="http://localhost:3001"
CORTEX_URL="http://localhost:3003"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "========================================"
echo "PACT Protocol - Loan Domain Demo"
echo "========================================"
echo ""

# Check if services are running
echo "Checking service availability..."
if ! curl -s "$CORE_URL/health/live" > /dev/null; then
    echo "ERROR: Core Service is not running at $CORE_URL"
    echo "Please start it with: cd apps/pact-core-service && pnpm dev"
    exit 1
fi
echo "✓ Core Service is running"

# Step 1: Register Entity Type
echo ""
echo "----------------------------------------"
echo "Step 1: Registering Loan Entity Type"
echo "----------------------------------------"
curl -s -X POST "$CORE_URL/v1/entity-types" \
    -H "Content-Type: application/json" \
    -d @"$SCRIPT_DIR/entity-type.json" | jq .

# Step 2: Create Rules
echo ""
echo "----------------------------------------"
echo "Step 2: Creating Compliance Rules"
echo "----------------------------------------"

echo "Creating California APR Cap rule..."
curl -s -X POST "$CORE_URL/v1/rules" \
    -H "Content-Type: application/json" \
    -d @"$SCRIPT_DIR/rules/ca-apr-cap.json" | jq .data.rule.id

echo "Creating High Risk Detection rule..."
curl -s -X POST "$CORE_URL/v1/rules" \
    -H "Content-Type: application/json" \
    -d @"$SCRIPT_DIR/rules/high-risk-detection.json" | jq .data.rule.id

echo "Creating Low Credit Score rule..."
curl -s -X POST "$CORE_URL/v1/rules" \
    -H "Content-Type: application/json" \
    -d @"$SCRIPT_DIR/rules/low-credit-score.json" | jq .data.rule.id

echo "Creating Large Loan Review rule..."
curl -s -X POST "$CORE_URL/v1/rules" \
    -H "Content-Type: application/json" \
    -d @"$SCRIPT_DIR/rules/large-loan-review.json" | jq .data.rule.id

# Step 3: Process Valid Loan
echo ""
echo "----------------------------------------"
echo "Step 3: Processing Valid Loan Event"
echo "----------------------------------------"
echo "Loan: 25% APR, \$15,000, 36 months"
VALID_RESULT=$(curl -s -X POST "$CORE_URL/v1/events/process" \
    -H "Content-Type: application/json" \
    -d @"$SCRIPT_DIR/events/loan-valid.json")
echo "$VALID_RESULT" | jq '{status: .data.status, decisionId: .data.decisionId}'

# Step 4: Process High APR Loan (should be DENIED)
echo ""
echo "----------------------------------------"
echo "Step 4: Processing High APR Loan Event"
echo "----------------------------------------"
echo "Loan: 45% APR, \$5,000, 24 months (California)"
HIGH_APR_RESULT=$(curl -s -X POST "$CORE_URL/v1/events/process" \
    -H "Content-Type: application/json" \
    -d @"$SCRIPT_DIR/events/loan-high-apr.json")
echo "$HIGH_APR_RESULT" | jq '{status: .data.status, decisionId: .data.decisionId}'

# Step 5: Process High Risk Loan (should be FLAGGED)
echo ""
echo "----------------------------------------"
echo "Step 5: Processing High Risk Loan Event"
echo "----------------------------------------"
echo "Loan: 30% APR, \$50,000, 60 months"
HIGH_RISK_RESULT=$(curl -s -X POST "$CORE_URL/v1/events/process" \
    -H "Content-Type: application/json" \
    -d @"$SCRIPT_DIR/events/loan-high-risk.json")
echo "$HIGH_RISK_RESULT" | jq '{status: .data.status, decisionId: .data.decisionId}'

# Step 6: Get Decision Details
echo ""
echo "----------------------------------------"
echo "Step 6: Getting Decision Details"
echo "----------------------------------------"
DECISION_ID=$(echo "$HIGH_APR_RESULT" | jq -r '.data.decisionId')
curl -s "$CORE_URL/v1/decisions/$DECISION_ID" | jq '.data.decision.ruleEvaluations[] | {ruleId, result, details}'

# Step 7: AI Rule Proposal (if Cortex is running)
echo ""
echo "----------------------------------------"
echo "Step 7: AI-Assisted Rule Proposal"
echo "----------------------------------------"
if curl -s "$CORTEX_URL/health/live" > /dev/null 2>&1; then
    echo "Creating rule proposal from natural language..."
    curl -s -X POST "$CORTEX_URL/v1/rules/propose-from-text" \
        -H "Content-Type: application/json" \
        -d '{
            "jurisdiction": "US-CA",
            "plainTextDescription": "Deny any loan where the debt-to-income ratio exceeds 50%, as this indicates the borrower may have difficulty making payments",
            "entityType": "Loan"
        }' | jq '{proposalId: .data.proposal.id, confidence: .data.proposal.confidence, status: .data.proposal.status}'
else
    echo "Cortex Service not running - skipping AI proposal demo"
    echo "Start it with: cd apps/pact-cortex-service && pnpm dev"
fi

echo ""
echo "========================================"
echo "Demo Complete!"
echo "========================================"
echo ""
echo "Summary:"
echo "- Valid loan (25% APR): ALLOWED"
echo "- High APR loan (45%): DENIED (CA APR cap)"
echo "- High risk loan (30% APR, 60mo): FLAGGED"
echo ""
echo "View all rules: curl $CORE_URL/v1/rules"
echo "View all decisions: curl $CORE_URL/v1/decisions"
