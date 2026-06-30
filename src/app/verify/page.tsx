"use client";

import { useState } from "react";
import Link from "next/link";
import { BracketLabel, Button, Card, SectionLabel } from "@/components/ui";
import { computeReportHash, computeReportId, genSalt, type Receipt } from "@/midnight/receipt";
import { NETWORK } from "@/midnight/config";
import { runAudit } from "@/engine/runAudit";

type Status = "idle" | "ok" | "fail" | "error";
type ChainStatus = "idle" | "ok" | "fail" | "error";

// A small contract with a real bug, used to generate a self-consistent sample receipt so
// visitors can try the offline check without having run an audit first.
const SAMPLE_CONTRACT = `pragma language_version >= 0.23;
import CompactStandardLibrary;

export ledger owner: Bytes<32>;
witness userVote(): Field;

export circuit setOwner(): [] { owner = disclose(ownPublicKey().bytes); }

// BUG: authorizes the caller with ownPublicKey() (a witness => spoofable)
export circuit withdraw(): [] {
  assert(ownPublicKey().bytes == owner, "not owner");
}`;

export default function Verify() {
  const [receiptText, setReceiptText] = useState("");
  const [reportText, setReportText] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [detail, setDetail] = useState<string[]>([]);

  // on-chain check
  const [chainStatus, setChainStatus] = useState<ChainStatus>("idle");
  const [chainDetail, setChainDetail] = useState<string[]>([]);
  const [chainBusy, setChainBusy] = useState(false);

  function parseReceipt(): Receipt | null {
    try {
      return JSON.parse(receiptText) as Receipt;
    } catch {
      return null;
    }
  }

  // Generate a self-consistent receipt + report pair (offline) so visitors can try the
  // check immediately. The on-chain step won't apply (this sample was never anchored).
  async function loadSample() {
    const result = runAudit({ contractSource: SAMPLE_CONTRACT, contractFilename: "sample.compact" });
    const reportJson = JSON.stringify(result);
    const s = result.summary.bySeverity;
    const verdict = `C${s.CRITICAL}/H${s.HIGH}/M${s.MEDIUM}/L${s.LOW}/I${s.INFORMATIONAL}`;
    const salt = genSalt();
    const reportHash = await computeReportHash(reportJson);
    const reportId = await computeReportId(reportHash, salt);
    const receipt: Receipt = { reportId, reportHash, verdict, salt, network: NETWORK, registryAddress: "" };
    setReceiptText(JSON.stringify(receipt, null, 2));
    setReportText(reportJson);
    setStatus("idle");
    setDetail([]);
    setChainStatus("idle");
    setChainDetail([]);
  }

  async function verify() {
    setStatus("idle");
    setDetail([]);
    const receipt = parseReceipt();
    if (!receipt) {
      setStatus("error");
      setDetail(["Receipt is not valid JSON."]);
      return;
    }

    try {
      // Recompute the chain from the original report + the receipt's salt/verdict.
      const reportHash = await computeReportHash(reportText);
      const reportId = await computeReportId(reportHash, receipt.salt);

      const checks: [string, boolean][] = [
        ["the report fingerprint matches", reportHash === receipt.reportHash],
        ["the receipt id matches", reportId === receipt.reportId],
      ];
      const lines = checks.map(([k, v]) => `${v ? "✅" : "❌"} ${k}`);
      lines.push(
        "ℹ️ The receipt matches the report you pasted, checked entirely on your device.",
        "ℹ️ Use “Check on-chain” below to confirm it's actually saved on the blockchain.",
      );

      const allOk = checks.every(([, v]) => v);
      setStatus(allOk ? "ok" : "fail");
      setDetail(lines);
    } catch (e) {
      setStatus("error");
      setDetail([e instanceof Error ? e.message : String(e)]);
    }
  }

  async function checkOnChain() {
    setChainStatus("idle");
    setChainDetail([]);
    const receipt = parseReceipt();
    if (!receipt) {
      setChainStatus("error");
      setChainDetail(["Receipt is not valid JSON."]);
      return;
    }
    setChainBusy(true);
    try {
      // Dynamic import keeps the Midnight SDK/WASM out of the server-rendered graph.
      const { readReceiptOnChain } = await import("@/midnight/verifyChain");
      const res = await readReceiptOnChain(receipt, reportText);

      const lines = [
        `${res.found ? "✅" : "❌"} this receipt is saved in the registry`,
        `${res.commitmentMatches ? "✅" : "❌"} the saved fingerprint matches this report`,
      ];
      if (res.total !== undefined) lines.push(`ℹ️ total reviews saved by this registry: ${res.total}`);
      lines.push(
        `ℹ️ registry: ${receipt.registryAddress.slice(0, 18)}… on ${receipt.network}`,
      );

      const allOk = res.found && res.commitmentMatches;
      setChainStatus(allOk ? "ok" : "fail");
      setChainDetail(lines);
    } catch (e) {
      setChainStatus("error");
      setChainDetail([e instanceof Error ? e.message : String(e)]);
    } finally {
      setChainBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-[900px] px-6 py-12">
      <BracketLabel>VERIFY · AUDIT RECEIPT</BracketLabel>
      <h1 className="mt-3 text-3xl font-semibold">Verify a receipt</h1>
      <p className="mt-3 max-w-2xl font-sans text-grid-text-2">
        Paste a receipt and the report it was made from. We check that they match — right here in
        your browser — and can confirm the receipt is saved on the blockchain. Your report never
        leaves your device. New here? Hit <span className="text-grid-text">Try a sample</span> to see
        how it works.
      </p>

      <div className="mt-8 space-y-5">
        <div>
          <SectionLabel num="01" label="Receipt JSON" />
          <textarea
            value={receiptText}
            onChange={(e) => setReceiptText(e.target.value)}
            placeholder='{"reportId":"…","reportHash":"…","verdict":"…","salt":"…",…}'
            spellCheck={false}
            className="h-40 w-full resize-y rounded border border-grid-border bg-grid-bg p-4 font-mono text-xs text-grid-text outline-none focus:border-grid-accent"
          />
        </div>
        <div>
          <SectionLabel num="02" label="Original report (the audit result JSON)" />
          <textarea
            value={reportText}
            onChange={(e) => setReportText(e.target.value)}
            placeholder="Paste the exact AuditResult JSON the receipt was created from…"
            spellCheck={false}
            className="h-40 w-full resize-y rounded border border-grid-border bg-grid-bg p-4 font-mono text-xs text-grid-text outline-none focus:border-grid-accent"
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" onClick={loadSample}>
            TRY A SAMPLE
          </Button>
          <Button onClick={verify} disabled={!receiptText.trim() || !reportText.trim()}>
            VERIFY OFFLINE →
          </Button>
          <Button
            variant="outline"
            onClick={checkOnChain}
            disabled={chainBusy || !receiptText.trim() || !reportText.trim()}
          >
            {chainBusy ? "CHECKING…" : "CHECK ON-CHAIN →"}
          </Button>
          <Link href="/audit">
            <Button variant="outline">BACK TO AUDIT</Button>
          </Link>
        </div>

        {status !== "idle" && (
          <Card>
            <p
              className={`font-mono text-sm ${
                status === "ok"
                  ? "text-sev-info"
                  : status === "fail"
                    ? "text-sev-critical"
                    : "text-sev-medium"
              }`}
            >
              {status === "ok"
                ? "This receipt matches the report."
                : status === "fail"
                  ? "This report does not match the receipt."
                  : "Could not check this."}
            </p>
            <pre className="mt-3 whitespace-pre-wrap font-mono text-xs text-grid-text-2">
              {detail.join("\n")}
            </pre>
          </Card>
        )}

        {chainStatus !== "idle" && (
          <Card>
            <p
              className={`font-mono text-sm ${
                chainStatus === "ok"
                  ? "text-sev-info"
                  : chainStatus === "fail"
                    ? "text-sev-critical"
                    : "text-sev-medium"
              }`}
            >
              {chainStatus === "ok"
                ? "Confirmed: this receipt is saved on the blockchain and matches the report."
                : chainStatus === "fail"
                  ? "Not confirmed (see details below)."
                  : "Could not reach the blockchain."}
            </p>
            <pre className="mt-3 whitespace-pre-wrap font-mono text-xs text-grid-text-2">
              {chainDetail.join("\n")}
            </pre>
          </Card>
        )}
      </div>
    </div>
  );
}
