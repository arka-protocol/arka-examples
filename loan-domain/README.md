# Loan Domain Example

This example demonstrates how to use ARKA Protocol for consumer loan compliance.

## Overview

The loan domain shows:
1. Defining a Loan entity type with schema
2. Creating APR and risk-based compliance rules
3. Processing loan events through ARKA Core
4. Using AI Cortex to propose new rules

## Entity Type: Loan

```json
{
  "name": "Loan",
  "schema": {
    "type": "object",
    "properties": {
      "apr": { "type": "number", "minimum": 0, "maximum": 1 },
      "amount": { "type": "number", "minimum": 0 },
      "termMonths": { "type": "integer", "minimum": 1 },
      "status": { "type": "string", "enum": ["PENDING", "APPROVED", "FUNDED", "CLOSED", "DEFAULTED"] },
      "purpose": { "type": "string" },
      "collateral": { "type": "boolean" },
      "borrowerId": { "type": "string" }
    },
    "required": ["apr", "amount", "termMonths", "status"]
  }
}
```

## Sample Rules

### California APR Cap (36%)
Denies loans with APR exceeding California's maximum rate.

```json
{
  "name": "California APR Cap",
  "jurisdiction": "US-CA",
  "condition": {
    "type": "compare",
    "field": "loan.apr",
    "operator": ">",
    "value": 0.36
  },
  "consequence": {
    "decision": "DENY",
    "code": "CA_APR_EXCEEDED",
    "message": "Loan APR exceeds California maximum of 36%"
  }
}
```

### High Risk Loan Detection
Flags loans combining high APR with long terms.

```json
{
  "name": "High Risk Loan Detection",
  "condition": {
    "type": "and",
    "conditions": [
      { "type": "compare", "field": "loan.apr", "operator": ">", "value": 0.25 },
      { "type": "compare", "field": "loan.termMonths", "operator": ">", "value": 48 }
    ]
  },
  "consequence": {
    "decision": "FLAG",
    "code": "HIGH_RISK_COMBINATION",
    "message": "High APR combined with long term creates excessive risk"
  }
}
```

## Usage Flow

### 1. Register Entity Type

```bash
curl -X POST http://localhost:3001/v1/entity-types \
  -H "Content-Type: application/json" \
  -d @entity-type.json
```

### 2. Create Rules

```bash
curl -X POST http://localhost:3001/v1/rules \
  -H "Content-Type: application/json" \
  -d @rules/ca-apr-cap.json
```

### 3. Process a Loan Event

```bash
curl -X POST http://localhost:3001/v1/events/process \
  -H "Content-Type: application/json" \
  -d @events/loan-created.json
```

### 4. AI-Assisted Rule Creation

```bash
curl -X POST http://localhost:3003/v1/rules/propose-from-text \
  -H "Content-Type: application/json" \
  -d '{
    "jurisdiction": "US-CA",
    "plainTextDescription": "Deny any loan where the borrower credit score is below 500",
    "entityType": "Loan"
  }'
```

## Running the Example

1. Start all services:
```bash
# Terminal 1 - Core Service
cd apps/arka-core-service
pnpm dev

# Terminal 2 - AI Gateway
cd apps/arka-ai-gateway
pnpm dev

# Terminal 3 - Cortex Service
cd apps/arka-cortex-service
pnpm dev
```

2. Run the demo script:
```bash
cd examples/loan-domain
./demo.sh
```

## Expected Results

When processing a California loan with 45% APR:
- Decision: **DENY**
- Reason: CA_APR_EXCEEDED

When processing a loan with 30% APR and 60-month term:
- Decision: **ALLOW_WITH_FLAGS**
- Flag: HIGH_RISK_COMBINATION
