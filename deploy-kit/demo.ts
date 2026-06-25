// End-to-end demo of Grid Audit's core flow:
//   1. REVIEW real Compact code with the auditor engine (tells you if it's good or not).
//   2. CERTIFY that review on-chain: deploy the privacy registry and publish a receipt
//      committing to the (private) report, proving the auditor's secret in-circuit.
//   3. READ the certificate back from the ledger.
//
// Run against the local standalone network (see localnet/). Uses the real Midnight SDK.
/* eslint-disable @typescript-eslint/no-explicit-any */
import "./config.mjs";
import * as Rx from "rxjs";
import * as ledger from "@midnight-ntwrk/ledger-v8";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { deployContract, findDeployedContract } from "@midnight-ntwrk/midnight-js/contracts";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { Buffer } from "buffer";
import { webcrypto } from "node:crypto";
import { CFG, NETWORK } from "./config.mjs";
import { buildWallet, unshieldedBalance } from "./wallet.mjs";
import { runAudit } from "../src/engine/runAudit"; // the real reviewer (shared with the web app)
import * as Registry from "./managed/registry/contract/index.js";

const ZK_PATH = new URL("./managed/registry", import.meta.url).pathname;
const enc = new TextEncoder();
const sha256 = async (s: string): Promise<Uint8Array> =>
  new Uint8Array(await webcrypto.subtle.digest("SHA-256", enc.encode(s)));

// ---- STEP 1: review real Compact code -------------------------------------------------
// A user's contract with two real bugs the reviewer should catch:
//   - withdraw() authorizes the caller with ownPublicKey() (a witness => spoofable)
//   - castVote() discloses a hash of a low-entropy value (brute-forceable)
const USER_CONTRACT = `pragma language_version >= 0.23;
import CompactStandardLibrary;

export ledger owner: Bytes<32>;
export ledger vote: Bytes<32>;
witness userVote(): Field;

export circuit setOwner(): [] { owner = disclose(ownPublicKey().bytes); }

export circuit withdraw(): [] {
  assert(ownPublicKey().bytes == owner, "not owner");
}

export circuit castVote(): [] {
  vote = disclose(persistentHash<Field>(userVote()));
}`;

const review = runAudit({ contractSource: USER_CONTRACT, contractFilename: "user-contract.compact" });
const s = review.summary.bySeverity;
const verdict = `C${s.CRITICAL}/H${s.HIGH}/M${s.MEDIUM}/L${s.LOW}/I${s.INFORMATIONAL}`;
const passed = s.CRITICAL === 0 && s.HIGH === 0;

console.log("=== STEP 1: reviewed user-contract.compact ===");
console.log(`verdict: ${verdict}  (${passed ? "PASS" : "NEEDS WORK"})`);
for (const f of review.findings) {
  console.log(`  [${f.severity}] ${f.title}${f.line ? ` (line ${f.line})` : ""}`);
}

// ---- STEP 2+3: certify that review on-chain -------------------------------------------
// The witnesses: the auditor's secret (gates publishing, never disclosed) and the private
// report fingerprint (only its commitment is written on-chain).
const AUDITOR_SECRET = await sha256("grid-auditor-secret-demo");
const reportFingerprint = await sha256(JSON.stringify(review));
const receiptId = await sha256(USER_CONTRACT); // public id tying the receipt to this code

const signTransactionIntents = (tx: any, signFn: any, marker: any) => {
  if (!tx.intents || tx.intents.size === 0) return;
  for (const seg of tx.intents.keys()) {
    const intent = tx.intents.get(seg);
    if (!intent) continue;
    const cloned = ledger.Intent.deserialize("signature", marker, "pre-binding", intent.serialize());
    const sig = signFn(cloned.signatureData(seg));
    if (cloned.fallibleUnshieldedOffer)
      cloned.fallibleUnshieldedOffer = cloned.fallibleUnshieldedOffer.addSignatures(
        cloned.fallibleUnshieldedOffer.inputs.map((_: any, i: number) => cloned.fallibleUnshieldedOffer.signatures.at(i) ?? sig));
    if (cloned.guaranteedUnshieldedOffer)
      cloned.guaranteedUnshieldedOffer = cloned.guaranteedUnshieldedOffer.addSignatures(
        cloned.guaranteedUnshieldedOffer.inputs.map((_: any, i: number) => cloned.guaranteedUnshieldedOffer.signatures.at(i) ?? sig));
    tx.intents.set(seg, cloned);
  }
};

