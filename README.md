# ARKA Protocol Examples

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

Sample implementations and use cases for ARKA Protocol.

## Examples

### AML Domain
Anti-Money Laundering compliance examples with transaction monitoring rules.

- `data/` - Sample transaction datasets
- `scripts/` - Simulation scripts

### Loan Domain
Loan compliance examples with credit risk assessment rules.

- `rules/` - Sample loan compliance rules
- `events/` - Sample loan application events
- `data/` - Test datasets

## Running Examples

```bash
# Install dependencies
pnpm install

# Run AML simulation
pnpm tsx aml-domain/scripts/run-aml-simulations.ts

# Run Loan simulation
pnpm tsx loan-domain/scripts/run-loan-simulations.ts
```

## License

Apache 2.0 - see [LICENSE](LICENSE) for details.
