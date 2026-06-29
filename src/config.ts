export interface Config {
  port: number;
  maxBrowserInstances: number;
  sessionDefaultTimeoutMinutes: number;
  tokensFilePath: string;
  logLevel: string;
  nodeEnv: string;
  corsOrigin: string | boolean;
}

function loadEnv(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}

function loadEnvInt(key: string, defaultValue: number): number {
  const val = process.env[key];
  if (val === undefined || val === '') return defaultValue;
  const n = parseInt(val, 10);
  return isNaN(n) ? defaultValue : n;
}

export const config: Config = {
  port: loadEnvInt('PORT', 9191),
  maxBrowserInstances: loadEnvInt('MAX_BROWSER_INSTANCES', 10),
  sessionDefaultTimeoutMinutes: loadEnvInt('SESSION_DEFAULT_TIMEOUT_MINUTES', 10),
  tokensFilePath: loadEnv('TOKENS_FILE_PATH', './tokens.json'),
  logLevel: loadEnv('LOG_LEVEL', 'info'),
  nodeEnv: loadEnv('NODE_ENV', 'production'),
  corsOrigin: loadEnv('CORS_ORIGIN', '*') || true,
};
