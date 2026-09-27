import { GoogleGenAI } from '@google/genai';
import { settingsStore } from '../config/settings-store.js';
import { env } from '../config/env.js';

export function getGenAI(): { ai: GoogleGenAI; textModel: string; imageModel: string; apiKey: string } {
  const apiKey = settingsStore.get('GEMINI_API_KEY') || env.GEMINI_API_KEY;
  const textModel = settingsStore.get('GEMINI_MODEL') || env.GEMINI_MODEL || 'gemini-2.0-flash';
  const imageModel = settingsStore.get('GEMINI_IMAGE_MODEL') || env.GEMINI_IMAGE_MODEL || 'imagen-3.0-generate-002';
  return { ai: new GoogleGenAI({ apiKey }), textModel, imageModel, apiKey };
}
