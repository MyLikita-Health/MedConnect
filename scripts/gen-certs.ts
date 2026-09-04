#!/usr/bin/env tsx
/**
 * gen-certs — on-prem TLS material for the hub (PRD §42, §45; edge §4.3).
 *
 * Creates ./tls/ with:
 *   ca.pem / ca-key.pem    a fresh local CA (keep ca-key.pem OFFLINE after
 *                          issuance — it is the facility's root of trust)
 *   hub.pem / hub-key.pem  the hub's server cert, signed by that CA, with
 *                          SANs for localhost + 127.0.0.1 + the names you
 *                          pass as arguments
 *
 * Trust flow (documented in README "TLS for device + LIS connections"):
 *   1. Generate once:        npm run tls:gen -- hub-hostname facility.lan …
 *   2. Start the hub:        HUB_TLS_CERT=./tls/hub.pem HUB_TLS_KEY=./tls/hub-key.pem npm start
 *      (API becomes https://host:3000, the device listener becomes TLS.)
 *   3. Trust the CA where clients live:
 *        - the console/LIS browser + curl:  --cacert ./tls/ca.pem (or install ca.pem
 *          into the OS trust store, or set NODE_EXTRA_CA_CERTS for Node clients)
 *        - analyzer / LIS software: import ca.pem into the device/LIS trust
 *          store, then connect to the hub host:port over TLS; the hub's cert
 *          chains to ca.pem, so it verifies.
 *
 * Requires the openssl binary (present on macOS/Linux and in the hub image).
 * Usage: npx tsx scripts/gen-certs.ts [extra-SAN-hostname …]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(process.cwd(), 'tls');
const extraNames = process.argv.slice(2);

const caKey = join(OUT, 'ca-key.pem');
const caCert = join(OUT, 'ca.pem');
const hubKey = join(OUT, 'hub-key.pem');
const hubCsr = join(OUT, 'hub.csr');
const hubCert = join(OUT, 'hub.pem');

mkdirSync(OUT, { recursive: true });
if (existsSync(join(OUT, 'hub.pem')) && !process.env.TLS_FORCE) {
  console.error('tls/ already has a hub cert — delete it (or set TLS_FORCE=1) to regenerate');
  process.exit(1);
}

function sh(args: string[]): void {
  execFileSync('openssl', args, { stdio: ['ignore', 'inherit', 'inherit'] });
}

console.log(`[gen-certs] CA + hub certs → ${OUT}/ (keep ca-key.pem offline after issuance)`);

// 1. Local CA.
sh(['genrsa', '-out', caKey, '2048']);
sh(['req', '-x509', '-new', '-key', caKey, '-sha256', '-days', '3650', '-subj', '/CN=Integration Hub Facility CA', '-out', caCert]);

// 2. Hub key + CSR with SANs for localhost, 127.0.0.1 and any extra names.
const san = `DNS:localhost,IP:127.0.0.1${extraNames.map((n) => (n.match(/^\d+\.\d+\.\d+\.\d+$/) ? `,IP:${n}` : `,DNS:${n}`)).join('')}`;
const sanConfig = join(OUT, 'san.cnf');
writeFileSync(
  sanConfig,
  `[req]\ndistinguished_name = dn\nprompt = no\nreq_extensions = v3\n[dn]\nCN = integration-hub\n[v3]\nsubjectAltName = ${san}\n`,
);
sh(['genrsa', '-out', hubKey, '2048']);
sh(['req', '-new', '-key', hubKey, '-sha256', '-config', sanConfig, '-out', hubCsr]);

// 3. Sign the hub cert with the CA.
const extConfig = join(OUT, 'ext.cnf');
writeFileSync(
  extConfig,
  `[v3]\nsubjectAltName = ${san}\nbasicConstraints = CA:FALSE\nkeyUsage = digitalSignature, keyEncipherment\nextendedKeyUsage = serverAuth\n`,
);
sh(['x509', '-req', '-in', hubCsr, '-CA', caCert, '-CAkey', caKey, '-CAcreateserial', '-days', '825', '-sha256', '-extfile', extConfig, '-extensions', 'v3', '-out', hubCert]);

for (const f of [hubCsr, sanConfig, extConfig, join(OUT, 'ca.srl')]) {
  try {
    execFileSync('rm', [f]);
  } catch {
    /* ignore */
  }
}

console.log(`[gen-certs] done. SANs: ${san}`);
console.log(`[gen-certs]   HUB_TLS_CERT=${hubCert}\n[gen-certs]   HUB_TLS_KEY=${hubKey}`);
console.log(`[gen-certs]   trust this CA on clients/LIS: ${caCert}`);
