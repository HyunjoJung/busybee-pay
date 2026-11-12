import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

export function loadBusiness() {
  return readJson('config/business.json');
}

export function loadRateCard() {
  return readJson('config/rate-card.json');
}

export function loadSampleInbox() {
  return readJson('data/sample-inbox.json');
}

function list(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const settings = {
  port: Number(process.env.PORT || 3000),
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    models: [...new Set([...list(process.env.GEMINI_MODEL || 'gemini-3.5-flash'), ...list(process.env.GEMINI_FALLBACK_MODELS || 'gemini-flash-lite-latest')])],
    agentMaxSteps: Number(process.env.AGENT_MAX_STEPS || 8),
  },
  paypal: {
    clientId: process.env.PAYPAL_CLIENT_ID || '',
    clientSecret: process.env.PAYPAL_CLIENT_SECRET || '',
    environment: (process.env.PAYPAL_ENVIRONMENT || 'SANDBOX').toUpperCase(),
  },
  runtimeDir: path.join(ROOT, 'data', 'runtime'),
};

export function setupStatus() {
  return {
    gemini: Boolean(settings.gemini.apiKey),
    geminiModels: settings.gemini.models,
    paypal: Boolean(settings.paypal.clientId && settings.paypal.clientSecret),
    paypalEnvironment: settings.paypal.environment,
  };
}
