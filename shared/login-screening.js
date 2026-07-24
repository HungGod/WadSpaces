"use strict";

/**
 * Login screening.
 *
 * WadBrowser's url-redirect app registers itself as the system http/https handler, so *any* link
 * clicked anywhere on the machine lands here. That is only acceptable if the link is plausibly a
 * login page — otherwise the redirect app becomes an unrestricted browser and defeats the point of
 * the tool.
 *
 * The judgement is made from the URL alone, with no network request: the verdict is instant, and
 * nothing is loaded before it is allowed. The trade-off is deliberate — a page that merely *looks*
 * like a login URL ("/wiki/Login", a blog post about auth) gets through. That costs the user one
 * uninteresting page; making them wait several seconds on every link, or wrongly blocking a real
 * sign-in, costs far more. Navigation confinement (see isAuthFlowUrl) is what keeps a link that
 * slips through from turning into a browsing session.
 */

/**
 * Sites that never open, however genuine the sign-in page is. A login page on one of these is
 * still a doorway to the site, and "just logging in" is the usual first step of a relapse — so
 * these are refused before scoring even starts.
 *
 * Patterns match the host and all its subdomains. Add or remove entries freely; this list is meant
 * to be edited to fit the person using it.
 *
 * Note this blocks the site's own OAuth endpoints too, so "Continue with Facebook" on a third-party
 * site will not complete. "Continue with Google" still works: accounts.google.com is a separate
 * host from youtube.com and is not blocked.
 */
const BLOCKED_HOSTS = [
  "reddit.com",
  "redd.it",
  "twitter.com",
  "x.com",
  "t.co",
  "facebook.com",
  "fb.com",
  "fb.me",
  "messenger.com",
  "instagram.com",
  "threads.net",
  "threads.com",
  "tiktok.com",
  "youtube.com",
  "youtu.be",
  "snapchat.com",
  "pinterest.com",
  "tumblr.com",
  "twitch.tv",
  "linkedin.com",
  "imgur.com",
  "9gag.com",
  "quora.com",
  "bsky.app",
  "onlyfans.com",
];

/**
 * Site names taken from the denylist, used to catch a login URL that names its destination rather
 * than linking to it — "accounts.google.com/signin?service=youtube" is Google's real sign-in host,
 * but it is still logging in to YouTube. Short names are dropped ("x", "t", "fb") because a bare
 * query value like "x" would match constantly.
 */
const BLOCKED_SITE_NAMES = new Set(
  BLOCKED_HOSTS.map((domain) => domain.split(".")[0]).filter((name) => name.length >= 5)
);

/** Hosts that exist only to authenticate: every path on them is part of a login flow. */
const DEDICATED_AUTH_HOSTS = [
  /^accounts\.google\.com$/i,
  /^accounts\.youtube\.com$/i,
  /^login\.microsoftonline\.com$/i,
  /^login\.microsoft\.com$/i,
  /^login\.live\.com$/i,
  /^signin\.microsoft\.com$/i,
  /^appleid\.apple\.com$/i,
  /^idmsa\.apple\.com$/i,
  /^login\.yahoo\.com$/i,
  /^login\.salesforce\.com$/i,
  /^signin\.aws\.amazon\.com$/i,
  /^id\.atlassian\.com$/i,
  /^auth\.atlassian\.com$/i,
  /(^|\.)auth0\.com$/i,
  /(^|\.)okta\.com$/i,
  /(^|\.)oktapreview\.com$/i,
  /(^|\.)onelogin\.com$/i,
  /(^|\.)pingidentity\.com$/i,
  /(^|\.)duosecurity\.com$/i,
  /(^|\.)authy\.com$/i,
  /(^|\.)clerk\.accounts\.dev$/i,
  /(^|\.)workos\.com$/i,
  /(^|\.)stytch\.com$/i,
];

/** Host prefixes conventionally reserved for auth ("login.", "sso.", ...). */
const AUTH_HOST_PREFIX =
  /^(login|logon|signin|sign-in|signon|auth|oauth|oauth2|accounts?|id|ids|sso|idp|identity|passport|openid)\./i;

/**
 * Path shapes that indicate a login, consent, or MFA step. Each keyword may be introduced by "/",
 * "-" or "_" so that "/loginDeepControl" and "/Service-Login" match as readily as "/login" — see
 * normalizePathForMatching(), which splits camelCase before these are applied.
 */
