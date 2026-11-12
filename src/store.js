// Tiny JSON-file store for inbox state and the activity log (data/runtime/state.json).
import fs from 'node:fs';
import path from 'node:path';
import { settings, loadSampleInbox } from './config.js';

const FILE = path.join(settings.runtimeDir, 'state.json');

function fresh() {
  return {
    emails: loadSampleInbox().map((e) => ({ ...e, source: 'sample' })),
    threads: {},
    activity: [],
  };
}

let state = load();

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return fresh();
  }
}

function save() {
  fs.mkdirSync(settings.runtimeDir, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
}

export function reset() {
  state = fresh();
  save();
}

export function listEmails() {
  return state.emails.map((e) => ({ ...e, thread: state.threads[e.id] || null }));
}

export function getEmail(id) {
  const email = state.emails.find((e) => e.id === id);
  return email ? { ...email, thread: state.threads[id] || null } : null;
}

export function addEmail(email) {
  const id = `u${Date.now().toString(36)}`;
  const record = { id, received_at: new Date().toISOString(), to: 'ops@busybee-freight.example', source: 'pasted', ...email };
  state.emails.unshift(record);
  save();
  return record;
}

export function updateThread(id, patch) {
  state.threads[id] = { ...(state.threads[id] || {}), ...patch, updated_at: new Date().toISOString() };
  save();
  return state.threads[id];
}

export function logActivity(entry) {
  state.activity.unshift({ at: new Date().toISOString(), ...entry });
  state.activity = state.activity.slice(0, 200);
  save();
}

export function listActivity() {
  return state.activity;
}
