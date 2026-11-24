# Test-only TLS material (never trust it outside tests)

`ca.der` is a throwaway certificate authority and `check.test.der` / `check.test.key.der` (PKCS#8) a server
certificate for `check.test` signed by it, generated once on 2026-11-23 with `openssl` (P-256, 20 years) for
`backend/tests/vpn_exit.rs`, where a local TLS check endpoint stands in for the operator's check service. The private
key is public by being committed: it protects nothing and must never be used outside these tests.
