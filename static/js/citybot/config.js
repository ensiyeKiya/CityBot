/** Server-injected client config (see templates/index_citybot.html). */
export const appConfig = {
  ...window.APP_CONFIG,
  SCHEME: window.location.protocol === 'https:' ? 'wss' : 'ws',
  DEFAULT_PORT: window.location.protocol === 'https:' ? 8084 : 8083,
};
