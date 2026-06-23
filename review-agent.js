const https = require("https");

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const REPO = process.env.GITHUB_REPOSITORY;
const PR_NUMBER = process.env.PR_NUMBER;
const COMMIT_SHA = process.env.COMMIT_SHA;

const [OWNER, REPO_NAME] = REPO.split("/");

function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function getPRDiff() {
  console.log(`\n── Fetching PR #${PR_NUMBER} diff...`);

  const res = await request({
    hostname: "api.github.com",
    path: `/repos/${OWNER}/${REPO_NAME}/pulls/${PR_NUMBER}/files`,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "claude-pr-review-agent",
    },
  });

  // Log status for debugging
  console.log(`GitHub API status: ${res.status}`);

  if (res.status !== 200) {
    throw new Error(
      `GitHub API error ${res.status}: ${JSON.stringify(res.body)}`,
    );
  }

  const files = res.body;

  if (!Array.isArray(files)) {
    throw new Error(`Expected array of files, got: ${JSON.stringify(files)}`);
  }

  console.log(`Files changed: ${files.length}`);
  files.forEach((f) =>
    console.log(`  - ${f.filename} (+${f.additions} -${f.deletions})`),
  );

  // Build diff — cap each file patch to 3000 chars to stay within token limits
  const diffText = files
    .map(
      (f) =>
        `### File: ${f.filename} (${f.status})\n` +
        `+${f.additions} additions, -${f.deletions} deletions\n\n` +
        "```diff\n" +
        (f.patch || "(binary or no patch)").slice(0, 3000) +
        "\n```",
    )
    .join("\n\n---\n\n");

  return { files, diffText };
}

async function reviewWithClaude(diffText) {
  console.log("\n── Sending diff to Claude...");

  const body = {
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    system: `You are an expert code reviewer for Java and JavaScript projects.
Review the PR diff carefully and return ONLY valid JSON — absolutely no extra text, no markdown fences, no explanation outside the JSON.

Return exactly this structure:
{
  "summary": "2-3 sentence overall assessment of the PR",
  "verdict": "APPROVE",
  "issues": [
    {
      "file": "path/to/file.js",
      "line": 10,
      "severity": "critical",
      "comment": "What is wrong and how to fix it"
    }
  ]
}

verdict must be exactly one of: APPROVE, COMMENT, REQUEST_CHANGES
severity must be exactly one of: critical, warning, suggestion
issues can be an empty array [] if no problems found.`,
    messages: [
      {
        role: "user",
        content: `Review this PR diff and return only JSON:\n\n${diffText}`,
      },
    ],
  };

  const bodyStr = JSON.stringify(body);

  const res = await request(
    {
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
      },
    },
    body,
  );

  // ── KEY FIX: log full API response before touching it ──
  console.log(`Anthropic API status: ${res.status}`);
  console.log(`Anthropic API response: ${JSON.stringify(res.body, null, 2)}`);

  if (res.status !== 200) {
    throw new Error(
      `Anthropic API error ${res.status}: ${JSON.stringify(res.body)}`,
    );
  }

  if (!res.body.content || !res.body.content[0]) {
    throw new Error(
      `Unexpected Anthropic response shape: ${JSON.stringify(res.body)}`,
    );
  }

  const rawText = res.body.content[0].text.trim();
  console.log(`\nClaude raw response:\n${rawText}`);

  // Strip markdown fences if present
  const clean = rawText
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  let review;
  try {
    review = JSON.parse(clean);
  } catch (e) {
    throw new Error(
      `Claude returned invalid JSON:\n${clean}\n\nParse error: ${e.message}`,
    );
  }

  // Validate and set safe defaults
  if (
    !review.verdict ||
    !["APPROVE", "COMMENT", "REQUEST_CHANGES"].includes(review.verdict)
  ) {
    review.verdict = "COMMENT";
  }
  if (!Array.isArray(review.issues)) {
    review.issues = [];
  }
  if (!review.summary) {
    review.summary = "Review completed.";
  }

  return review;
}

async function postReview(review) {
  console.log(
    `\n── Posting review (verdict: ${review.verdict}, issues: ${review.issues.length})...`,
  );

  const emoji = { critical: "🔴", warning: "🟡", suggestion: "🔵" };

  const issueLines = review.issues
    .map(
      (i) =>
        `${emoji[i.severity] || "•"} **${i.file}** line ${i.line}: ${i.comment}`,
    )
    .join("\n\n");

  const bodyText =
    `## 🤖 Claude AI Code Review\n\n` +
    `${review.summary}\n\n` +
    (review.issues.length > 0
      ? `### Issues found (${review.issues.length})\n\n${issueLines}`
      : `### ✅ Looks good — no issues found!`);

  const res = await request(
    {
      hostname: "api.github.com",
      path: `/repos/${OWNER}/${REPO_NAME}/pulls/${PR_NUMBER}/reviews`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "claude-pr-review-agent",
      },
    },
    {
      body: bodyText,
      event: review.verdict,
    },
  );

  console.log(`GitHub review post status: ${res.status}`);

  if (res.status !== 200) {
    throw new Error(`Failed to post review: ${JSON.stringify(res.body)}`);
  }

  console.log("✅ Review posted successfully!");
}

async function main() {
  console.log("═══════════════════════════════════════");
  console.log("  Claude PR Review Agent");
  console.log(`  Repo   : ${REPO}`);
  console.log(`  PR     : #${PR_NUMBER}`);
  console.log(`  Commit : ${COMMIT_SHA}`);
  console.log("═══════════════════════════════════════");

  const { diffText } = await getPRDiff();
  const review = await reviewWithClaude(diffText);
  await postReview(review);

  console.log("\n✅ Done!");
}

main().catch((err) => {
  console.error("\n❌ Agent failed:");
  console.error(err.message);
  process.exit(1);
});
