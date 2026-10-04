const s = require("./login-screening");

// Links that must open. Screening is URL-only, so these are judged on shape alone.
const ALLOW = [
  "https://cursor.com/loginDeepControl?challenge=Futo1fGUcTXbiEjr3GfRSM1EwV_AqDHWkOL0bz74VY0&uuid=5ec651a4-e16f-463d-b37d-3ea79f646dc8&mode=login&supportsSelectedTeamLogin=true",
  "https://accounts.google.com/signin/v2/identifier",
  "https://accounts.google.com/ServiceLogin",
  "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x&response_type=code&redirect_uri=https%3A%2F%2Fapp.com",
  "https://github.com/login",
  "https://github.com/login/oauth/authorize?client_id=abc&redirect_uri=https://app.com&scope=user",
  "https://appleid.apple.com/auth/authorize?client_id=a&response_type=code",
  "https://gitlab.com/users/sign_in",
  "https://myco.okta.com/app/whatever",
  "https://discord.com/oauth2/authorize?client_id=1&scope=identify",
  "https://auth.example.com/realms/main/protocol/openid-connect/auth?client_id=x&response_type=code",
  "https://example.com/wp-login.php",
  "https://slack.com/signin",
  "https://app.example.com/signInWithSso",
  "https://example.com/?screen_hint=signin",
];

// Links that must be blocked outright.
const BLOCK = [
  // Denylisted sites: a genuine sign-in page is still a doorway, so it is refused before scoring.
  "https://www.reddit.com/login",
  "https://old.reddit.com/login",
  "https://x.com/i/flow/login",
  "https://twitter.com/i/flow/login",
  "https://www.facebook.com/login",
  "https://www.facebook.com/v18.0/dialog/oauth?client_id=1&response_type=code",
  "https://www.instagram.com/accounts/login/",
  "https://www.tiktok.com/login",
  "https://m.youtube.com/login",
  "https://www.linkedin.com/login",
  "https://www.twitch.tv/login",
  // Indirect routes to a denylisted site via an allowed sign-in host.
  "https://accounts.google.com/signin?service=youtube",
  "https://accounts.google.com/signin/v2/identifier?continue=https%3A%2F%2Fwww.youtube.com%2F",
  "https://login.example.com/sso?next=https://www.instagram.com/",
  "https://www.reddit.com/r/all",
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "https://twitter.com/home",
  "https://news.ycombinator.com/",
  "https://example.com/",
  "https://www.pornhub.com/video?id=1",
  "https://instagram.com/explore",
  "https://www.netflix.com/browse",
  "https://example.com/signing-bonus-guide",
  "https://example.com/blogindex",
  "https://example.com/movie.mp4",
  "https://example.com/game.exe",
  "ftp://example.com/login",
  "not a url at all",
];

// Accepted false passes: login-shaped URLs that are not login pages. Documented, not fixed --
// blocking a real sign-in is the worse error, and confinement stops these becoming browsing.
const TOLERATED = ["https://en.wikipedia.org/wiki/Login", "https://example.com/blog/how-to-login-faster-2024-guide"];

let fail = 0;
const run = (label, urls, want) => {
  console.log(`\n=== ${label} ===`);
  for (const u of urls) {
    const v = s.screenUrl(u);
    const ok = v.allowed === want;
    if (!ok) fail++;
    console.log(`${ok ? "ok  " : "FAIL"} allowed=${String(v.allowed).padEnd(5)} ${u.slice(0, 66)}`);
    console.log(`       -> ${v.allowed ? v.signals.join(" | ") : v.reason}`);
  }
};

run("must open", ALLOW, true);
run("must block", BLOCK, false);
run("tolerated false passes (allowed by design)", TOLERATED, true);

console.log("\n=== navigation confinement ===");
const flow = { authHosts: new Set(["cursor.com", "gitlab.com"]) };
const navCases = [
  ["https://gitlab.com/users/sign_in", true],
  ["https://gitlab.com/users/two-factor", true],
  ["https://cursor.com/loginDeepControl?mode=login", true],
  ["https://accounts.google.com/anything/at/all", true],
  ["https://accounts.google.com/signin?service=youtube", false],
  ["https://myapp.com/oauth/callback?code=abc&state=xyz", true],
  ["https://login.example.com/step2", true],
  ["https://gitlab.com/explore", false],
  ["https://www.reddit.com/login", false],
  ["https://login.reddit.com/anything", false],
  ["https://x.com/home?code=1&state=2", false],
  ["https://www.youtube.com/watch?code=abc&state=x", false],
  ["https://cursor.com/dashboard", false],
  ["https://news.ycombinator.com/", false],
  ["https://youtube.com/feed", false],
];
for (const [u, want] of navCases) {
  const got = s.isAuthFlowUrl(u, flow);
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"} allowed=${String(got).padEnd(5)} want=${String(want).padEnd(5)} ${u}`);
}

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