const walletAndMidnightProvider = async (ctx: any) => {
  const state = await Rx.firstValueFrom(ctx.wallet.state().pipe(Rx.filter((x: any) => x.isSynced)));
  return {
    getCoinPublicKey: () => state.shielded.coinPublicKey.toHexString(),
    getEncryptionPublicKey: () => state.shielded.encryptionPublicKey.toHexString(),
    async balanceTx(tx: any, ttl?: Date) {
      const recipe = await ctx.wallet.balanceUnboundTransaction(
        tx, { shieldedSecretKeys: ctx.shieldedSecretKeys, dustSecretKey: ctx.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) });
      const signFn = (p: any) => ctx.unshieldedKeystore.signData(p);
      signTransactionIntents(recipe.baseTransaction, signFn, "proof");
      if (recipe.balancingTransaction) signTransactionIntents(recipe.balancingTransaction, signFn, "pre-proof");
      return ctx.wallet.finalizeRecipe(recipe);
    },
    submitTx: (tx: any) => ctx.wallet.submitTransaction(tx),
  };
};

const registerForDustGeneration = async (wallet: any, ks: any) => {
  const st = await Rx.firstValueFrom(wallet.state().pipe(Rx.filter((x: any) => x.isSynced)));
  if (st.dust.balance(new Date()) > 0n) return;
  const utxos = st.unshielded.availableCoins.filter((c: any) => c.meta?.registeredForDustGeneration !== true);
  if (utxos.length) {
    const recipe = await wallet.registerNightUtxosForDustGeneration(utxos, ks.getPublicKey(), (p: any) => ks.signData(p));
    await wallet.submitTransaction(await wallet.finalizeRecipe(recipe));
  }
  await Rx.firstValueFrom(wallet.state().pipe(Rx.throttleTime(3000), Rx.filter((x: any) => x.isSynced), Rx.filter((x: any) => x.dust.balance(new Date()) > 0n)));
};

const configureProviders = async (ctx: any) => {
  const wmp = await walletAndMidnightProvider(ctx);
  const zk = new NodeZkConfigProvider(ZK_PATH);
  const accountId = wmp.getCoinPublicKey();
  const pw = `${Buffer.from(accountId, "hex").toString("base64")}!`;
  return {
    privateStateProvider: levelPrivateStateProvider({ privateStateStoreName: "grid-pstate", accountId, privateStoragePasswordProvider: () => pw } as any),
    publicDataProvider: indexerPublicDataProvider(CFG.indexer, CFG.indexerWS),
    zkConfigProvider: zk,
    proofProvider: httpClientProofProvider(CFG.proofServer, zk as any),
    walletProvider: wmp,
    midnightProvider: wmp,
  } as any;
};

console.log("\n=== STEP 2: certify the review on-chain (network:", NETWORK + ") ===");
const ctx = await buildWallet("0000000000000000000000000000000000000000000000000000000000000001");
await Rx.firstValueFrom(ctx.wallet.state().pipe(Rx.filter((x: any) => x.isSynced), Rx.filter((x: any) => unshieldedBalance(x) > 0n)));
await registerForDustGeneration(ctx.wallet, ctx.unshieldedKeystore);
const providers = await configureProviders(ctx);

const make: any = CompiledContract.make("registry", (Registry as any).Contract);
const compiled = make.pipe(
  (CompiledContract.withWitnesses as any)({
    auditorSecret: (w: any) => [w.privateState, AUDITOR_SECRET],
    reportFingerprint: (w: any) => [w.privateState, reportFingerprint],
  }),
  (CompiledContract.withCompiledFileAssets as any)(ZK_PATH),
);

const deployed: any = await deployContract(providers, { compiledContract: compiled, args: [] } as any);
const addr = deployed.deployTxData.public.contractAddress;
console.log("registry deployed at:", addr);
const tx: any = await deployed.callTx.publishReceipt(receiptId);
console.log("receipt published, tx:", tx?.public?.txId ?? tx?.public?.txHash);

console.log("\n=== STEP 3: read the certificate back from the ledger ===");
const cs: any = await providers.publicDataProvider.queryContractState(addr);
const led: any = (Registry as any).ledger(cs.data);
console.log("receipt on-chain for this contract:", led.receipts.member(receiptId));
console.log("total certified audits:", led.published.toString());
console.log("\n(off-chain receipt: verdict", verdict, "+ salt let anyone verify the private report matches.)");
process.exit(0);