const AUTH_PATH_PATTERNS = [
  /[/\-_]log[-_]?in\b/i,
  /[/\-_]sign[-_]?in\b/i,
  /[/\-_]sign[-_]?on\b/i,
  /[/\-_]logon\b/i,
  /[/\-_]auth(?:orize|orization|enticate)?\b/i,
  /[/\-_]oauth2?\b/i,
  /[/\-_]openid[-_]?connect\b/i,
  /\/connect\/authorize/i,
  /\/protocol\/openid-connect\//i,
  /[/\-_]sso\b/i,
  /[/\-_]saml\b/i,
  /[/\-_]idp\b/i,
  /\/sessions?\/new\b/i,
  /\/users?\/sign[-_]?in\b/i,
  /\/accounts?\/login\b/i,
  /\/ap\/signin\b/i,
  /\/i\/flow\/login\b/i,
  /\/u\/login\b/i,
  /\/wp-login\.php$/i,
  /[/\-_]two[-_]?factor\b/i,
  /[/\-_]2fa\b/i,
  /[/\-_]mfa\b/i,
  /[/\-_]challenge\b/i,
  /[/\-_]verify(?:[-_]?(?:email|code|identity))?\b/i,
  /[/\-_]checkpoint\b/i,
  /[/\-_]passkey\b/i,
  /[/\-_]magic[-_]?link\b/i,
];

/** Query values that name the flow being started, e.g. "?mode=login" or "?screen_hint=signin". */
const AUTH_QUERY_VALUES = /^(log[-_]?in|sign[-_]?in|sign[-_]?on|logon|auth|authenticate|sso|mfa|2fa|otp|passkey)$/i;

/** Query params that only appear in an OAuth / OIDC / SAML authorization request. */
const OAUTH_REQUEST_PARAMS = ["client_id", "response_type", "redirect_uri", "redirect_url", "code_challenge", "scope"];

/** Query params that appear on the redirect *back* from an identity provider. */
const OAUTH_CALLBACK_PARAMS = [
  "code",
  "id_token",
  "access_token",
  "samlresponse",
  "oauth_token",
  "oauth_verifier",
  "ticket",
  "session_state",
];

/** Downloadable/media targets are never login pages; reject before anything else. */
const NON_PAGE_EXT =
  /\.(mp4|m4v|webm|mkv|avi|mov|flv|wmv|mp3|m4a|aac|flac|wav|ogg|opus|jpg|jpeg|png|gif|webp|avif|bmp|svg|ico|pdf|zip|tar|gz|bz2|xz|7z|rar|iso|exe|dmg|apk|deb|rpm|torrent)$/i;

/**
 * Score a link must reach to open. Two is one solid signal — a login-shaped path, a sign-in query
 * value, an auth hostname, or OAuth parameters.
 */
const MIN_SCORE_TO_OPEN = 2;

function parseUrl(raw) {
  try {
    return new URL(String(raw));
  } catch (_e) {
    return null;
  }
}

/** True for a host on the denylist or any of its subdomains. */
function isBlockedHost(hostname) {
  const h = String(hostname || "")
    .toLowerCase()
    .replace(/\.$/, "");
  return BLOCKED_HOSTS.some((domain) => h === domain || h.endsWith(`.${domain}`));
}

/**
 * Why this URL is off-limits, or null. Covers both the host itself and where the link says it is
 * headed — a sign-in page on an allowed host that carries the user onward to a blocked site
 * ("?continue=https://youtube.com/", "?service=youtube") is refused just the same.
 */
function blockedReason(u) {
  if (isBlockedHost(u.hostname)) return `${u.hostname} is on the blocked-sites list`;
  for (const [, rawValue] of u.searchParams) {
    const value = String(rawValue).trim();
    if (!value) continue;
    if (BLOCKED_SITE_NAMES.has(value.toLowerCase())) {
      return `it signs in to ${value.toLowerCase()}, which is on the blocked-sites list`;
    }
    if (/^https?:\/\//i.test(value)) {
      const target = parseUrl(value);
      if (target && isBlockedHost(target.hostname)) {
        return `it leads on to ${target.hostname}, which is on the blocked-sites list`;
      }
    }
  }
  return null;
}

function isDedicatedAuthHost(hostname) {
  const h = String(hostname || "");
  return DEDICATED_AUTH_HOSTS.some((re) => re.test(h));
}

/** "login.example.com", "sso.example.com" — a hostname whose whole purpose is authentication. */
function isAuthReservedHost(hostname) {
  return AUTH_HOST_PREFIX.test(String(hostname || ""));
}

/**
 * Split camelCase so word-boundary patterns can see the seam: "/loginDeepControl" becomes
 * "/login-Deep-Control". Without this, `\b` never fires between "login" and "DeepControl" (both
 * are word characters) and a real login URL scores zero.
 */
function normalizePathForMatching(pathAndHash) {
  return String(pathAndHash || "").replace(/([a-z0-9])([A-Z])/g, "$1-$2");
}

function hasAnyParam(searchParams, names) {
  for (const [key] of searchParams) {
    if (names.includes(String(key).toLowerCase())) return true;
  }
  return false;
}

function countParams(searchParams, names) {
  const seen = new Set();
  for (const [key] of searchParams) {
    const k = String(key).toLowerCase();
    if (names.includes(k)) seen.add(k);
  }
  return seen.size;
}

