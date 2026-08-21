// Parse GitHub Actions workflow-run JSON for the exact commit that OCI wants
// to deploy. This is deliberately tiny and dependency-free so update.sh can
// defer safely when GitHub is unavailable, the run is pending, or CI failed.

export function deploymentCiDecision(payload, { sha, workflowName = "test" } = {}) {
  if (!sha) return { status: "UNKNOWN", reason: "NO_SHA" };
  const runs = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : [];
  const matches = runs
    .filter((run) => run?.head_sha === sha && run?.name === workflowName)
    .sort((a, b) => {
      const attempt = Number(b?.run_attempt ?? 0) - Number(a?.run_attempt ?? 0);
      if (attempt) return attempt;
      return String(b?.created_at ?? "").localeCompare(String(a?.created_at ?? ""));
    });
  const run = matches[0];
  if (!run) return { status: "MISSING", reason: "NO_MATCHING_PUSH_RUN" };
  if (run.status !== "completed") {
    return { status: "PENDING", reason: `RUN_${String(run.status ?? "unknown").toUpperCase()}`, runId: run.id ?? null };
  }
  if (run.conclusion !== "success") {
    return {
      status: "FAILED",
      reason: `CONCLUSION_${String(run.conclusion ?? "unknown").toUpperCase()}`,
      runId: run.id ?? null
    };
  }
  return { status: "SUCCESS", reason: "CI_GREEN", runId: run.id ?? null };
}

async function cli() {
  const [sha, workflowName = "test"] = process.argv.slice(2);
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  try {
    const payload = JSON.parse(input || "{}");
    process.stdout.write(deploymentCiDecision(payload, { sha, workflowName }).status);
  } catch {
    process.stdout.write("UNKNOWN");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await cli();
}
