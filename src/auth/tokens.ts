import { readFileSync, existsSync } from 'fs';
import { Token, TokenFile } from '../types';

export class TokenManager {
  private tokens: Map<string, Token> = new Map();

  constructor(filePath: string) {
    this.load(filePath);
  }

  private load(filePath: string): void {
    try {
      if (!existsSync(filePath)) {
        console.warn(`Tokens file not found at ${filePath}, no tokens loaded`);
        return;
      }
      const data: TokenFile = JSON.parse(readFileSync(filePath, 'utf-8'));
      for (const token of data.tokens) {
        this.tokens.set(token.secret, token);
      }
      console.info(`Loaded ${data.tokens.length} tokens`);
    } catch (err) {
      console.error(`Failed to load tokens from ${filePath}:`, err);
      process.exit(1);
    }
  }

  findBySecret(secret: string): Token | undefined {
    return this.tokens.get(secret);
  }
}
