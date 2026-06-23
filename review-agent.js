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
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function getPRDiff() {
  console.log(`Fetching PR #${PR_NUMBER} diff...`);
  const files = await request({
    hostname: "api.github.com",
    path: `/repos/${OWNER}/${REPO_NAME}/pulls/${PR_NUMBER}/files`,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "claude-pr-review-agent",
    },
  });
  const diffText = files
    .map(
      (f) =>
        `### File: ${f.filename}\n\`\`\`diff\n${f.patch || "(no patch)"}\n\`\`\``,
    )
    .join("\n\n---\n\n");
  return { files, diffText };
}

async function reviewWithClaude(diffText) {
  console.log("Sending to Claude...");
  const body = {
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system: `You are an expert code reviewer for Java and JavaScript projects.
Review the PR diff and return ONLY this JSON — no extra text:
{
  "summary": "2-3 sentence assessment",
  "verdict": "APPROVE" or "COMMENT" or "REQUEST_CHANGES",
  "issues": [
    {
      "file": "path/to/file.js",
      "line": 10,
      "severity": "critical" or "warning" or "suggestion",
      "comment": "What is wrong and how to fix it"
    }
  ]
}`,
    messages: [{ role: "user", content: `Review this diff:\n\n${diffText}` }],
  };

  const bodyStr = JSON.stringify(body);
  const response = await request(
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

  const text = response.content[0].text
    .trim()
    .replace(/^```json\n?/, "")
    .replace(/\n?```$/, "");
  return JSON.parse(text);
}

async function postReview(review) {
  const emoji = { critical: "🔴", warning: "🟡", suggestion: "🔵" };
  const issueList = review.issues
    .map(
      (i) =>
        `${emoji[i.severity] || "•"} **${i.file}** line ${i.line}: ${i.comment}`,
    )
    .join("\n\n");

  const body =
    `## 🤖 Claude AI Code Review\n\n${review.summary}\n\n` +
    (review.issues.length > 0
      ? `### Issues (${review.issues.length})\n\n${issueList}`
      : "### ✅ No issues found — looks good!");

  await request(
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
    { body, event: review.verdict },
  );

  console.log(`Review posted — verdict: ${review.verdict}`);
}

async function main() {
  const { diffText } = await getPRDiff();
  const review = await reviewWithClaude(diffText);
  await postReview(review);
  console.log("Done!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
