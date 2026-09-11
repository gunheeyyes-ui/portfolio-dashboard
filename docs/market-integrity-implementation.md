## Purpose
Prevent special-market states and corporate-action-like price discontinuities from distorting comparable OOS statistics without deleting raw history.

## Rules
1. Raw OOS and paper PnL are immutable.
2. Only market status known before a future paper fill may block that fill.
3. Later anomalies never back-propagate into earlier horizons.
4. Integrity-clean statistics are a separate view, not a replacement for raw results.
