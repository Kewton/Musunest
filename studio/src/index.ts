export {
  API_PREFIX,
  ALLOWED_HOSTS,
  createToken,
  guardRequest,
  headerValue,
  isAllowedHost,
  isAllowedOrigin,
  pathname,
  TOKEN_HEADER,
  tokenMatches,
} from "./server/guard.js";
export type { GuardContext, GuardFailure } from "./server/guard.js";

export { DEFAULT_HOME_NAME, HOME_ENV, resolveStudioHome, StudioHomeError } from "./server/home.js";
export type { StudioHomeOptions } from "./server/home.js";

export { BIND_HOST, createRequestHandler, createStudioServer, DEFAULT_PORT, listen } from "./server/http.js";
export type { StudioServerOptions } from "./server/http.js";

export { escapeHtmlAttribute, renderPage } from "./server/page.js";