/** True if the URL carries the params an identity provider sends back to the app after login. */
function isOAuthCallbackUrl(url) {
  const u = typeof url === "string" ? parseUrl(url) : url;
  if (!u) return false;
  return hasAnyParam(u.searchParams, OAUTH_CALLBACK_PARAMS);
}

/**
 * Score a URL on how much it looks like a login/auth endpoint.
 * Returns { score, signals, fatal } — `fatal` is a reason the link can never be a login page.
 */
function analyzeUrl(raw) {
  const signals = [];
  const u = parseUrl(raw);
  if (!u) return { score: 0, signals: [], fatal: "that is not a valid web address" };
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { score: 0, signals: [], fatal: `it uses the unsupported "${u.protocol}" scheme` };
  }
  // Checked before scoring: a real sign-in page on a blocked site must not earn its way in.
  const blocked = blockedReason(u);
  if (blocked) return { score: 0, signals: [], fatal: blocked };
  if (NON_PAGE_EXT.test(u.pathname)) {
    return { score: 0, signals: [], fatal: "it points at a file download, not a page" };
  }

  let score = 0;
  if (isDedicatedAuthHost(u.hostname)) {
    score += 3;
    signals.push(`known identity provider (${u.hostname})`);
  } else if (isAuthReservedHost(u.hostname)) {
    score += 3;
    signals.push(`auth-reserved hostname (${u.hostname})`);
  }

  const pathAndHash = normalizePathForMatching(`${u.pathname}${u.hash || ""}`);
  if (AUTH_PATH_PATTERNS.some((re) => re.test(pathAndHash))) {
    score += 2;
    signals.push(`login-shaped path (${u.pathname})`);
  }

  for (const [, value] of u.searchParams) {
    if (AUTH_QUERY_VALUES.test(String(value).trim())) {
      score += 2;
      signals.push("query names a sign-in flow");
      break;
    }
  }

  if (countParams(u.searchParams, OAUTH_REQUEST_PARAMS) >= 2) {
    score += 3;
    signals.push("OAuth/OIDC authorization parameters");
  } else if (hasAnyParam(u.searchParams, ["samlrequest"])) {
    score += 3;
    signals.push("SAML authentication request");
  }

  if (isOAuthCallbackUrl(u)) {
    score += 1;
    signals.push("identity-provider callback parameters");
  }

  return { score, signals, fatal: null };
}

/**
 * Decide whether a redirected link may open. Pure and synchronous — nothing is requested until the
 * link is allowed.
 */
function screenUrl(rawUrl) {
  const analysis = analyzeUrl(rawUrl);
  if (analysis.fatal) {
    return { allowed: false, reason: analysis.fatal, signals: [], authHosts: [] };
  }
  if (analysis.score < MIN_SCORE_TO_OPEN) {
    return { allowed: false, reason: "it is not a sign-in page", signals: [], authHosts: [] };
  }
  const u = parseUrl(rawUrl);
  return {
    allowed: true,
    reason: "sign-in link",
    signals: analysis.signals,
    authHosts: u ? [u.hostname] : [],
  };
}

/**
 * Navigation policy once a login page is open.
 *
 * The redirect window exists to finish one login, not to browse. A navigation stays allowed while
 * it is still inside the auth flow: on a host already part of the flow (with an auth-shaped path,
 * unless the host is a dedicated identity provider, where every path counts), or carrying
 * identity-provider callback params. Anything else ends the flow.
 *
 * This is what contains the URL check's deliberate looseness: a link that got in on appearances
 * alone still cannot navigate onward into ordinary browsing.
 *
 * `flow` is { authHosts: Set<string> }.
 */
function isAuthFlowUrl(raw, flow) {
  const u = parseUrl(raw);
  if (!u) return false;
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    // about:blank and the local end-of-flow page are chrome, not navigation targets.
    return u.protocol === "about:" || u.protocol === "file:";
  }
  // Before the allowances below, which would otherwise wave a blocked site through on the strength
  // of callback params or an auth-looking hostname.
  if (blockedReason(u)) return false;
  // The redirect back from an identity provider may land on a host never seen before.
  if (isOAuthCallbackUrl(u)) return true;
  if (isDedicatedAuthHost(u.hostname) || isAuthReservedHost(u.hostname)) return true;

  const hosts = flow && flow.authHosts ? flow.authHosts : new Set();
  if (!hosts.has(u.hostname)) return false;

  const analysis = analyzeUrl(u.toString());
  return !analysis.fatal && analysis.score >= MIN_SCORE_TO_OPEN;
}

module.exports = {
  analyzeUrl,
  screenUrl,
  isAuthFlowUrl,
  isOAuthCallbackUrl,
  isDedicatedAuthHost,
  isAuthReservedHost,
  isBlockedHost,
  MIN_SCORE_TO_OPEN,
};
