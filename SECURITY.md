# Security

This repository is a sanitized reference model published for engineering
review. It contains no credentials, no provider wiring, no production prompt,
and no user data. It makes no network calls: `buildPrompt` and `generate` are
injected by the caller, and the test suite supplies deterministic fakes.

If you believe something sensitive has been published here in error, please
report it to alex@midnightdev.dev rather than opening a public issue.
