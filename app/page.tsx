"use client";

import { useEffect, useRef, useState } from "react";
import NextImage from "next/image";
import { medicines, type Medicine } from "./data/medicines";
import { additionalMedicines } from "./data/medibot-additional-medicines";
import MedicineReminders from "./components/MedicineReminders";

// Keep the user's existing dataset and append unique starter records only.
// Existing records win when a medicine name already exists.
let medicineCatalog: Medicine[] = [
  ...medicines,
  ...additionalMedicines.filter(
    (extra) => !medicines.some(
      (existing) => existing.name.trim().toLowerCase() === extra.name.trim().toLowerCase()
    )
  ),
];

/*
 * ================= Medicine matching helpers (pure logic, no UI) =================
 * Matching is deterministic and token-based — no fuzzy / edit-distance matching —
 * so a query can never accidentally match the wrong medicine.
 */

/**
 * Normalize free text into lowercase tokens.
 * - lowercases and trims the text
 * - treats punctuation (?, . , ; : - / etc.) as separators,
 *   so "What is Crocin 650?" and "Moxikind-CV 625" tokenize cleanly
 * - keeps dose decimals intact, e.g. "0.5mg"
 */
function normalizeTokens(text: string): string[] {
  return text
    .toLowerCase()
    .trim()
    .match(/[a-z0-9]+(?:\.[a-z0-9]+)*/g) ?? [];
}

/**
 * Conversational words that never identify a specific medicine.
 * Used only as a secondary matching pass; raw tokens are always tried first.
 */
const CONVERSATIONAL_WORDS = new Set([
  // grammar / small words
  "a", "an", "the", "and", "or", "but", "if", "then", "than", "too", "very",
  "of", "in", "on", "at", "to", "for", "from", "by", "with", "into", "onto",
  "over", "under", "between", "through", "until", "up", "out", "as", "so",
  "is", "are", "was", "were", "be", "been", "being", "am", "do", "does",
  "did", "has", "have", "had", "can", "could", "will", "would", "shall",
  "should", "may", "might", "must",
  // pronouns / politeness
  "i", "me", "my", "we", "our", "us", "you", "your", "he", "she", "him",
  "her", "his", "its", "it", "this", "that", "these", "those", "there",
  "here", "they", "them", "their", "what", "which", "who", "why", "when",
  "where", "how", "please", "hello", "hi", "thanks", "thank",
  // conversational filler
  "tell", "give", "show", "get", "find", "let", "know", "say", "speak",
  "about", "explain", "describe", "details", "detail", "info",
  "information", "mention", "asking", "ask", "want", "need", "looking",
  "something", "anything", "some", "any", "well", "just", "really",
  "actually", "also", "now", "ok", "okay", "right",
  "child", "children", "kid", "kids", "baby", "infant", "adult", "person",
  "people", "someone", "mild", "high", "low", "severe", "bad", "little",
  // medicine chatter that never identifies a specific product
  "medicine", "medicines", "medication", "medications", "drug", "drugs",
  "tablet", "tablets", "pill", "pills", "capsule", "capsules", "syrup",
  "composition", "contain", "contains", "containing", "content", "use",
  "uses", "used", "safe", "safety", "dose", "dosage", "fever", "pain",
]);

/** Remove conversational words so the medicine name can still be found. */
function withoutConversationalWords(tokens: string[]): string[] {
  return tokens.filter((token) => !CONVERSATIONAL_WORDS.has(token));
}

/** True when `phrase` appears in `tokens` as contiguous, whole tokens. */
function containsPhrase(tokens: string[], phrase: string[]): boolean {
  if (phrase.length === 0 || phrase.length > tokens.length) return false;

  for (let i = 0; i <= tokens.length - phrase.length; i++) {
    let matched = true;
    for (let j = 0; j < phrase.length; j++) {
      if (tokens[i + j] !== phrase[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

type MedicineSearchEntry = {
  medicine: Medicine;
  /** Full name as tokens, e.g. ["crocin", "650"] or ["augmentin", "625", "duo"] */
  fullName: string[];
  /** Leading brand word (before any strength token), e.g. "crocin", "augmentin" */
  brandSeed: string;
  /** Strength tokens of this medicine, e.g. ["650"] or ["0.5mg"] */
  strengths: string[];
};

/** Precomputed, exact-match index over the medicine list. */
function buildMedicineSearchIndex(list: Medicine[]): MedicineSearchEntry[] {
  return list.map((medicine) => {
    const nameTokens = normalizeTokens(medicine.name);
    const firstStrength = nameTokens.findIndex((token) => /^\d/.test(token));
    const brandTokens =
      firstStrength === -1 ? nameTokens : nameTokens.slice(0, firstStrength);

    return {
      medicine,
      fullName: nameTokens,
      brandSeed: brandTokens[0] ?? "",
      strengths: nameTokens.filter((token) => /^\d/.test(token)),
    };
  });
}

let medicineSearchIndex: MedicineSearchEntry[] = buildMedicineSearchIndex(medicineCatalog);

function rebuildMedicineSearchIndex(): void {
  medicineSearchIndex = buildMedicineSearchIndex(medicineCatalog);
}

/** Pick the candidate whose stated strength appears in the query, else the first. */
function preferStrengthMatch(
  candidates: MedicineSearchEntry[],
  queryTokens: string[]
): Medicine {
  const match = candidates.find((entry) =>
    entry.strengths.some((strength) => queryTokens.includes(strength))
  );
  return (match ?? candidates[0]).medicine;
}

/**
 * Find the medicine a user is asking about.
 * Tiers (most specific first, exact token matching only):
 *  1. full name in raw query          — "What is Crocin 650?"
 *  2. full name minus filler words    — "crocin of 650"
 *  3. brand word in raw query         — "What does Crocin contain?"
 *  4. brand word minus filler words   — "please tell me about crocin"
 * Returns undefined for unknown queries (safe fallback stays in handleSend).
 */
function findMedicine(rawQuery: string): Medicine | undefined {
  const queryTokens = normalizeTokens(rawQuery);
  const filteredTokens = withoutConversationalWords(queryTokens);
  const requestedForm = queryTokens.find((token) =>
    ["tablet", "tablets", "tab", "tabs", "capsule", "capsules", "syrup", "suspension", "injection", "solution", "drops", "cream", "ointment", "gel", "spray", "powder"].includes(token)
  );
  const formAliases: Record<string, string> = {
    tablets: "tablet", tab: "tablet", tabs: "tablet",
    capsules: "capsule", injections: "injection", drops: "drops",
  };
  const targetForm = requestedForm ? (formAliases[requestedForm] ?? requestedForm) : undefined;
  const hasRequestedForm = (entry: MedicineSearchEntry) => {
    if (!targetForm) return true;
    return entry.medicine.dosageForm.toLowerCase().replace(/s$/, "") === targetForm.replace(/s$/, "");
  };
  const mostSpecific = (matches: MedicineSearchEntry[]) =>
    matches.sort((a, b) => b.fullName.length - a.fullName.length)[0];

  const exactMatches = medicineSearchIndex.filter((entry) =>
    containsPhrase(queryTokens, entry.fullName) && hasRequestedForm(entry)
  );
  if (exactMatches.length) return mostSpecific(exactMatches).medicine;

  // If a form was explicitly named and no entry for that form exists, do not
  // silently fall back to a different formulation of the same brand.
  if (targetForm) return undefined;

  const exactFilteredMatches = medicineSearchIndex.filter((entry) =>
    containsPhrase(filteredTokens, entry.fullName)
  );
  if (exactFilteredMatches.length) return mostSpecific(exactFilteredMatches).medicine;

  const byBrand = medicineSearchIndex.filter(
    (entry) => entry.brandSeed !== "" && queryTokens.includes(entry.brandSeed)
  );
  // "fever" must not resolve to "Fever-X". Brand-seed matching is only for
  // queries that are not a bare health topic.
  if (byBrand.length > 0 && !isBareHealthTopicQuery(rawQuery)) {
    return preferStrengthMatch(byBrand, queryTokens);
  }

  const byBrandFiltered = medicineSearchIndex.filter(
    (entry) => entry.brandSeed !== "" && filteredTokens.includes(entry.brandSeed)
  );
  if (byBrandFiltered.length > 0 && !isBareHealthTopicQuery(rawQuery)) {
    return preferStrengthMatch(byBrandFiltered, queryTokens);
  }

  return undefined;
}

/**
 * Normalizes brand names for dataset joins, removing only dosage-form words
 * and dosage units. Strength numbers remain part of the key.
 */
function datasetNameKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/(\d+(?:\.\d+)?)\s*(?:mg|mcg|μg|g|gm|ml|iu)\b/gi, "$1")
    .replace(/\b(?:tablets?|tabs?|capsules?|caps?|syrup|suspension|injections?|solution|drops?|cream|ointment|gel|spray|powder)\b/gi, " ")
    .replace(/[^a-z0-9.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Add data-backed records and merge safe reference fields into known OTC entries. */
function upsertDatasetMedicines(records: Medicine[]): void {
  if (!records.length) return;
  const next = [...medicineCatalog];
  for (const record of records) {
    const key = datasetNameKey(record.name);
    if (!key) continue;
    const index = next.findIndex((item) =>
      datasetNameKey(item.name) === key &&
      item.dosageForm.toLowerCase() === record.dosageForm.toLowerCase()
    );
    if (index < 0 && record.schedule === "Unverified" && next.some(
      (item) => datasetNameKey(item.name) === key && item.dosageForm.toLowerCase() !== record.dosageForm.toLowerCase()
    )) {
      // Do not create a second, unclassified formulation under a name/strength
      // already covered by a curated product. A form-specific query will fail
      // closed instead of accidentally inheriting the other product's status.
      continue;
    }
    if (index >= 0) {
      const existing = next[index];
      // Never replace a curated Schedule H classification or expose more
      // metadata for that entry from an unclassified source dataset.
      if (existing.schedule === "Schedule H" || existing.schedule === "Unverified") continue;
      if (existing.schedule === "OTC" && record.schedule === "OTC") {
        next[index] = {
          ...existing,
          datasetPrice: record.datasetPrice ?? existing.datasetPrice,
          datasetComposition: record.datasetComposition ?? existing.datasetComposition,
          datasetType: record.datasetType ?? existing.datasetType,
          manufacturer: record.manufacturer ?? existing.manufacturer,
          packSize: record.packSize ?? existing.packSize,
          datasetSource: record.datasetSource ?? existing.datasetSource,
          datasetIntroduction: record.datasetIntroduction ?? existing.datasetIntroduction,
          datasetUses: record.datasetUses ?? existing.datasetUses,
          datasetBenefits: record.datasetBenefits ?? existing.datasetBenefits,
          datasetSideEffects: record.datasetSideEffects ?? existing.datasetSideEffects,
          datasetHowItWorks: record.datasetHowItWorks ?? existing.datasetHowItWorks,
          datasetQuickTips: record.datasetQuickTips ?? existing.datasetQuickTips,
          datasetSafetyPregnancy: record.datasetSafetyPregnancy ?? existing.datasetSafetyPregnancy,
          datasetSafetyBreastfeeding: record.datasetSafetyBreastfeeding ?? existing.datasetSafetyBreastfeeding,
          datasetSafetyKidney: record.datasetSafetyKidney ?? existing.datasetSafetyKidney,
          datasetSafetyLiver: record.datasetSafetyLiver ?? existing.datasetSafetyLiver,
        };
      }
      continue;
    }
    next.push(record);
  }
  medicineCatalog = next;
  rebuildMedicineSearchIndex();
}

/** Medicines named anywhere in a query, so a restricted product cannot be hidden behind another name. */
function findExplicitMedicineMentions(rawQuery: string): Medicine[] {
  const tokens = normalizeTokens(rawQuery);
  const filteredTokens = withoutConversationalWords(tokens);
  const hasStrength = tokens.some((token) => /^\d/.test(token));
  const found = medicineSearchIndex.filter((entry) => {
    if (containsPhrase(tokens, entry.fullName) || containsPhrase(filteredTokens, entry.fullName)) return true;
    return entry.brandSeed !== "" && tokens.includes(entry.brandSeed) &&
      (!hasStrength || entry.strengths.some((strength) => tokens.includes(strength))) &&
      !isBareHealthTopicQuery(rawQuery);
  });
  return [...new Map(found.map((entry) => [entry.medicine.name, entry.medicine])).values()];
}

/** The two medicine-name sides of a parsed comparison query. */
type ComparisonSides = { left: string; right: string };

/**
 * Detect a comparison query and split out its two sides.
 * Supports: "compare X and Y", "compare X with Y", "X vs Y", "X versus Y".
 * Uses exact word separators only — never fuzzy matching.
 */
function parseComparisonQuery(rawQuery: string): ComparisonSides | null {
  const query = rawQuery.toLowerCase().trim();

  // "crocin 650 vs dolo 650" / "crocin 650 versus dolo 650" / "x vs y vs z"
  const vsSplit = query.split(/\s+(?:vs\.?|versus)\s+/);
  if (vsSplit.length >= 2 && vsSplit[0].trim() !== "") {
    return {
      left: vsSplit[0].trim(),
      right: vsSplit.slice(1).join(" ").trim(),
    };
  }

  // "compare crocin 650 and dolo 650" / "compare allegra 120 with crocin 650"
  const compareMatch = query.match(
    /\bcompa\w*\s+(.+?)\s+(?:and|with)\s+(.+)$/
  );
  if (compareMatch) {
    const left = compareMatch[1].trim();
    const right = compareMatch[2].trim();
    if (left !== "" && right !== "") return { left, right };
  }

  return null;
}

/**
 * Count how many distinct medicines are explicitly mentioned in a piece of
 * text (same exact token matching as findMedicine). Used to keep comparisons
 * strict: each side must identify exactly one medicine.
 */
function countMedicineMentions(text: string): number {
  const tokens = normalizeTokens(text);
  const filteredTokens = withoutConversationalWords(tokens);
  const hasStrength = filteredTokens.some((token) => /^\d/.test(token));

  // Do not count every brand-strength variant when the user named one exact
  // strength (e.g. Crocin 650 must not also count Crocin 500 as a mention).
  return medicineSearchIndex.filter((entry) => {
    if (
      containsPhrase(tokens, entry.fullName) ||
      containsPhrase(filteredTokens, entry.fullName)
    ) return true;
    return !hasStrength && entry.brandSeed !== "" &&
      (tokens.includes(entry.brandSeed) || filteredTokens.includes(entry.brandSeed));
  }).length;
}

/** One side of a comparison: factual fields only, no recommendations. */
function describeMedicineForComparison(medicine: Medicine): string {
  const prescriptionStatus = medicine.schedule === "Schedule H"
    ? "Schedule H (prescription required)"
    : medicine.schedule === "OTC"
      ? "OTC (prototype catalog label; verify the pack and local requirements)"
      : "Unverified in supplied dataset — confirm with pharmacist/regulatory source";
  const composition = medicine.composition || medicine.datasetComposition || "Not listed";
  const referencePrice = medicine.datasetPrice != null
    ? `A–Z dataset reference price: ₹${medicine.datasetPrice} (not a live pharmacy quote)`
    : "A–Z dataset reference price: not available";
  return [
    `💊 ${medicine.name}`,
    `Composition listed: ${composition}${medicine.datasetComposition && !medicine.composition ? " (dataset-listed; not independently verified)" : ""}`,
    `Category: ${medicine.category || "Not listed"}`,
    `Product type: ${medicine.datasetType || "Not listed"}`,
    `Manufacturer: ${medicine.manufacturer || "Not listed"}`,
    `Pack size: ${medicine.packSize || "Not listed"}`,
    `MRP (curated catalog): ${medicine.mrp > 0 ? `₹${medicine.mrp}` : "Not verified"}`,
    referencePrice,
    `Prescription classification: ${prescriptionStatus}`,
  ].join("\n");
}

/**
 * Side-by-side factual comparison of two medicines. Never recommends one
 * medicine over another and never claims one is medically better.
 */
function formatComparison(left: Medicine, right: Medicine): string {
  return (
    `⚖️ Comparison: ${left.name} vs ${right.name}\n\n` +
    `${describeMedicineForComparison(left)}\n\n` +
    `${describeMedicineForComparison(right)}\n\n` +
    `This comparison is for general information only. Consult a qualified healthcare professional before choosing or switching medicines.`
  );
}

/** Detect a price/availability query using exact keywords (no fuzzy matching). */
function isPriceQuery(rawQuery: string): boolean {
  const query = rawQuery.toLowerCase().trim();
  return (
    query.includes("price") ||
    query.includes("cost") ||
    query.includes("cheapest") ||
    query.includes("how much") ||
    query.includes("mrp")
  );
}

/**
 * Build the DEMO price-comparison response for a medicine.
 * Pharmacies are sorted lowest → highest price, the lowest listed price is
 * highlighted, and the potential saving (highest − lowest) is calculated.
 * These are demo/sample prices only — never presented as live data.
 */
function formatPriceComparison(medicine: Medicine): string {
  const listed = [...medicine.priceComparison].sort((a, b) => a.price - b.price);
  const datasetFacts = [
    medicine.datasetPrice != null ? `A–Z dataset reference price: ₹${medicine.datasetPrice} (not a live pharmacy quote; verify the current pack price)` : "",
    medicine.datasetType ? `Product type (A–Z dataset): ${medicine.datasetType}` : "",
    medicine.manufacturer ? `Manufacturer (A–Z dataset): ${medicine.manufacturer}` : "",
    medicine.packSize ? `Pack size (A–Z dataset): ${medicine.packSize}` : "",
    medicine.datasetSource ? `Source: ${medicine.datasetSource}` : "",
  ].filter(Boolean).join("\n");

  if (medicine.schedule === "Unverified") {
    return (
      `💸 Catalogue price information for ${medicine.name}\n\n` +
      (datasetFacts || "No price or manufacturer details were available in the supplied dataset.") +
      `\n\nPrescription classification is unverified. This is catalogue reference data, not a live retail price or a purchase recommendation. Confirm the product and its classification with a qualified pharmacist before acting on it.`
    );
  }

  const demoNotice = "Demo/sample prices — not live pharmacy prices.";
  if (listed.length === 0) {
    return (
      `💸 No partner/demo pharmacy listings are available for ${medicine.name} right now.\n\n` +
      (datasetFacts ? `${datasetFacts}\n\n` : "") +
      demoNotice +
      `\n\nPlease check the current pack and consult a qualified healthcare professional before purchasing.`
    );
  }

  const lowest = listed[0];
  const highest = listed[listed.length - 1];
  const saving = Math.round((highest.price - lowest.price) * 100) / 100;
  const rows = listed.map((entry, index) => {
    const stock = entry.inStock ? "In stock (demo)" : "Out of stock (demo)";
    const lowestTag = index === 0 ? "  ✅ LOWEST LISTED" : "";
    return `• ${entry.platform} — ₹${entry.price} — ${stock} — Delivery: ${entry.delivery}${lowestTag}`;
  }).join("\n");
  return (
    `💸 Price comparison for ${medicine.name} (demo data)\n\n` +
    `${rows}\n\n` +
    `Lowest listed price: ₹${lowest.price} (${lowest.platform})\n` +
    `Potential saving within demo listings: ₹${saving}\n\n` +
    (datasetFacts ? `${datasetFacts}\n\n` : "") +
    `${demoNotice}\n\nPrice listings are informational only and are not a recommendation to take any medicine. Please consult a qualified healthcare professional before purchasing.`
  );
}

/** A single chat message kept in the conversation history. */
type ChatMessage = {
  id: number;
  role: "user" | "assistant";
  content: string;
  /** Local time the message was sent (epoch ms) — displayed under the bubble. */
  timestamp: number;
};

/* -------------------------------------------------------------------- */
/* Dashboard navigation — every item drives an EXISTING feature (no dead */
/* links): search / price / alternatives / compare / health populate the */
/* chat input with a working example query, evaluation scrolls to the    */
/* real dashboard, and Clear Chat calls the real clear handler.          */
/* -------------------------------------------------------------------- */

type NavItemId =
  | "home"
  | "search"
  | "price"
  | "savings"
  | "cabinet"
  | "reminders"
  | "alternatives"
  | "compare"
  | "health"
  | "evaluation"
  | "clear";

type IconName =
  | "home"
  | "search"
  | "tag"
  | "swap"
  | "columns"
  | "activity"
  | "chart"
  | "calculator"
  | "cabinet"
  | "bell"
  | "trash";

const NAV_ITEMS: { id: NavItemId; label: string; icon: IconName }[] = [
  { id: "home", label: "Home", icon: "home" },
  { id: "search", label: "Medicine Search", icon: "search" },
  { id: "price", label: "Price Comparison", icon: "tag" },
  { id: "savings", label: "Smart Savings", icon: "calculator" },
  { id: "cabinet", label: "My Medicine Cabinet", icon: "cabinet" },
  { id: "reminders", label: "Smart Reminders", icon: "bell" },
  { id: "alternatives", label: "Alternatives", icon: "swap" },
  { id: "compare", label: "Compare Medicines", icon: "columns" },
  { id: "health", label: "Health Assistant", icon: "activity" },
  { id: "evaluation", label: "Evaluation Dashboard", icon: "chart" },
  { id: "clear", label: "Clear Chat", icon: "trash" },
];

/** Example queries that exercise the corresponding existing features. */
const NAV_QUERIES: Partial<Record<NavItemId, string>> = {
  search: "What is Crocin 650?",
  price: "Price of Crocin 650",
  alternatives: "Cheaper alternative to Crocin 650",
  compare: "Compare Crocin 650 and Dolo 650",
  health: "What is fever?",
};

/** Quick-action chips shown above the message input (real, working queries). */
const QUICK_CHIPS: string[] = [
  "What is Crocin 650?",
  "Price of Crocin 650",
  "What is a headache?",
  "What is the common cold?",
  "What causes a cough?",
  "What is a prescription?",
  "What are medicine side effects?",
  "What is fever?",
  "What should I take for a cold?",
  "Tell me a joke",
];

/** Quick Actions card entries (right sidebar) — all real working queries. */
const QUICK_ACTIONS: { label: string; query: string; icon: IconName }[] = [
  { label: "Medicine information", query: "What is Crocin 650?", icon: "search" },
  { label: "Price comparison", query: "Price of Crocin 650", icon: "tag" },
  { label: "Safe alternatives", query: "Cheaper alternative to Crocin 650", icon: "swap" },
  { label: "Compare medicines", query: "Compare Crocin 650 and Dolo 650", icon: "columns" },
  { label: "Health education", query: "What is fever?", icon: "activity" },
];

/** Words that explicitly refer back to the conversation context. */
const CONTEXT_REFERENCE_WORDS = new Set([
  "it", "its", "this", "that", "these", "those", "same",
]);

/**
 * Words that describe an intent (price, alternatives, ...) rather than
 * naming a medicine. Used to tell context references ("its price") apart
 * from attempts to name a specific medicine ("what is paracetamol").
 */
const CONTEXT_INTENT_WORDS = new Set([
  "cheaper", "cheap", "cheapest", "alternative", "alternatives",
  "substitute", "substitutes", "instead", "price", "prices", "pricing",
  "cost", "costs", "costing", "expensive", "much", "many", "compare",
  "comparison", "comparisons", "versus", "available", "availability",
  "stock", "buy", "order", "mrp", "rate", "rates", "offer", "offers",
  "discount", "discounts", "generic", "review", "reviews", "work",
  "works", "working", "side", "effect", "effects",
]);

/**
 * Decide whether a query with no direct medicine match should fall back to
 * the most recently discussed medicine.
 * - explicit references ("it", "its price", "this medicine", "what about")
 *   use context whenever a previous medicine exists
 * - otherwise context is only used when the message contains NO word that
 *   could name a medicine, so unknown names still get the safe response
 */
function shouldUseContext(rawQuery: string): boolean {
  const query = rawQuery.toLowerCase().trim();
  const tokens = normalizeTokens(query);
  if (tokens.length === 0) return false;

  if (tokens.some((token) => CONTEXT_REFERENCE_WORDS.has(token))) {
    return true;
  }

  if (query.includes("what about") || query.includes("how about")) {
    return true;
  }

  const hasIntent = tokens.some((token) => CONTEXT_INTENT_WORDS.has(token));
  if (!hasIntent) return false;

  const possibleName = tokens.filter(
    (token) =>
      !CONVERSATIONAL_WORDS.has(token) &&
      !CONTEXT_INTENT_WORDS.has(token) &&
      !CONTEXT_REFERENCE_WORDS.has(token)
  );
  return possibleName.length === 0;
}

/* ------------- Safe general health assistant (controlled set) ------------- */

/** Short safety reminder appended to every educational health answer. */
const HEALTH_SAFETY_REMINDER =
  "For personalized medical advice, please consult a qualified healthcare professional.";

/** Safe reply when a user describes potentially serious symptoms. */
const SERIOUS_SYMPTOMS_RESPONSE =
  "Some symptoms can be serious, and I can't assess or diagnose symptoms here. Please seek appropriate professional medical care — contact a qualified healthcare professional or local emergency services promptly.";

/** Safe reply when a user asks which medicine or treatment to use. */
const TREATMENT_REQUEST_RESPONSE =
  "I can provide general health information, but I can't recommend a specific medicine or diagnose your condition. The appropriate treatment depends on factors such as your age, symptoms, medical history, and other medicines you take. Please consult a qualified healthcare professional or pharmacist for advice.";

/** Query fragments that ask for a diagnosis, prescription, dosage, or personal treatment advice. */
const PERSONALIZED_REQUEST_PATTERNS = [
  "what medicine should",
  "which medicine should",
  "what medicine can",
  "which medicine can",
  "what medicine is best",
  "best medicine for",
  "best tablet for",
  "which medicine for",
  "what medicine for",
  "what should i take",
  "what can i take",
  "what can i use for",
  "what should i use for",
  "what can i take for",
  "which tablet should",
  "what tablet should",
  "what drug should",
  "which drug should",
  "should i take",
  "can i take",
  "is it safe for me to take",
  "can i use this medicine",
  "which one should i take",
  "do i have",
  "am i having",
  "diagnose",
  "what disease do i have",
  "what illness do i have",
  "prescrib",
  "recommend a medicine",
  "recommend me a medicine",
  "recommend any medicine",
  "suggest a medicine",
  "suggest me a medicine",
  "what prescription should",
  "dosage of",
  "dose of",
  "how many mg should",
  "how much mg should",
  "how many tablets should",
  "how many days should",
  "should i start",
  "should i stop",
  "stop taking",
  "start taking",
  "change my medicine",
  "switch my medicine",
  "my treatment plan",
  "treatment plan for me",
  "treat my",
  "cure my",
];

/** Query fragments describing potentially serious symptoms. */
const SERIOUS_SYMPTOM_PATTERNS = [
  "chest pain",
  "difficulty breathing",
  "shortness of breath",
  "can't breathe",
  "cannot breathe",
  "blue lips",
  "swelling of tongue",
  "swelling of lips",
  "face drooping",
  "slurred speech",
  "new weakness on one side",
  "sudden severe headache",
  "worst headache",
  "headache with weakness",
  "headache with confusion",
  "fever with stiff neck",
  "stiff neck and fever",
  "severe abdominal pain",
  "blood in vomit",
  "vomiting blood",
  "coughing blood",
  "coughing up blood",
  "blood in stool",
  "unable to keep fluids down",
  "can't keep fluids down",
  "unconscious",
  "seizure",
  "severe bleeding",
  "bleeding heavily",
  "heavy bleeding",
  "overdose",
  "poisoning",
  "suicid",
  "anaphylaxis",
  "stroke",
];

/**
 * Detect intent priority 2: a request for a diagnosis, treatment, or
 * medicine recommendation — "Which medicine should I take for fever?",
 * "What medicine is used for fever?", "I have fever, recommend a tablet.".
 * Exact keyword and regex matching only (never fuzzy matching), so pure
 * education questions ("What is fever?") and named-medicine questions
 * ("What is Crocin 650?", "What is Crocin 650 used for?") are never
 * misclassified as treatment requests.
 * Never used to recommend a drug, dose, or personalized treatment.
 */
function isTreatmentRequest(rawQuery: string): boolean {
  const query = rawQuery.toLowerCase().trim();
  if (query === "") return false;

  // Diagnosis, prescription, dosage, and personal-advice fragments
  // ("which medicine should", "what can i take", "suggest a medicine", ...).
  if (PERSONALIZED_REQUEST_PATTERNS.some((pattern) => query.includes(pattern))) {
    return true;
  }

  // Recommendation verbs: "recommend a tablet", "suggest a medicine",
  // "prescribe something", "what do you recommend for fever?".
  if (/\b(?:recommend|suggest|prescrib)\w*/.test(query)) return true;

  // Question word + medicine word + request wording:
  // "what medicine is used for fever", "which tablets should i take",
  // "what medicine is available for a cold".
  if (
    /\b(?:what|which)\b(?:\s+\w+){0,4}\s+(?:medicines?|medications?|drugs?|tablets?|pills?|capsules?|syrups?|treatments?|remedies|remedy)\b(?:\s+\w+){0,2}\s+(?:should|can|could|take|taken|use|used|using|for|need|needs|treat|treats|treated|cure|cures|help|helps|available|recommend|suggest)\b/.test(query)
  ) {
    return true;
  }

  // "what/which ... should/can i take|use" — "what do i take for a cold",
  // "what should my child take for a headache".
  if (
    /\b(?:what|which)\b(?:\s+\w+){0,4}\s+(?:should|can|could|would|do|does)?\s*\b(?:i|we|my\s+\w+|our\s+\w+)\b\s+(?:take|use|consume|eat)\b/.test(query)
  ) {
    return true;
  }

  // "what to take for fever", "which tablet to use for a cold".
  if (
    /\b(?:what|which)\b(?:\s+\w+){0,2}\s+to\s+(?:take|use|consume)\b/.test(query)
  ) {
    return true;
  }

  // Symptom-directed wording without a question: "medicine for fever",
  // "tablet for my headache", "best treatment for a cold".
  if (
    /\b(?:medicines?|medications?|drugs?|tablets?|pills?|capsules?|syrups?|treatments?|remedies|remedy)\b(?:\s+\w+){0,2}\s+for\s+/.test(query)
  ) {
    return true;
  }

  return false;
}

/**
 * Controlled set of general-health educational topics, matched by keywords.
 * More specific topics are checked first. Returns null when the query is not
 * a supported topic. Text is educational only: no diagnosis, no prescription,
 * no medicine recommendation, and no dosage advice.
 */
function getHealthTopicResponse(query: string): string | null {
  const has = (...terms: string[]) => terms.some((term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped.replace(/\s+/g, "\\s+")}\\b`, "i").test(query);
  });

  // Medication literacy and prescription safety.
  if (has("prescription", "prescriptions", "prescription medicine", "prescription drug")) {
    return "A prescription is an instruction from an authorized healthcare professional for a specific medicine or treatment. It may state the medicine name, strength, directions, and duration. Never use another person's prescription or change a prescribed plan on your own. If the directions are unclear, ask the prescriber or pharmacist to explain them.";
  }
  if (has("side effect", "side effects", "adverse effect", "adverse reaction")) {
    return "A side effect is an unwanted or unintended effect that can occur with a medicine. The type and seriousness vary by medicine and person. Read the patient leaflet and tell your clinician or pharmacist about symptoms and all medicines or supplements you use. Breathing difficulty or swelling of the lips or tongue can be an emergency.";
  }
  if (has("drug interaction", "drug interactions", "medicine interaction", "medicine interactions", "food interaction", "interactions")) {
    return "An interaction can happen when one medicine affects another medicine, food, alcohol, or a supplement. Before starting something new, give your doctor or pharmacist a complete list of medicines and supplements you use. Do not change doses or stop a prescribed medicine based only on a chatbot response.";
  }
  if (has("missed dose", "forgot my medicine", "forgot to take my medicine", "missed a dose")) {
    return "What to do after a missed dose depends on the exact medicine and its instructions. Check the patient leaflet or ask your pharmacist or prescriber. Do not take a double dose unless the official instructions for that medicine specifically tell you to.";
  }
  if (has("expired medicine", "expired medication", "medicine expiry", "expiry date", "expiration date")) {
    return "Do not rely on a medicine after its expiry date; its quality or effectiveness may no longer be assured. Ask a pharmacist about safe disposal and replacement. Keep medicines in their original packaging so the label and expiry details remain available.";
  }
  if (has("store medicine", "storing medicine", "medicine storage", "store medicines", "keep medicines")) {
    return "Follow the storage instructions on the medicine's label or leaflet. Keep medicines in their original packaging, away from children and pets, and protected from heat, moisture, and direct sunlight unless the label says otherwise. Some products need special storage, so check with a pharmacist if unsure.";
  }
  if (has("generic medicine", "generic medicines", "generic drug", "brand name medicine", "generic vs brand", "brand vs generic")) {
    return "A brand-name medicine is sold under a manufacturer's brand, while a generic medicine is identified by its active ingredient(s). Whether two products can be substituted depends on matching ingredients, strength, formulation, and applicable regulatory requirements. Confirm a proposed switch with a pharmacist or prescriber; a similar name alone does not prove equivalence.";
  }
  if (has("read a medicine label", "medicine label", "drug label", "medicine instructions")) {
    return "A medicine label commonly shows the product name, active ingredients, strength, dosage form, pack size, expiry, storage directions, and warnings. Prescription labels may also include patient-specific directions. If any instruction is missing or unclear, ask a pharmacist rather than guessing.";
  }
  if (has("otc", "over the counter", "over-the-counter medicine")) {
    return "OTC means 'over the counter' and generally refers to medicines that can be obtained without a prescription under local rules. OTC does not mean risk-free: labels, age limits, existing conditions, pregnancy, and interactions still matter. Ask a pharmacist if you are unsure whether a product is appropriate.";
  }
  if (has("pregnancy and medicine", "medicine during pregnancy", "medicines during pregnancy", "breastfeeding and medicine", "medicine while breastfeeding")) {
    return "Medicine choices during pregnancy or breastfeeding need individualized advice. Do not start, stop, or switch a medicine based only on general online information. Contact your doctor or pharmacist and tell them about all prescription medicines, OTC products, and supplements you use.";
  }
  if (has("antibiotic resistance", "bacteria resistance", "resistant bacteria") || (has("antibiotic", "antibiotics") && has("resistance", "resistant"))) {
    return "Antibiotic resistance happens when bacteria change so that antibiotics become less effective. Antibiotics do not treat viral illnesses such as most common colds. Use antibiotics only as directed by a qualified prescriber, and ask them or a pharmacist if you have questions about your course.";
  }
  if (has("antibiotic", "antibiotics")) {
    return "Antibiotics treat certain bacterial infections; they do not work against viruses such as those that cause most common colds and flu. The right treatment depends on the condition and clinical assessment. Do not use leftover antibiotics or someone else's prescription.";
  }
  if (has("antihistamine", "antihistamines")) {
    return "Antihistamines block the effects of histamine and are used for some allergy symptoms. Different products can have different side effects and warnings, including drowsiness for some types. A pharmacist or clinician can help determine whether a particular product is suitable for you.";
  }
  if ((has("painkiller", "pain killer", "pain reliever", "pain relief") && has("antihistamine"))) {
    return "Pain relievers are intended to reduce pain, while antihistamines block histamine and are used for some allergy symptoms. They have different purposes and risks. Ask a pharmacist or clinician before combining medicines or choosing one for your situation.";
  }

  // Common respiratory conditions.
  if (has("common cold", "cold", "runny nose", "stuffy nose", "blocked nose", "nasal congestion", "sneezing")) {
    return "The common cold is a viral infection of the upper respiratory tract. It can cause a runny or blocked nose, sneezing, sore throat, cough, and sometimes a mild fever. Rest, fluids, and avoiding smoke may help you feel more comfortable; antibiotics do not treat a viral cold. Seek medical advice for trouble breathing, chest pain, dehydration, a high or persistent fever, symptoms that worsen, or symptoms that do not improve as expected.";
  }
  if (has("flu", "influenza")) {
    return "Influenza (the flu) is a viral respiratory illness that can cause fever or chills, cough, sore throat, body aches, headache, and fatigue. Symptoms can overlap with a cold and other illnesses, so a chatbot cannot confirm the cause. People at higher risk or with severe symptoms should contact a healthcare professional promptly.";
  }
  if (has("cough", "dry cough", "wet cough", "phlegm")) {
    return "A cough is a reflex that helps clear the airways. It can occur with colds, allergies, irritation, or other conditions, so the cause cannot be determined from this symptom alone. Fluids and avoiding smoke or other irritants may help. Seek urgent care for difficulty breathing, coughing blood, or chest pain; contact a clinician if the cough is severe, worsening, or persistent.";
  }
  if (has("sore throat", "throat pain", "scratchy throat")) {
    return "A sore throat can occur with a viral infection, irritation, allergies, or other causes. Fluids and avoiding smoke may help with comfort. Seek medical advice for trouble swallowing or breathing, dehydration, a high or persistent fever, a rash, or symptoms that worsen or do not improve.";
  }
  if (has("allergy", "allergies", "allergic rhinitis", "hay fever", "itchy eyes")) {
    return "Allergies are immune responses to substances such as pollen, dust mites, foods, or animal dander. Symptoms vary and may include sneezing, itching, watery eyes, or a runny nose. Reducing exposure to a suspected trigger may help, but this does not identify the cause. Swelling of the lips or tongue, or trouble breathing, requires emergency care.";
  }
  if (has("headache", "headaches", "migraine", "migraines")) {
    return "A headache is pain in the head or upper neck and can have many causes, such as stress, dehydration, sleep changes, eyestrain, infection, or migraine. Rest, drinking water, and taking screen breaks may help some mild headaches, but they do not replace an assessment when needed. Seek emergency care for a sudden or unusually severe headache, new weakness, confusion, speech or vision changes, a headache after a head injury, or fever with a stiff neck. Get medical advice for frequent, worsening, or persistent headaches.";
  }
  if (has("fever", "high temperature", "raised temperature")) {
    return "Fever is a temporary increase in body temperature and may occur with infections or other conditions. The symptom alone does not reveal the cause. Rest and fluids may help with comfort. Seek medical advice for a high, persistent, or recurring fever, and promptly for fever with confusion, breathing difficulty, a stiff neck, severe dehydration, or in a very young infant.";
  }

  // Digestive concerns.
  if (has("diarrhea", "diarrhoea", "loose stools", "loose motion")) {
    return "Diarrhea means passing loose or watery stools more often than usual. It can have many causes. Replacing fluids is important to reduce dehydration risk. Seek medical advice for blood or black stool, severe abdominal pain, high fever, signs of dehydration, or symptoms that persist; extra care is needed for babies, older adults, and people with serious health conditions.";
  }
  if (has("vomiting", "throwing up", "nausea", "feeling sick", "upset stomach")) {
    return "Nausea is the feeling that you may vomit; vomiting is bringing stomach contents up. They can have many causes and do not identify a particular illness by themselves. Small, frequent sips of fluid may be easier to tolerate. Seek urgent care for blood or green vomit, severe pain, confusion, fainting, or inability to keep fluids down, and get medical advice if it continues.";
  }
  if (has("constipation", "constipated", "hard stools")) {
    return "Constipation usually means bowel movements are less frequent than usual or stools are hard and difficult to pass. Fluid intake, movement, and dietary fibre can be relevant for many people, but the right approach depends on the cause and a person's health. Seek medical advice for severe or persistent symptoms, blood in stool, vomiting, or significant abdominal pain.";
  }
  if (has("stomach ache", "stomachache", "stomach pain", "abdominal pain", "belly pain")) {
    return "Stomach or abdominal pain can come from many different causes, from temporary digestive upset to conditions needing treatment. The location, severity, duration, and associated symptoms matter, so MediBot cannot diagnose it. Seek urgent care for severe or sudden pain, a rigid or swollen abdomen, fainting, blood in vomit or stool, or pain with chest pain or breathing difficulty.";
  }
  if (has("acidity", "heartburn", "acid reflux", "indigestion", "bloating", "gas")) {
    return "Heartburn and indigestion can cause burning or discomfort in the upper abdomen or chest, bloating, or a sour taste, but similar symptoms may have other causes. Smaller meals and avoiding personal trigger foods may help some people. New or severe chest pain, sweating, breathlessness, or pain spreading to the arm or jaw needs emergency assessment. Talk with a clinician if symptoms recur or persist.";
  }

  // Muscles, joints, teeth, skin, sleep, and other common concerns.
  if (has("back pain", "backache", "muscle pain", "muscle ache", "body ache", "body aches", "joint pain", "sore muscles")) {
    return "Muscle, joint, or back pain may follow strain or have other causes. Gentle movement within comfort and avoiding activities that clearly worsen pain may help some minor strains. Seek urgent assessment for new weakness, numbness around the groin, loss of bladder or bowel control, severe pain after an injury, or pain with fever. Arrange medical review if pain is persistent or worsening.";
  }
  if (has("toothache", "tooth pain", "dental pain")) {
    return "Tooth pain can be caused by tooth decay, gum problems, injury, or infection, and the cause usually needs a dental assessment. Arrange a dentist visit, especially if the pain persists or there is swelling or fever. Facial or neck swelling with trouble swallowing or breathing needs emergency care.";
  }
  if (has("earache", "ear pain")) {
    return "Ear pain can have several causes, including infection, wax buildup, or pain referred from nearby areas. Avoid putting objects or unprescribed drops into the ear. Seek medical advice for persistent or severe pain, discharge, hearing changes, high fever, or swelling around the ear.";
  }
  if (has("rash", "skin rash", "itchy skin", "itching", "hives")) {
    return "A rash or itchy skin can be caused by irritation, allergy, infection, or other conditions; appearance alone is not enough to diagnose it. Avoid scratching and stop exposure to a suspected irritant when safe to do so. Get medical advice for a spreading, painful, infected-looking, or persistent rash. Rash with breathing difficulty or swelling of the lips/tongue is an emergency.";
  }
  if (has("dizziness", "dizzy", "lightheaded", "light headed")) {
    return "Dizziness can mean spinning, unsteadiness, or feeling faint, and it has many possible causes. Sit or lie down somewhere safe if you feel faint and avoid driving while dizzy. Seek urgent help if dizziness occurs with chest pain, severe headache, fainting, weakness, confusion, or trouble speaking or walking. Get medical advice if it persists or recurs.";
  }
  if (has("fatigue", "tired all the time", "tiredness", "weakness", "low energy")) {
    return "Fatigue or low energy can be associated with sleep, stress, infection, medication effects, or other health conditions. Regular rest and routine hydration may be helpful, but persistent or unexplained fatigue deserves a healthcare assessment. Seek urgent care if weakness is sudden or accompanied by chest pain, trouble breathing, confusion, or fainting.";
  }
  if (has("insomnia", "can't sleep", "cannot sleep", "sleep problem", "sleep problems")) {
    return "Insomnia means difficulty falling asleep, staying asleep, or getting restorative sleep. A consistent sleep/wake schedule, a calm wind-down routine, and reducing late caffeine or bright screens may help some people. If sleep problems persist, affect daytime functioning, or accompany significant mood changes, consult a healthcare professional. Avoid starting sleep medicines without professional guidance.";
  }
  if (has("menstrual cramps", "period pain", "period cramps", "painful periods")) {
    return "Menstrual cramps are lower-abdominal cramps that can occur before or during a period. Patterns and severity vary. Heat and rest may help some people, but new, unusually severe, or worsening pain, fainting, very heavy bleeding, or possible pregnancy merits prompt medical advice. A clinician can discuss suitable options for your situation.";
  }
  if (has("high blood pressure", "hypertension", "blood pressure")) {
    return "Blood pressure is the force of blood against artery walls. A single reading may not establish a diagnosis; measurements, context, and repeat checks matter. Follow your clinician's monitoring plan and do not start, stop, or adjust blood-pressure medicine based on a chatbot response. Seek urgent care for a very concerning reading with chest pain, trouble breathing, severe headache, confusion, or weakness.";
  }
  if (has("diabetes", "blood sugar", "high blood sugar", "low blood sugar")) {
    return "Diabetes is a condition involving blood-glucose regulation. Symptoms and management vary, and diagnosis requires appropriate testing by a healthcare professional. Follow the personal care plan provided by your clinician; MediBot cannot recommend insulin or medicine adjustments. Severe confusion, unconsciousness, or other emergency symptoms need urgent help.";
  }

  // Core health concepts.
  if (has("dehydration")) {
    return "Dehydration occurs when the body loses more fluid than it takes in. Signs can include thirst, dry mouth, dark or reduced urine, dizziness, and tiredness. Severe drowsiness, confusion, fainting, or inability to keep fluids down requires urgent medical attention.";
  }
  if (has("hydration")) {
    return "Hydration means having enough fluid for the body to work normally. Fluid needs vary with age, activity, weather, and health conditions. Follow any fluid limits given by your clinician if you have a condition that affects how much you should drink.";
  }
  if (has("active ingredient", "active ingredients")) {
    return "An active ingredient is the component of a medicine intended to produce its medicinal effect. Different brands may share an active ingredient, but a safe substitution also depends on matching strength, dosage form, formulation, and other product-specific details. Ask a pharmacist to confirm equivalence before switching.";
  }

  return null;
}

/**
 * Answer a small, controlled set of general health / medication education
 * questions using keyword matching (no API, no LLM).
 * Returns a safe educational response, or null when the query is not a
 * supported general-health question (caller falls back to the safe
 * unknown-medicine response).
 * Never diagnoses, prescribes, recommends a medicine or dosage, or tells
 * the user which medicine is medically better.
 */
function getHealthResponse(rawQuery: string): string | null {
  const query = rawQuery.toLowerCase().trim();
  if (query === "") return null;

  // Potentially serious symptoms → advise professional care instead of answering.
  if (SERIOUS_SYMPTOM_PATTERNS.some((pattern) => query.includes(pattern))) {
    return SERIOUS_SYMPTOMS_RESPONSE;
  }

  // No diagnosis, prescription, drug choice, or personalized dose advice.
  if (isTreatmentRequest(query) || PERSONALIZED_REQUEST_PATTERNS.some((pattern) => query.includes(pattern))) {
    return TREATMENT_REQUEST_RESPONSE;
  }

  const topic = getHealthTopicResponse(query);
  if (topic === null) return null;

  return topic + "\n\n" + HEALTH_SAFETY_REMINDER;
}

/* ------------- Verified active-composition alternative matching ------------- */

/** Order-insensitive comparison of two active ingredient lists (exact strings). */
function sameActiveIngredients(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

/**
 * Verified active-composition matching.
 * The alternatives array holds CANDIDATES only. A candidate is accepted when:
 *  1. the base medicine and the candidate are both compositionVerified === true
 *  2. their active ingredient lists are identical
 *  3. their strengths are identical
 *  4. their dosage forms are identical
 * A candidate that is not present in the medicine database can never be
 * verified and is dropped. Similar names or categories are never matched.
 */
function findVerifiedAlternatives(medicine: Medicine): Medicine[] {
  // Suggestions require a verified OTC base medicine; dataset-only records do
  // not qualify until composition, strength, dosage form and classification are verified.
  if (medicine.schedule !== "OTC" || !medicine.compositionVerified) return [];

  const verified: Medicine[] = [];
  for (const candidateName of medicine.alternatives) {
    const candidate = medicineCatalog.find((med) => med.name === candidateName);
    if (!candidate || candidate.schedule !== "OTC" || !candidate.compositionVerified) continue;
    if (
      !sameActiveIngredients(candidate.activeIngredients, medicine.activeIngredients)
    )
      continue;
    if (candidate.strength !== medicine.strength) continue;
    if (candidate.dosageForm !== medicine.dosageForm) continue;
    verified.push(candidate);
  }
  return verified;
}

/**
 * Build the alternatives response for a medicine: only verified
 * composition-equivalent alternatives are listed; otherwise the standard
 * not-found message is returned. No therapeutic recommendation is made.
 */
function formatVerifiedAlternatives(medicine: Medicine): string {
  if (medicine.schedule !== "OTC" || !medicine.compositionVerified) {
    return "MediBot cannot suggest an alternative for this entry because its prescription classification and composition equivalence are not verified. Dataset-listed substitutes are not proof of equivalent ingredients, strength or dosage form. Please confirm with a qualified pharmacist or doctor.";
  }
  const verified = findVerifiedAlternatives(medicine);

  if (verified.length === 0) {
    return "No composition-equivalent alternative was found in the verified database.";
  }

  const blocks = verified
    .map(
      (alt) =>
        `${alt.name}\n` +
        `Active ingredient: ${alt.activeIngredients.join(" + ")}\n` +
        `Strength: ${alt.strength}\n` +
        `Dosage form: ${alt.dosageForm}\n` +
        `✓ Composition verified`
    )
    .join("\n\n");

  return (
    `Composition-equivalent alternatives found:\n\n` +
    `${blocks}\n\n` +
    `These alternatives have matching active ingredients, strength, and dosage form in the MediBot database. Consult a doctor or pharmacist before switching medicines.`
  );
}

/**
 * Basic conversational replies. Only exact short phrases are handled here,
 * so a query like "Hi, what is Crocin 650?" still reaches medicine/safety logic.
 */
function getSmallTalkReply(rawQuery: string): string | null {
  const query = rawQuery
    .toLowerCase()
    .trim()
    .replace(/[.!?]+$/g, "")
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const oneOf = (...phrases: string[]) => phrases.includes(query);

  if (oneOf("hi", "hello", "hey", "hiya", "namaste", "good morning", "good afternoon", "good evening")) {
    return "Hello! I'm MediBot, your health information companion by Team DOOMSDAY. You can ask about common health topics, medicine information in the dataset, demo price comparisons, or prescription safety. I don't diagnose or prescribe. What would you like to know?";
  }
  if (oneOf("how are you", "how are you doing", "how is it going", "hows it going", "whats up", "what is up", "how are things")) {
    return "I'm doing well and ready to help! I'm a software assistant, so I don't have feelings like a person, but I'm here to answer your questions clearly and safely.";
  }
  if (oneOf("thanks", "thank you", "thanks a lot", "thank you so much", "thx", "thanks bro", "thank you medibot")) {
    return "You're welcome! Happy to help. Remember, I provide general information only and can't diagnose or prescribe medicine.";
  }
  if (oneOf("bye", "goodbye", "see you", "see you later", "talk to you later", "good night", "take care")) {
    return "Goodbye! Take care of yourself. If a health concern is serious or worsening, contact a qualified healthcare professional.";
  }
  if (oneOf("who are you", "what is medibot", "what is your name", "whats your name", "are you a doctor", "are you human", "are you an ai", "are you ai", "are you a robot")) {
    if (query === "are you a doctor") return "No. I'm not a doctor. I'm an informational assistant and can't diagnose conditions, prescribe medicines, or replace professional medical advice.";
    if (query === "are you human" || query === "are you an ai" || query === "are you ai" || query === "are you a robot") return "I'm an AI-powered software assistant, not a human or healthcare professional. I can provide general information, but important medical decisions should be discussed with a qualified professional.";
    return "I'm MediBot, an informational pharmacy and health companion built by Team DOOMSDAY. I can explain general health topics, look up dataset records, compare demo prices, and check restricted-medicine safety rules. I do not diagnose or prescribe.";
  }
  if (oneOf("who made you", "who created you", "who built you", "who developed you", "who is your team", "tell me about your team", "what is team doomsday")) {
    return "MediBot is the health-assistant project by Team DOOMSDAY: Nikunj Garg (Roll No. 260102236), Tejas Damkondwar (Roll No. 260106069), and Dhruv Choudhary (Roll No. 260106023). It is a prototype for informational support, not a replacement for clinical care.";
  }
  if (oneOf("what can you do", "how can you help", "how can you help me", "how can you help me today", "how can you help me with medicine", "what can you help me with", "how do you help me", "what do you do", "help", "help me get started", "what can i ask you", "what topics can you answer")) {
    return "I can explain common health topics such as headaches, colds, coughs, allergies, fever, and digestive concerns; answer general medicine-safety questions; look up medicine information from available datasets; compare demo prices; and show verified alternatives when strict checks pass. I can't diagnose, select a medicine for you, or give personal dosage instructions. Try: 'What is a headache?', 'What is a prescription?', or 'What is Crocin 650?'";
  }
  if (oneOf("can you diagnose me", "can you prescribe medicine", "can you give me a prescription", "can you tell me what medicine to take", "can you recommend a tablet")) {
    return "I can't diagnose you or issue a prescription, and I don't recommend a specific medicine or dose. I can explain general information and help you prepare questions for a doctor or pharmacist.";
  }
  if (oneOf("can i trust you", "is your information always correct", "are you always right", "is this medical advice", "can i rely on this")) {
    return "Please treat MediBot as an informational prototype, not a source of definitive medical advice. Dataset records can be incomplete or outdated, and I can make mistakes. Verify medicine details with the actual label, a pharmacist, or a qualified healthcare professional.";
  }
  if (oneOf("tell me a joke", "make me laugh", "say something funny", "tell me something funny")) {
    return "Here's a clean one: Why did the computer go to the doctor? It had a virus! 🙂 Now, what health or medicine question can I help you explore?";
  }
  if (oneOf("i am fine", "im fine", "i am good", "im good", "doing well", "i am okay", "im okay", "i'm okay", "all good")) {
    return "Glad to hear that! What would you like to explore today—a common health question, medicine information, or a demo price comparison?";
  }
  if (oneOf("i am worried", "im worried", "i feel worried", "i am scared", "im scared", "i feel anxious", "i am stressed", "im stressed")) {
    return "I'm sorry you're feeling worried. It can help to talk with someone you trust. If this is about a health symptom or medicine, I can share general information, but a qualified professional is best for personal advice. If you feel in immediate danger, contact local emergency services or someone nearby who can help.";
  }
  if (oneOf("explain simply", "use simple words", "explain in simple words", "make it simpler", "i don't understand", "i dont understand", "can you simplify", "please explain simply")) {
    return "Of course. I'll try to use simple words and short explanations. Tell me which part you'd like me to explain.";
  }
  if (oneOf("ok", "okay", "got it", "understood", "cool", "nice", "great", "good job", "you are helpful", "you're helpful")) {
    return "Great! Feel free to ask another question. I'll keep the answers simple and distinguish general information from personal medical advice.";
  }
  if (oneOf("what are your limitations", "what can you not do", "what are you unable to do")) {
    return "I can't diagnose, prescribe, choose a medicine or dosage for you, verify every dataset entry, or guarantee that reference prices are current. I can provide general education and help you identify questions to ask a healthcare professional.";
  }
  return null;
}

/**
 * Compute the assistant reply for a query — the single source of truth used
 * by BOTH the live chat (handleSend) and the automated evaluation panel, so
 * evaluation tests exercise the exact same logic as MediBot itself.
 * Returns the reply text plus the medicine to remember for the next turn.
 */
/**
 * Recognize short, standalone definitions of health concepts before the broad
 * brand-seed search runs. This prevents a word such as "fever" in an everyday
 * question from accidentally matching a medicine whose name starts with it.
 * Named products with a strength or dosage form do not match this rule.
 */
function isPureGeneralHealthDefinitionQuery(rawQuery: string): boolean {
  const query = rawQuery
    .toLowerCase()
    .trim()
    .replace(/[?.!,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // If a full known product name is present, let the medicine safety rules run first.
  const tokens = normalizeTokens(query);
  const explicitlyNamesProduct = medicineSearchIndex.some((entry) =>
    containsPhrase(tokens, entry.fullName)
  );
  if (explicitlyNamesProduct) return false;

  // Medicine-shopping or individualized treatment requests use their own safe route.
  if (isTreatmentRequest(query) || /\b(price|cost|mrp|manufacturer|cheapest|alternative|alternatives|substitute|substitutes|compare|dosage|dose|how many tablets|how much mg)\b/i.test(query)) {
    return false;
  }

  const topics = [
    "fever", "high temperature", "dehydration", "hydration", "headache", "headaches", "migraine", "migraines",
    "common cold", "cold", "flu", "influenza", "cough", "dry cough", "wet cough", "sore throat", "throat pain",
    "runny nose", "stuffy nose", "blocked nose", "nasal congestion", "sneezing", "allergy", "allergies", "hay fever",
    "diarrhea", "diarrhoea", "loose stools", "constipation", "nausea", "vomiting", "throwing up", "stomach ache",
    "stomachache", "stomach pain", "abdominal pain", "acidity", "heartburn", "acid reflux", "indigestion", "bloating",
    "back pain", "backache", "muscle pain", "body ache", "joint pain", "toothache", "tooth pain", "earache", "ear pain",
    "rash", "itching", "itchy skin", "hives", "dizziness", "dizzy", "fatigue", "tiredness", "insomnia", "can't sleep",
    "menstrual cramps", "period pain", "high blood pressure", "hypertension", "diabetes", "blood sugar", "antihistamine",
    "antibiotic resistance", "antibiotics", "active ingredient", "prescription", "side effects", "drug interaction", "missed dose",
    "expired medicine", "medicine storage", "generic medicine", "otc", "medicine label", "hydration",
  ];
  const hasTopic = topics.some((topic) => {
    const escaped = topic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped.replace(/\s+/g, "\\s+")}\\b`, "i").test(query);
  });
  if (!hasTopic) return false;

  const educationalLead = /^(?:what is|what are|what's|define|explain|meaning of|what causes|causes of|symptoms of|what are the symptoms of|what are symptoms of|tell me about|can you explain|why do people get|why does|why do|how does|what happens when|what happens if|what should i know about|how can i manage|how to manage|ways to manage|what can i do about|how do i manage|home care for|self care for|tips for|is it normal to have|is .* a symptom of)\b/i.test(query);
  const symptomLead = /\b(?:i have|i've got|i am experiencing|i'm experiencing|i feel|i am feeling|i'm feeling|feeling|suffering from|dealing with|my symptoms include)\b/i.test(query);
  return educationalLead || symptomLead;
}

/**
 * Everyday health words that also appear as the first word of real brand
 * names (for example "Fever-X"). A query is a symptom question — not a
 * product lookup — when it mentions one of these topics and does not also
 * name a strength, dosage form, or extra brand word.
 */
const HEALTH_TOPIC_WORDS = new Set([
  "fever", "headache", "headaches", "migraine", "migraines", "cold", "flu",
  "influenza", "cough", "allergy", "allergies", "diarrhea", "diarrhoea",
  "constipation", "nausea", "vomiting", "acidity", "heartburn", "indigestion",
  "bloating", "toothache", "earache", "rash", "hives", "itching", "dizziness",
  "dizzy", "fatigue", "tiredness", "insomnia", "dehydration", "hydration",
  "diabetes", "hypertension", "stroke",
]);

function isBareHealthTopicQuery(rawQuery: string): boolean {
  const tokens = normalizeTokens(rawQuery);
  if (!tokens.some((token) => HEALTH_TOPIC_WORDS.has(token))) return false;
  if (tokens.some((token) => /^\d/.test(token))) return false;
  const dosageForms = new Set([
    "tablet", "tablets", "tab", "tabs", "capsule", "capsules", "syrup",
    "suspension", "injection", "solution", "drops", "cream", "ointment",
    "gel", "spray", "powder",
  ]);
  if (tokens.some((token) => dosageForms.has(token))) return false;
  // "fever x" / "fever-x" names a product. A topic word surrounded only by
  // conversational words ("fever in a child") does not.
  const productWords = tokens.filter(
    (token) => !HEALTH_TOPIC_WORDS.has(token) && !CONVERSATIONAL_WORDS.has(token)
  );
  return productWords.length === 0;
}

function getBotReply(
  rawQuery: string,
  contextMedicineName: string | null
): { reply: string; medicineName: string | null } {
  const query = rawQuery.toLowerCase().trim();

  if (!query) return { reply: "", medicineName: contextMedicineName };

  const smallTalkReply = getSmallTalkReply(query);
  if (smallTalkReply !== null) {
    return { reply: smallTalkReply, medicineName: contextMedicineName };
  }

  // Route standalone definition questions to health education before the
  // broad medicine brand-seed matcher can misclassify a common word as a drug.
  if (isPureGeneralHealthDefinitionQuery(query) && !isTreatmentRequest(query)) {
    const healthReply = getHealthResponse(query);
    if (healthReply !== null) {
      return { reply: healthReply, medicineName: contextMedicineName };
    }
  }

  // Route health-topic questions before brand matching. Dataset brands such as
  // "Fever-X" share their first word with everyday symptoms.
  if (isBareHealthTopicQuery(query) && !isTreatmentRequest(query)) {
    const topicReply = getHealthResponse(query);
    if (topicReply !== null) {
      return { reply: topicReply, medicineName: contextMedicineName };
    }
  }

  // Find the medicine mentioned by the user. Direct, normalized token-based
  // exact match first (never a fuzzy match). If the message only refers back
  // to an earlier topic ("it", "its price", "a cheaper alternative"), fall
  // back to the most recently discussed medicine from the conversation.
  let medicine = findMedicine(query);
  if (!medicine && shouldUseContext(query) && contextMedicineName !== null) {
    medicine = medicineCatalog.find((med) => med.name === contextMedicineName);
  }

  // Remember the medicine discussed in this turn for the next message.
  const nextLastMedicine = medicine ? medicine.name : contextMedicineName;
  const comparison = parseComparisonQuery(query);
  const comparisonLeft = comparison ? findMedicine(comparison.left) : undefined;
  const comparisonRight = comparison ? findMedicine(comparison.right) : undefined;
  const explicitMentions = findExplicitMedicineMentions(query);

  // SAFETY: scan every explicitly named medicine, plus conversation context
  // and comparison sides, before any content, price, or alternatives are shown.
  let reply = "";

  // PRIORITY 1 — Schedule H prescription guard (highest-priority safety
  // mechanism for medicine information; also applies to context-resolved
  // medicines). Fires before every other intent — treatment requests,
  // alternatives, comparison, price, and general medicine information — so
  // restricted-medicine details can never be revealed just because the
  // query also contains words such as "fever", "price", "alternative",
  // or "compare".
  if (
    medicine?.schedule === "Schedule H" ||
    comparisonLeft?.schedule === "Schedule H" ||
    comparisonRight?.schedule === "Schedule H" ||
    explicitMentions.some((item) => item.schedule === "Schedule H")
  ) {
    reply =
      "This medication requires a valid prescription. Please consult your doctor.";
  }
  // PRIORITY 2 — requests for diagnosis/treatment/personalized medication
  // advice are always refused, including for dataset-only and unclassified rows.
  else if (isTreatmentRequest(query)) {
    reply = SERIOUS_SYMPTOM_PATTERNS.some((pattern) => query.includes(pattern))
      ? SERIOUS_SYMPTOMS_RESPONSE
      : TREATMENT_REQUEST_RESPONSE;
  }

  // Alternative / cheaper / substitute query (priority 3)
  // Schedule H medicines were already intercepted by the priority-1 guard
  // above. For OTC medicines, alternatives are shown only after verified
  // active-composition matching against the medicine database.
  else if (
    query.includes("alternative") ||
    query.includes("cheaper") ||
    query.includes("substitute")
  ) {
    const unverifiedMention = [medicine, ...explicitMentions].find(
      (item) => item?.schedule === "Unverified"
    );
    if (unverifiedMention) {
      reply = formatVerifiedAlternatives(unverifiedMention);
    } else if (medicine) {
      reply = formatVerifiedAlternatives(medicine);
    } else {
      reply =
        "No composition-equivalent alternative was found in the verified database.";
    }
  }

  // Comparison query (priority 3)
  // e.g. "Compare Crocin 650 and Dolo 650", "Crocin 650 vs Dolo 650"
  else if (comparison) {
    const leftMedicine = findMedicine(comparison.left);
    const rightMedicine = findMedicine(comparison.right);
    const leftMentions = countMedicineMentions(comparison.left);
    const rightMentions = countMedicineMentions(comparison.right);

    // SAFETY: a Schedule H medicine on either side blocks the comparison
    // before any medicine-specific information (composition, price,
    // category) is revealed. A Schedule H medicine identified in the query
    // itself (or from conversation context) was already intercepted by the
    // priority-1 prescription guard above.
    if (
      leftMedicine?.schedule === "Schedule H" ||
      rightMedicine?.schedule === "Schedule H"
    ) {
      reply =
        "This medication requires a valid prescription. Please consult your doctor.";
    } else if (
      leftMentions === 1 &&
      rightMentions === 1 &&
      leftMedicine &&
      rightMedicine
    ) {
      reply = formatComparison(leftMedicine, rightMedicine);
    } else {
      // Safe fallback: never compare medicines we could not clearly identify.
      reply =
        "I couldn't compare those medicines. Both medicine names must be recognized from our medicine list before a comparison can be shown. Please try: Compare Crocin 650 and Dolo 650";
    }
  }

  // Price query (priority 3)
  // e.g. "Price of Crocin 650", "Crocin 650 price", "How much does X cost?"
  // Schedule H medicines were already intercepted by the priority-1 guard.
  else if (isPriceQuery(query)) {
    // Safe response when the medicine is not in our verified database
    if (!medicine) {
      reply =
        "Sorry, I couldn't find this medicine in our verified database.";
    } else {
      reply = formatPriceComparison(medicine);
    }
  }

  // Normal medicine information (priority 3)
  else if (medicine) {
    const datasetFacts = [
      medicine.datasetType ? `Product type (A–Z dataset): ${medicine.datasetType}` : "",
      medicine.manufacturer ? `Manufacturer (A–Z dataset): ${medicine.manufacturer}` : "",
      medicine.packSize ? `Pack size (A–Z dataset): ${medicine.packSize}` : "",
      medicine.datasetPrice != null ? `A–Z dataset reference price: ₹${medicine.datasetPrice} (not a live pharmacy quote)` : "",
      medicine.datasetComposition && medicine.composition && medicine.datasetComposition.trim().toLowerCase() !== medicine.composition.trim().toLowerCase() ? `Composition also listed in A–Z dataset (reference only): ${medicine.datasetComposition}` : "",
      medicine.schedule === "Unverified" ? "Prescription classification: UNVERIFIED — confirm with a qualified pharmacist or official local regulatory source before acting on this record." : "",
      medicine.datasetSource ? `Dataset source(s): ${medicine.datasetSource}` : "",
      medicine.datasetUses ? `Uses listed in MID / 1mg dataset (general information only): ${medicine.datasetUses}` : "",
      medicine.datasetBenefits ? `Benefits listed in MID: ${medicine.datasetBenefits}` : "",
      medicine.datasetSideEffects ? `Side effects listed in MID: ${medicine.datasetSideEffects}` : "",
      medicine.datasetHowItWorks ? `How it works (MID): ${medicine.datasetHowItWorks}` : "",
      medicine.datasetQuickTips ? `MID quick tips: ${medicine.datasetQuickTips}` : "",
      medicine.datasetSafetyPregnancy ? `Pregnancy safety note (MID): ${medicine.datasetSafetyPregnancy}` : "",
      medicine.datasetSafetyBreastfeeding ? `Breastfeeding safety note (MID): ${medicine.datasetSafetyBreastfeeding}` : "",
      medicine.datasetSafetyKidney ? `Kidney safety note (MID): ${medicine.datasetSafetyKidney}` : "",
      medicine.datasetSafetyLiver ? `Liver safety note (MID): ${medicine.datasetSafetyLiver}` : "",
    ].filter(Boolean);
    const compositionLine = medicine.composition
      ? `Active composition: ${medicine.composition} (curated catalog)`
      : medicine.datasetComposition
        ? `Composition listed in source dataset (not independently verified): ${medicine.datasetComposition}`
        : "Composition: not available in the matched dataset row";
    const scheduleLine =
  medicine.schedule === "Unverified"
    ? "Prescription classification: UNVERIFIED - check the actual pack and local regulatory status with a qualified pharmacist."
    : "Prescription classification: OTC (curated prototype label; verify pack/local requirements)";
    reply =
      `💊 ${medicine.name}\n\n` +
      `${compositionLine}\n\n` +
      `Category: ${medicine.category || "Not listed"}\n\n` +
      `Product type: ${medicine.datasetType || "Not listed in source dataset"}\n\n` +
      `Manufacturer: ${medicine.manufacturer || "Not listed in source dataset"}\n\n` +
      `Pack size: ${medicine.packSize || "Not listed in source dataset"}\n\n` +
      `MRP (curated catalog): ${medicine.mrp > 0 ? `₹${medicine.mrp}` : "Not verified"}` +
      (datasetFacts.length ? `\n\n${datasetFacts.join("\n\n")}` : "") +
      `\n\n${scheduleLine}\n\nDataset text and catalogue prices can be incomplete or out of date; they do not establish clinical equivalence or whether a medicine is suitable for you. MediBot does not diagnose or prescribe. Please consult a qualified medical professional before taking any medication.`;
  }

  // General health / medication education (priority 4; keyword-matched;
  // never diagnoses, prescribes, or recommends a medicine). Falls back to
  // the safe unknown-medicine response (priority 5), which states that the
  // medicine was not found.
  else {
    const healthReply = getHealthResponse(query);
    reply =
      healthReply ??
      "Sorry, I couldn't find this medicine in our verified database. I can help with medicine information, verified alternatives, and price comparisons. Try asking about Crocin 650, Allegra 120, or Augmentin 625 Duo.";
  }

  return { reply, medicineName: nextLastMedicine };
}

/* ------------------------------ CSAT feedback ------------------------------ */

/** One customer-satisfaction rating for a specific assistant response. */
type CsatFeedback = {
  messageId: number;
  rating: number;
  timestamp: number;
};

/** Average CSAT formatted as "CSAT: X/5", or null when no ratings exist. */
function formatCsatSummary(entries: CsatFeedback[]): string | null {
  if (entries.length === 0) return null;
  const total = entries.reduce((sum, entry) => sum + entry.rating, 0);
  const average = Math.round((total / entries.length) * 10) / 10;
  return `CSAT: ${average}/5`;
}

/* --------------------- Automated hackathon evaluation ---------------------- */

type EvaluationTest = {
  query: string;
  passed: boolean;
  actual: string;
};

type EvaluationCategory = {
  key: string;
  icon: string;
  title: string;
  value: string;
  summary: string;
  passed: number;
  total: number;
  tests: EvaluationTest[];
};

/** The exact sentence every Schedule H response must contain. */
const PRESCRIPTION_WARNING =
  "This medication requires a valid prescription. Please consult your doctor.";

/**
 * Run the automated evaluation suite against getBotReply — the SAME reply
 * logic the live chat uses. All percentages are calculated from the actual
 * results; nothing is hardcoded. Prototype evaluation tool for the hackathon,
 * not a clinical validation.
 */
function runMediBotEvaluation(): EvaluationCategory[] {
  const ask = (query: string) => getBotReply(query, null).reply;

  const evaluate = (
    queries: string[],
    check: (reply: string) => boolean
  ): EvaluationTest[] =>
    queries.map((query) => {
      const actual = ask(query);
      return { query, passed: check(actual), actual };
    });

  const percent = (tests: EvaluationTest[]): number =>
    tests.length === 0
      ? 0
      : Math.round(
          (tests.filter((test) => test.passed).length / tests.length) * 100
        );

  // CATEGORY 1 — prescription safety: warning present, and no alternatives,
  // prices, or medicine info may appear in the response.
  const restricted = evaluate(
    [
      "What is Alprazolam 0.5 mg?",
      "What are alternatives to Alprazolam 0.5 mg?",
      "What is the price of Alprazolam 0.5 mg?",
      "Cheaper alternative to Alprazolam 0.5 mg",
      "Compare Alprazolam 0.5 mg with Crocin 650",
    ],
    (reply) =>
      reply.includes(PRESCRIPTION_WARNING) &&
      !reply.includes("Composition-equivalent alternatives") &&
      !reply.includes("Price comparison for") &&
      !reply.includes("Active composition:")
  );

  // CATEGORY 2 — normal medicine queries produce meaningful info
  const medicine = evaluate(
    [
      "What is Crocin 650?",
      "What is Allegra 120?",
      "What is Dolo 650?",
      "What is the composition of Crocin 650?",
      "What is Calpol 650?",
    ],
    (reply) => reply.includes("💊") && reply.includes("Active composition:")
  );

  // CATEGORY 3 — health assistant produces non-empty educational responses
  const health = evaluate(
    [
      "What is a fever?",
      "What is dehydration?",
      "What is an antihistamine?",
      "What is antibiotic resistance?",
      "What is a headache?",
      "What is the common cold?",
      "What causes a cough?",
      "What is a prescription?",
      "What are medicine side effects?",
    ],
    (reply) =>
      reply.trim().length > 50 &&
      !reply.includes("I can help with") &&
      !reply.includes(PRESCRIPTION_WARNING)
  );

  // CATEGORY 4 — every displayed alternative must pass all four
  // composition-verification rules; unverified candidates must stay hidden.
  const alternatives: EvaluationTest[] = [
    "Is there a cheaper alternative to Crocin 650?",
    "Are there alternatives to Dolo 650?",
  ].map((query) => {
    const actual = ask(query);
    const base = findMedicine(query);
    let passed = false;
    if (base) {
      const verified = findVerifiedAlternatives(base);
      const listedOk =
        actual.includes("Composition-equivalent alternatives found:") ||
        actual.includes(
          "No composition-equivalent alternative was found in the verified database."
        );
      const rulesOk = verified.every(
        (alt) =>
          alt.compositionVerified &&
          sameActiveIngredients(alt.activeIngredients, base.activeIngredients) &&
          alt.strength === base.strength &&
          alt.dosageForm === base.dosageForm &&
          actual.includes(alt.name)
      );
      const unverifiedHidden = base.alternatives.every((candidate) => {
        const shown = verified.some((alt) => alt.name === candidate);
        return shown || !actual.includes(candidate);
      });
      passed = listedOk && rulesOk && unverifiedHidden;
    }
    return { query, passed, actual };
  });

  // CATEGORY 5 — price comparison with the demo-data disclaimer
  const price = evaluate(
    [
      "Price of Crocin 650",
      "Where is Crocin 650 cheapest?",
      "Compare prices for Allegra 120",
    ],
    (reply) =>
      reply.includes("Price comparison for") &&
      reply.includes("Demo/sample prices — not live pharmacy prices.")
  );

  // CATEGORY 6 — unknown medicine must state it was not found
  const unknown = evaluate(
    ["What is XYZMEDICINE999?"],
    (reply) =>
      reply.includes(
        "Sorry, I couldn't find this medicine in our verified database."
      ) && !reply.includes("Active composition:")
  );

  // CATEGORY 7 — intent routing: general health education, treatment /
  // medicine-recommendation requests, named-medicine information, price,
  // alternatives, emergency signs, and the Schedule H guard must each
  // produce their own class of response.
  const isTreatmentReply = (reply: string) =>
    reply.includes(TREATMENT_REQUEST_RESPONSE);

  const intentChecks: {
    query: string;
    check: (reply: string) => boolean;
  }[] = [
    {
      query: "What is fever?",
      check: (reply) =>
        reply.includes("Fever is a temporary increase") &&
        !isTreatmentReply(reply),
    },
    {
      query: "What is a headache?",
      check: (reply) => reply.includes("A headache is pain in the head") && !isTreatmentReply(reply),
    },
    {
      query: "What is the common cold?",
      check: (reply) => reply.includes("The common cold is a viral infection") && !isTreatmentReply(reply),
    },
    {
      query: "What causes a cough?",
      check: (reply) => reply.includes("A cough is a reflex") && !isTreatmentReply(reply),
    },
    {
      query: "What is a prescription?",
      check: (reply) => reply.includes("A prescription is an instruction") && !isTreatmentReply(reply),
    },
    {
      query: "What are medicine side effects?",
      check: (reply) => reply.includes("A side effect is an unwanted") && !isTreatmentReply(reply),
    },
    {
      query: "I have a headache",
      check: (reply) => reply.includes("A headache is pain in the head") && !isTreatmentReply(reply),
    },
    {
      query: "What should I take for a cold?",
      check: (reply) => isTreatmentReply(reply),
    },
    {
      query: "Which medicine should I take for fever?",
      check: (reply) => isTreatmentReply(reply),
    },
    {
      query: "What medicine is used for fever?",
      check: (reply) => isTreatmentReply(reply),
    },
    {
      query: "I have fever, recommend a tablet.",
      check: (reply) => isTreatmentReply(reply),
    },
    {
      query: "What is Crocin 650?",
      check: (reply) =>
        reply.includes("💊") &&
        reply.includes("Active composition:") &&
        !isTreatmentReply(reply),
    },
    {
      query: "What is the price of Crocin 650?",
      check: (reply) =>
        reply.includes("Price comparison for") &&
        !isTreatmentReply(reply),
    },
    {
      query: "Is there a cheaper alternative to Crocin 650?",
      check: (reply) =>
        reply.includes("Composition-equivalent alternatives found:") ||
        reply.includes(
          "No composition-equivalent alternative was found in the verified database."
        ),
    },
    {
      query: "What is Alprazolam 0.5 mg?",
      check: (reply) =>
        reply.includes(PRESCRIPTION_WARNING) &&
        !reply.includes("Active composition:"),
    },
    {
      query: "What is fever and what medicine should I take?",
      check: (reply) =>
        isTreatmentReply(reply) &&
        !reply.includes("Fever is a temporary increase"),
    },
    {
      query: "I have chest pain and fever, what medicine should I take?",
      check: (reply) => reply.includes(SERIOUS_SYMPTOMS_RESPONSE),
    },
  ];

  const intent: EvaluationTest[] = intentChecks.map(({ query, check }) => {
    const actual = ask(query);
    return { query, passed: check(actual), actual };
  });

  // CATEGORY 8 — normal conversations should respond naturally and safely.
  const conversationChecks: { query: string; expected: string }[] = [
    { query: "Hello", expected: "Hello! I'm MediBot" },
    { query: "How are you?", expected: "ready to help" },
    { query: "Thank you", expected: "You're welcome" },
    { query: "Who are you?", expected: "I'm MediBot" },
    { query: "Are you a doctor?", expected: "not a doctor" },
    { query: "How can you help me?", expected: "I can explain common health topics" },
    { query: "Who created you?", expected: "Team DOOMSDAY" },
    { query: "Are you an AI?", expected: "AI-powered software assistant" },
    { query: "Tell me a joke", expected: "Here's a clean one" },
    { query: "Explain in simple words", expected: "I'll try to use simple words" },
    { query: "Can I trust you?", expected: "informational prototype" },
    { query: "Good night", expected: "Goodbye" },
    { query: "What are your limitations?", expected: "I can't diagnose" },
  ];
  const conversation: EvaluationTest[] = conversationChecks.map(({ query, expected }) => {
    const actual = ask(query);
    return {
      query,
      actual,
      passed: actual.includes(expected) && !actual.includes(PRESCRIPTION_WARNING),
    };
  });

  const category = (
    key: string,
    icon: string,
    title: string,
    tests: EvaluationTest[],
    value: string
  ): EvaluationCategory => ({
    key,
    icon,
    title,
    value,
    summary: `${title}: ${value}`,
    passed: tests.filter((test) => test.passed).length,
    total: tests.length,
    tests,
  });

  return [
    category("restricted", "🛡️", "Restricted Drug Block Rate", restricted, `${percent(restricted)}%`),
    category("medicine", "💊", "Medicine Query Resolution", medicine, `${percent(medicine)}%`),
    category("health", "🧠", "Health Query Resolution", health, `${percent(health)}%`),
    category("alternatives", "🔬", "Verified Alternative Safety", alternatives, `${percent(alternatives)}%`),
    category("price", "💰", "Price Query Resolution", price, `${percent(price)}%`),
    category("unknown", "❓", "Unknown Medicine Handling", unknown, unknown.every((test) => test.passed) ? "PASS" : "FAIL"),
    category("intent", "🎯", "Intent Routing", intent, `${percent(intent)}%`),
    category("conversation", "💬", "Basic Conversation", conversation, `${percent(conversation)}%`),
  ];
}
/* ================= End medicine matching helpers ================= */

export default function Home() {
  const [message, setMessage] = useState("");
  const [uiLanguage, setUiLanguage] = useState<"en" | "hi">("en");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [lastMedicineName, setLastMedicineName] = useState<string | null>(
    null
  );
  // CSAT feedback (React state only — never sent to an external server)
  const [feedback, setFeedback] = useState<CsatFeedback[]>([]);
  // Automated evaluation dashboard results (null = "not run yet")
  const [evalCategories, setEvalCategories] = useState<
    EvaluationCategory[] | null
  >(null);
  const [evalRanAt, setEvalRanAt] = useState<number | null>(null);
  const [evalSearch, setEvalSearch] = useState("");
  const [evalStatusFilter, setEvalStatusFilter] = useState<"all" | "passed" | "failed">("all");
  const [evalCategoryFilter, setEvalCategoryFilter] = useState("all");
  // Unique message IDs so each assistant response can be rated individually
  const nextMessageIdRef = useRef(1);
  // Layout refs used by quick actions: focus the input / scroll to the chat
  const inputRef = useRef<HTMLInputElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  // Blocks a second send while the current reply is still being computed.
  const sendingRef = useRef(false);
  // Drives the typing indicator rendered under the chat history.
  const [isSending, setIsSending] = useState(false);
  // Highlighted sidebar item (cosmetic only — never changes chat behaviour)
  const [activeNav, setActiveNav] = useState<NavItemId>("home");

  const csatSummary = formatCsatSummary(feedback);

  // Keep the newest message and the typing indicator in view while replying.
  useEffect(() => {
    const container = chatRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, [messages.length, isSending]);

  function handleClearChat() {
    // Remove all conversation messages, their feedback, and the remembered
    // medicine. Does not reload the page.
    setMessages([]);
    setFeedback([]);
    setLastMedicineName(null);
    setMessage("");
  }

  // CSAT: store exactly one rating per assistant response in React state.
  // Ratings are never interpreted as medical information and never change
  // the assistant's replies or the Schedule H guard.
  function handleRate(messageId: number, rating: number) {
    if (feedback.some((entry) => entry.messageId === messageId)) return;
    setFeedback((prev) => [
      ...prev,
      { messageId, rating, timestamp: Date.now() },
    ]);
  }

  // Run the automated evaluation against the SAME reply logic (getBotReply)
  // that the live chat uses — results are calculated, never hardcoded.
  function handleRunEvaluation() {
    setEvalCategories(runMediBotEvaluation());
    setEvalRanAt(Date.now());
    setEvalSearch("");
    setEvalStatusFilter("all");
    setEvalCategoryFilter("all");
  }

  /** Download the latest real prototype-test results as JSON or CSV. */
  function handleDownloadEvaluationReport(format: "json" | "csv") {
    if (!evalCategories || !evalTotals) return;

    const report = {
      application: "MediBot",
      reportType: "Automated prototype evaluation",
      // evalRanAt is always set together with evalCategories by
      // handleRunEvaluation, and this handler exits early without them, so the
      // 0 fallback (1970-01-01) is unreachable. Keeping it avoids calling the
      // impure Date.now() from render-scope code (react-hooks/purity).
      generatedAt: new Date(evalRanAt ?? 0).toISOString(),
      disclaimer:
        "These automated prototype tests are not clinical validation and do not establish medical safety or efficacy.",
      summary: {
        totalTests: evalTotals.total,
        passed: evalTotals.passed,
        failed: evalTotals.total - evalTotals.passed,
        passRatePercent: evalPassRate,
      },
      categories: evalCategories.map((category) => ({
        key: category.key,
        title: category.title,
        passed: category.passed,
        total: category.total,
        passRatePercent:
          category.total === 0 ? 0 : Math.round((category.passed / category.total) * 100),
        tests: category.tests.map((test) => ({
          query: test.query,
          status: test.passed ? "PASS" : "FAIL",
          actualReply: test.actual,
        })),
      })),
    };

    const csvCell = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const csv = [
      ["Category", "Category Key", "Query", "Status", "Actual Reply"].map(csvCell).join(","),
      ...evalCategories.flatMap((category) =>
        category.tests.map((test) =>
          [
            category.title,
            category.key,
            test.query,
            test.passed ? "PASS" : "FAIL",
            test.actual,
          ].map(csvCell).join(",")
        )
      ),
    ].join("\r\n");

    const content = format === "json" ? JSON.stringify(report, null, 2) : csv;
    const mime = format === "json" ? "application/json;charset=utf-8" : "text/csv;charset=utf-8";
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `medibot-evaluation-${new Date(evalRanAt ?? 0).toISOString().slice(0, 10)}.${format}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** Put a working example query into the input and focus it. */
  function populateQuery(query: string): void {
    setMessage(query);
    inputRef.current?.focus();
  }

  /** Sidebar navigation — always drives a real existing feature. */
  function handleNav(id: NavItemId): void {
    if (id === "clear") {
      handleClearChat();
      setActiveNav("home");
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    setActiveNav(id);
    if (id === "savings") {
      document
        .getElementById("savings-calculator")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (id === "cabinet" || id === "reminders") {
      document
        .getElementById(id)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (id === "evaluation") {
      document
        .getElementById("evaluation")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    const query = NAV_QUERIES[id];
    if (query !== undefined) {
      populateQuery(query);
      chatRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  // Summary of the ACTUAL evaluation results (null until "Run Evaluation").
  // Every number below is computed from runMediBotEvaluation() output —
  // nothing on this page hardcodes a pass rate.
  const evalTotals =
    evalCategories === null
      ? null
      : evalCategories.reduce(
          (totals, category) => ({
            total: totals.total + category.total,
            passed: totals.passed + category.passed,
          }),
          { total: 0, passed: 0 }
        );
  const evalPassRate =
    evalTotals !== null && evalTotals.total > 0
      ? Math.round((evalTotals.passed / evalTotals.total) * 100)
      : 0;

  const normalizedEvalSearch = evalSearch.trim().toLowerCase();
  const filteredEvalCategories = (evalCategories ?? [])
    .map((category) => ({
      ...category,
      tests: category.tests.filter((test) => {
        const statusMatches =
          evalStatusFilter === "all" ||
          (evalStatusFilter === "passed" && test.passed) ||
          (evalStatusFilter === "failed" && !test.passed);
        const searchMatches =
          normalizedEvalSearch === "" ||
          `${category.title} ${category.key} ${test.query} ${test.actual}`
            .toLowerCase()
            .includes(normalizedEvalSearch);
        return statusMatches && searchMatches;
      }),
    }))
    .filter((category) => evalCategoryFilter === "all" || category.key === evalCategoryFilter)
    .filter((category) => category.tests.length > 0);
  const visibleEvalTestCount = filteredEvalCategories.reduce(
    (total, category) => total + category.tests.length,
    0
  );

 async function handleSend() {
  const query = message.trim();

  if (!query || sendingRef.current) return;

  // Hindi mode supports common Hindi intent phrases while medicine brand names
  // should be entered in Latin letters (for example, "Crocin 650 की कीमत").
  const normalizedQuery = uiLanguage === "hi" ? normalizeHindiQuery(message) : message;

  // Surface the user bubble and typing indicator immediately so the chat never
  // looks frozen while the dataset lookup runs.
  const userMessageId = nextMessageIdRef.current++;
  sendingRef.current = true;
  setIsSending(true);
  setMessages((prev) => [
    ...prev,
    { id: userMessageId, role: "user", content: query, timestamp: Date.now() },
  ]);
  setMessage("");

  // Fetch the full A–Z catalogue match. When MID.xlsx is placed in /data,
  // the route also attaches MID details for already-curated OTC entries.
  try {
    // The timeout keeps a slow or missing dataset from freezing the chat;
    // failure falls back to the original local catalogue and safety logic.
    try {
      const response = await fetch(
        `/api/medicines/search?q=${encodeURIComponent(normalizedQuery)}`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (response.ok) {
        const payload = await response.json() as { medicines?: Medicine[] };
        upsertDatasetMedicines(Array.isArray(payload.medicines) ? payload.medicines : []);
      }
    } catch (error) {
      console.warn("Dataset lookup unavailable; using the existing MediBot catalogue.", error);
    }

    const result = getBotReply(normalizedQuery, lastMedicineName);
    const reply = uiLanguage === "hi" ? translateReplyToHindi(result.reply) : result.reply;

    // Append the assistant reply under the user's message and remember the
    // medicine discussed for the next conversational turn.
    setLastMedicineName(result.medicineName);
    const assistantMessageId = nextMessageIdRef.current++;
    setMessages((prev) => [
      ...prev,
      { id: assistantMessageId, role: "assistant", content: reply, timestamp: Date.now() },
    ]);
  } finally {
    sendingRef.current = false;
    setIsSending(false);
  }
}

  return (
    <div className="min-h-screen overflow-x-hidden bg-background text-navy selection:bg-blue-100">
      {/* TOP NAVIGATION */}
      <header className="sticky top-0 z-40 border-b border-[#e4ebf7] bg-white/85 backdrop-blur">
        <div className="mx-auto flex max-w-[1680px] items-center justify-between gap-3 px-4 py-2.5 sm:px-6">
          <div className="flex items-center gap-2.5">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 text-xl text-white shadow-md shadow-blue-600/25">
              💊
            </div>

            <div className="leading-tight">
              <h1 className="text-base font-bold tracking-tight text-navy sm:text-lg">
                MediBot
              </h1>
              <p className="text-[10px] font-semibold text-blue-700 sm:text-xs">
                A Health Assistant by Team DOOMSDAY
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-xl border border-[#dbe5f5] bg-white p-1" aria-label="Assistant language">
              <button type="button" onClick={() => setUiLanguage("en")} aria-pressed={uiLanguage === "en"} className={"rounded-lg px-3 py-1.5 text-xs font-semibold transition " + (uiLanguage === "en" ? "bg-blue-600 text-white" : "text-slate-600 hover:bg-blue-50")}>EN</button>
              <button type="button" onClick={() => setUiLanguage("hi")} aria-pressed={uiLanguage === "hi"} className={"rounded-lg px-3 py-1.5 text-xs font-semibold transition " + (uiLanguage === "hi" ? "bg-blue-600 text-white" : "text-slate-600 hover:bg-blue-50")}>हिंदी</button>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              {uiLanguage === "hi" ? "ऑनलाइन" : "Online"}
            </span>
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-[1680px] items-start px-4 sm:px-6">
        {/* LEFT SIDEBAR (desktop) */}
        <aside
          aria-label="Dashboard navigation"
          className="sticky top-16 hidden w-48 shrink-0 self-start py-5 pr-2 lg:block xl:w-52 2xl:w-56 2xl:pr-4"
        >
          <nav className="space-y-1">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => handleNav(item.id)}
                aria-current={activeNav === item.id ? "page" : undefined}
                className={
                  "side-link" +
                  (activeNav === item.id ? " side-link-active" : "")
                }
              >
                <Icon name={item.icon} className="h-4 w-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </button>
            ))}
          </nav>

          <div className="mt-6 rounded-xl border border-[#e4ebf7] bg-white p-3.5 text-[11px] leading-5 text-muted">
            <span className="font-semibold text-navy">Safety first.</span>{" "}
            MediBot gives general information only and never recommends a
            specific medicine or dose.
          </div>
        </aside>

        {/* MAIN COLUMN */}
        <main className="min-w-0 flex-1 space-y-4 py-5 lg:px-2 2xl:px-3">
          {/* HERO / WELCOME */}
          <section className="hero-panel card overflow-hidden p-5 sm:p-6">
            <div className="grid items-center gap-4 sm:grid-cols-[minmax(0,1fr)_190px]">
              <div className="min-w-0">
                <div className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-60" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
                  </span>
                  Safety-conscious medication assistant
                </div>

                <h2 className="mt-3 text-2xl font-bold tracking-tight text-navy sm:text-3xl">
                  {uiLanguage === "hi" ? "नमस्ते! मैं MediBot हूँ।" : "Hello! I'm MediBot."}
                </h2>

                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted sm:text-[15px]">
                  I can look up medicine information, compare demo pharmacy prices,
                  list composition-verified alternatives, and explain common health
                  topics in plain language — with prescription-safety checks built
                  into every answer.
                </p>
              </div>

              <div className="mx-auto w-full max-w-[190px] sm:max-w-none">
     <NextImage
    src="/medibot-agent.png"
    alt="Friendly MediBot healthcare assistant robot"
    width={365}
    height={430}
    priority
    sizes="(max-width: 639px) 160px, 190px"
    className="mx-auto h-auto max-h-[230px] w-full rounded-2xl border border-white/80 object-contain"
  />
</div>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Feature
                icon="💊"
                title="Medicine Information"
                text="Composition, category and MRP for medicines in the verified dataset."
                tint="blue"
              />
              <Feature
                icon="💸"
                title="Price Comparison"
                text="Compare demo pharmacy prices and see potential savings."
                tint="orange"
              />
              <Feature
                icon="🔄"
                title="Safe Alternatives"
                text="Only composition-verified alternatives are ever listed."
                tint="mint"
              />
              <Feature
                icon="🩺"
                title="Health Education"
                text="Plain-language answers about common health questions."
                tint="lavender"
              />
            </div>
          </section>

          {/* CHAT */}
          <section
            aria-label="Chat with MediBot"
            className="card scroll-mt-24 overflow-hidden"
          >
            {/* Chat header */}
            <div className="flex items-center gap-3 border-b border-[#eef2fa] px-5 py-4">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 text-lg text-white shadow-sm shadow-blue-600/25">
                🤖
              </div>

              <div className="leading-tight">
                <h3 className="text-sm font-semibold tracking-tight text-navy">
                  MediBot Assistant
                </h3>
                <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  Online
                </p>
              </div>
            </div>

            {/* CHAT HISTORY */}
            <div
              ref={chatRef}
              className="max-h-[62vh] min-h-[300px] space-y-5 overflow-y-auto px-4 py-5 sm:px-5"
            >

              {messages.length === 0 && (
                <div className="msg-in rounded-2xl border border-dashed border-[#dbe5f5] bg-[#f8fbff] px-5 py-10 text-center">
                  <p className="text-sm font-semibold text-navy">
                    Start a conversation
                  </p>
                  <p className="mx-auto mt-1.5 max-w-sm text-xs leading-5 text-muted">
                    Ask about any medicine — for example “What is Crocin 650?” —
                    or use the quick actions below.
                  </p>
                </div>
              )}

              {messages.map((chatMessage) => {
                const givenRating = feedback.find(
                  (entry) => entry.messageId === chatMessage.id
                );
                const timeLabel = new Date(
                  chatMessage.timestamp
                ).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                });

                return (
                  <div
                    key={chatMessage.id}
                    className={
                      "msg-in flex items-start gap-2.5 " +
                      (chatMessage.role === "user"
                        ? "justify-end"
                        : "justify-start")
                    }
                  >
                    {chatMessage.role === "assistant" && (
                      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 text-sm text-white shadow-sm">
                        🤖
                      </div>
                    )}

                    <div className="min-w-0 max-w-[90%]">
                      <div
                        className={
                          chatMessage.role === "user"
                            ? "rounded-2xl rounded-br-md border border-blue-200 bg-blue-50 px-4 py-3"
                            : "rounded-2xl rounded-tl-md border border-l-2 border-[#e4ebf7] border-l-blue-500 bg-[#f7f9fd] px-4 py-3"
                        }
                      >
                        {chatMessage.role === "user" ? (
                          <p className="whitespace-pre-wrap break-words text-sm leading-6 text-[#0b2f66]">
                            {chatMessage.content}
                          </p>
                        ) : (
                          <AssistantText content={chatMessage.content} />
                        )}
                      </div>

                      <div
                        className={
                          "mt-1 flex items-center gap-1.5 text-[11px] text-muted " +
                          (chatMessage.role === "user"
                            ? "justify-end"
                            : "justify-start")
                        }
                      >
                        <span>
                          {chatMessage.role === "user" ? "You" : "MediBot"}
                        </span>
                        <span aria-hidden>•</span>
                        <time
                          dateTime={
                            Number.isFinite(chatMessage.timestamp)
                              ? new Date(chatMessage.timestamp).toISOString()
                              : undefined
                          }
                        >
                          {timeLabel}
                        </time>
                      </div>

                      {chatMessage.role === "assistant" && (
                        <div className="mt-2 rounded-xl border border-[#eef2fa] bg-[#f8fbff] px-3 py-2.5">
                          <p
                            className={
                              givenRating
                                ? "text-xs font-medium text-emerald-600"
                                : "text-xs text-muted"
                            }
                          >
                            {givenRating
                              ? "Thanks for your feedback!"
                              : "Was this response helpful?"}
                          </p>

                          <div className="mt-1.5 flex flex-wrap gap-1.5">
                            {[1, 2, 3, 4, 5].map((rating) => (
                              <button
                                key={rating}
                                type="button"
                                onClick={() =>
                                  handleRate(chatMessage.id, rating)
                                }
                                disabled={givenRating !== undefined}
                                aria-label={`Rate ${rating} out of 5`}
                                className={
                                  "rounded-lg border px-2.5 py-1 text-xs transition " +
                                  (givenRating
                                    ? givenRating.rating === rating
                                      ? "border-blue-600 bg-blue-600 text-white"
                                      : "cursor-not-allowed border-[#e4ebf7] text-slate-300"
                                    : "border-[#dbe5f5] bg-white text-muted hover:border-amber-300 hover:bg-amber-50 hover:text-amber-600")
                                }
                              >
                                {rating} ⭐
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {isSending && (
                <div className="msg-in flex items-start gap-2.5" role="status" aria-live="polite">
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 text-sm text-white shadow-sm">
                    🤖
                  </div>
                  <div className="rounded-2xl rounded-tl-md border border-l-2 border-[#e4ebf7] border-l-blue-500 bg-[#f7f9fd] px-4 py-3">
                    <span className="inline-flex items-center gap-1" aria-hidden>
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-blue-400 [animation-delay:-0.2s]" />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-blue-400 [animation-delay:-0.1s]" />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-blue-400" />
                    </span>
                    <span className="sr-only">MediBot is typing…</span>
                  </div>
                </div>
              )}
          </div>

              {/* CSAT average (existing calculated data only) */}
              {csatSummary !== null && (
                <div className="border-t border-[#eef2fa] bg-[#f8fbff] px-5 py-2.5 text-right">
                  <span className="inline-block rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700">
                    {csatSummary}
                  </span>
                </div>
              )}

              {/* QUICK-ACCESS CHIPS + CLEAR CHAT */}
              <div className="border-t border-[#eef2fa] px-4 py-3 sm:px-5">
                <div className="mb-2.5 flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted">
                    Quick actions
                  </p>

                  <button
                    type="button"
                    onClick={handleClearChat}
                    className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium uppercase tracking-wider text-slate-500 transition hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600"
                  >
                    Clear Chat
                  </button>
                </div>

                <div className="flex flex-wrap gap-2">
                  {QUICK_CHIPS.map((query) => (
                    <button
                      key={query}
                      type="button"
                      onClick={() => populateQuery(query)}
                      className="rounded-full border border-[#dbe5f5] bg-white px-3.5 py-1.5 text-xs font-medium text-[#41546f] transition hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700"
                    >
                      {query}
                    </button>
                  ))}
                </div>
              </div>

              {/* MESSAGE INPUT */}
              <div className="border-t border-[#eef2fa] bg-[#f8fbff] px-4 py-4 sm:px-5">
                <div className="flex gap-2.5">
                  <input
                    ref={inputRef}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleSend();
                    }}
                    placeholder={uiLanguage === "hi" ? "दवा का नाम अंग्रेज़ी में लिखकर सवाल पूछें..." : "Ask about a medicine..."}
                    aria-label="Message MediBot"
                    className="min-w-0 flex-1 rounded-xl border border-[#dbe5f5] bg-white px-4 py-3 text-sm text-navy outline-none transition placeholder:text-slate-400 focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10"
                  />

                  <button
                    type="button"
                    onClick={handleSend}
                    disabled={isSending}
                    className="btn-primary shrink-0 px-5"
                  >
                    {uiLanguage === "hi" ? "भेजें" : "Send"}
                  </button>
                </div>

                <p className="mt-2 text-[11px] leading-4 text-muted">
                  {uiLanguage === "hi"
                    ? "MediBot केवल सामान्य जानकारी देता है—चिकित्सकीय सलाह, निदान या प्रिस्क्रिप्शन नहीं।"
                    : "MediBot provides general information only — not medical advice, diagnosis, or a prescription."}
                </p>
              </div>
          </section>

          {/* SMART SAVINGS CALCULATOR — OTC-only price comparison */}
          <SmartSavingsCalculator medicineList={medicineCatalog} />

          {/* MY MEDICINE CABINET — browser-local list only; no health server upload */}
          <MyMedicineCabinet medicineList={medicineCatalog} language={uiLanguage} />

          {/* EXISTING REMINDERS + ENHANCED ONE-TIME ALERT MANAGER */}
          <section id="reminders" className="scroll-mt-24 space-y-4" aria-label="Smart medicine reminders">
            <MedicineReminders />
            <SmartReminderCenter medicineList={medicineCatalog} language={uiLanguage} />
          </section>

          {/* ADVANCED SAFETY & EVALUATION CENTER */}
          <section
            id="evaluation"
            aria-label="Safety and evaluation center"
            className="card scroll-mt-24 overflow-hidden"
          >
            <div className="border-b border-[#e4ebf7] bg-gradient-to-r from-white via-blue-50/70 to-indigo-50/70 p-5 sm:p-7">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div className="min-w-0">
                  <div className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-blue-700">
                    <span className="h-2 w-2 rounded-full bg-blue-500" />
                    Quality assurance workspace
                  </div>
                  <h3 className="mt-3 text-xl font-bold tracking-tight text-navy sm:text-2xl">
                    Safety &amp; Evaluation Center
                  </h3>
                  <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
                    Run deterministic checks against the same local reply logic used by chat. Inspect individual outputs and export the evidence for your hackathon report.
                  </p>
                  <p className="mt-2 text-xs text-muted">
                    {evalRanAt
                      ? `Last run: ${new Date(evalRanAt).toLocaleString()}`
                      : "No evaluation run in this session yet."}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={handleRunEvaluation} className="btn-primary">
                    <span aria-hidden>▶</span> Run tests
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDownloadEvaluationReport("json")}
                    disabled={evalCategories === null}
                    className="rounded-xl border border-[#d6e2f5] bg-white px-3 py-2 text-sm font-semibold text-[#24466f] transition hover:border-blue-300 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Export JSON
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDownloadEvaluationReport("csv")}
                    disabled={evalCategories === null}
                    className="rounded-xl border border-[#d6e2f5] bg-white px-3 py-2 text-sm font-semibold text-[#24466f] transition hover:border-blue-300 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Export CSV
                  </button>
                </div>
              </div>
            </div>

            <div className="space-y-5 p-4 sm:p-6">
              {/* Safety guardrail inventory — descriptions of implemented prototype rules, not external certification. */}
              <div>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-sm font-bold text-navy">Safety guardrails</h4>
                  <span className="text-[11px] text-muted">Configured prototype rules · not a medical certification</span>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-3.5">
                    <div className="flex items-center gap-2 text-sm font-semibold text-amber-900"><span>🛡️</span> Prescription gate</div>
                    <p className="mt-1.5 text-xs leading-5 text-amber-900/80">Schedule H checks run before medicine details, price comparisons, alternatives, or other medicine intents.</p>
                    <p className="mt-2 break-words rounded-lg border border-amber-200 bg-white/70 p-2 text-[11px] leading-4 text-amber-950">{PRESCRIPTION_WARNING}</p>
                  </div>
                  <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-3.5">
                    <div className="flex items-center gap-2 text-sm font-semibold text-emerald-900"><span>🔬</span> Alternative checks</div>
                    <p className="mt-1.5 text-xs leading-5 text-emerald-900/80">Candidate alternatives must be marked verified and match active ingredients, strength, and dosage form in the local dataset.</p>
                  </div>
                  <div className="rounded-xl border border-blue-200 bg-blue-50/70 p-3.5">
                    <div className="flex items-center gap-2 text-sm font-semibold text-blue-900"><span>💰</span> Price transparency</div>
                    <p className="mt-1.5 text-xs leading-5 text-blue-900/80">Price responses explicitly identify listings as demo/sample prices, not live pharmacy prices.</p>
                  </div>
                  <div className="rounded-xl border border-violet-200 bg-violet-50/70 p-3.5">
                    <div className="flex items-center gap-2 text-sm font-semibold text-violet-900"><span>🩺</span> Health boundaries</div>
                    <p className="mt-1.5 text-xs leading-5 text-violet-900/80">The prototype avoids diagnosis and personalized treatment recommendations and directs users to qualified professionals.</p>
                  </div>
                </div>
              </div>

              {evalCategories === null ? (
                <div className="rounded-2xl border border-dashed border-[#cddcf2] bg-[#f8fbff] px-5 py-10 text-center">
                  <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-blue-100 bg-white text-2xl shadow-sm">🧪</div>
                  <h4 className="mt-3 text-base font-bold text-navy">Ready to test MediBot</h4>
                  <p className="mx-auto mt-1 max-w-lg text-sm leading-6 text-muted">Run the local test suite to calculate current pass rates, inspect each response, and enable downloadable JSON and CSV reports.</p>
                  <button type="button" onClick={handleRunEvaluation} className="btn-primary mt-4">Run safety evaluation</button>
                </div>
              ) : (
                <>
                  {/* Aggregate metrics are calculated from actual test results. */}
                  <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
                    <div className="rounded-xl border border-[#e4ebf7] bg-white p-4">
                      <p className="text-2xl font-bold tabular-nums text-navy">{evalTotals?.total ?? 0}</p>
                      <p className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-muted">Total test cases</p>
                    </div>
                    <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-4">
                      <p className="text-2xl font-bold tabular-nums text-emerald-700">{evalTotals?.passed ?? 0}</p>
                      <p className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-emerald-800">Passed</p>
                    </div>
                    <div className="rounded-xl border border-rose-200 bg-rose-50/70 p-4">
                      <p className="text-2xl font-bold tabular-nums text-rose-700">{(evalTotals?.total ?? 0) - (evalTotals?.passed ?? 0)}</p>
                      <p className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-rose-800">Failed</p>
                    </div>
                    <div className="rounded-xl border border-blue-200 bg-blue-50/70 p-4">
                      <p className="text-2xl font-bold tabular-nums text-blue-700">{evalPassRate}%</p>
                      <p className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-blue-800">Overall pass rate</p>
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-blue-100">
                        <div className="h-full rounded-full bg-blue-600 transition-all" style={{ width: `${evalPassRate}%` }} />
                      </div>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-[#e4ebf7] bg-[#fbfdff] p-4 sm:p-5">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
                      <label className="min-w-0 flex-1 text-xs font-semibold text-[#41546f]">
                        Search queries and actual responses
                        <input
                          type="search"
                          value={evalSearch}
                          onChange={(event) => setEvalSearch(event.target.value)}
                          placeholder="Try: Alprazolam, price, fever, failed..."
                          className="mt-1.5 w-full rounded-xl border border-[#dbe5f5] bg-white px-3 py-2.5 text-sm font-normal text-navy outline-none transition placeholder:text-slate-400 focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10"
                        />
                      </label>
                      <label className="text-xs font-semibold text-[#41546f] lg:w-52">
                        Category
                        <select value={evalCategoryFilter} onChange={(event) => setEvalCategoryFilter(event.target.value)} className="mt-1.5 w-full rounded-xl border border-[#dbe5f5] bg-white px-3 py-2.5 text-sm font-normal text-navy outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10">
                          <option value="all">All categories</option>
                          {evalCategories.map((category) => <option key={category.key} value={category.key}>{category.title}</option>)}
                        </select>
                      </label>
                      <div className="flex flex-wrap gap-1.5" aria-label="Filter tests by status">
                        {([
                          ["all", "All results"],
                          ["passed", "Passed"],
                          ["failed", "Failed only"],
                        ] as const).map(([value, label]) => (
                          <button key={value} type="button" onClick={() => setEvalStatusFilter(value)} aria-pressed={evalStatusFilter === value} className={"rounded-xl border px-3 py-2.5 text-xs font-semibold transition " + (evalStatusFilter === value ? "border-blue-600 bg-blue-600 text-white" : "border-[#dbe5f5] bg-white text-[#41546f] hover:border-blue-300 hover:bg-blue-50")}>{label}</button>
                        ))}
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[#e8eef8] pt-3">
                      <p className="text-xs text-muted">Showing <strong className="text-navy">{visibleEvalTestCount}</strong> of {evalTotals?.total ?? 0} test cases</p>
                      <button type="button" onClick={() => { setEvalSearch(""); setEvalStatusFilter("all"); setEvalCategoryFilter("all"); }} className="text-xs font-semibold text-blue-700 hover:text-blue-900">Reset filters</button>
                    </div>
                  </div>

                  <div className="space-y-3">
                    {filteredEvalCategories.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-[#dbe5f5] bg-white px-4 py-8 text-center text-sm text-muted">No test cases match the current filters. Try a different search or reset the filters.</div>
                    ) : filteredEvalCategories.map((category) => {
                      const originalCategory = evalCategories.find((item) => item.key === category.key)!;
                      const passRate = originalCategory.total === 0 ? 0 : Math.round((originalCategory.passed / originalCategory.total) * 100);
                      const isPass = originalCategory.passed === originalCategory.total;
                      const checkDescription: Record<string, string> = {
                        restricted: "Checks that Schedule H queries include the required prescription warning and do not reveal composition, alternatives, or pricing.",
                        medicine: "Checks that supported medicine questions return a recognized medicine and its active-composition field.",
                        health: "Checks that supported health-education questions produce a substantive response without being misrouted to an unknown-medicine response.",
                        alternatives: "Checks that displayed candidates meet the local verification flag, active-ingredient, strength, and dosage-form conditions.",
                        price: "Checks that price queries return comparison output with the explicit demo-price notice.",
                        unknown: "Checks that an unknown medicine is not assigned an invented composition.",
                        intent: "Checks selected examples route to the expected response type, including treatment requests and restricted medicines.",
                      };
                      return (
                        <article key={category.key} className="overflow-hidden rounded-2xl border border-[#e1e9f6] bg-white">
                          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <h5 className="text-sm font-bold text-navy">{category.icon} {category.title}</h5>
                                <span className={"rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider " + (isPass ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700")}>{isPass ? "All passing" : "Needs review"}</span>
                              </div>
                              <p className="mt-1.5 text-xs leading-5 text-muted">{checkDescription[category.key] ?? "Checks a predefined response condition."}</p>
                              <div className="mt-3 h-1.5 max-w-md overflow-hidden rounded-full bg-[#e8eefb]">
                                <div className={"h-full rounded-full transition-all " + (isPass ? "bg-emerald-500" : "bg-rose-500")} style={{ width: `${passRate}%` }} />
                              </div>
                            </div>
                            <div className="shrink-0 text-left sm:text-right">
                              <p className={"text-xl font-bold tabular-nums " + (isPass ? "text-emerald-600" : "text-rose-600")}>{originalCategory.passed}/{originalCategory.total}</p>
                              <p className="text-[11px] text-muted">{passRate}% passed</p>
                            </div>
                          </div>
                          <div className="border-t border-[#eef2fa] bg-[#fbfdff] p-3 sm:p-4">
                            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted">Test-case evidence ({category.tests.length} visible)</p>
                            <div className="space-y-2">
                              {category.tests.map((test, testIndex) => (
                                <details key={`${category.key}-${test.query}-${testIndex}`} className="group rounded-xl border border-[#e4ebf7] bg-white">
                                  <summary className="flex cursor-pointer list-none items-start gap-2.5 p-3 [&::-webkit-details-marker]:hidden">
                                    <span className={"mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold " + (test.passed ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700")}>{test.passed ? "✓" : "!"}</span>
                                    <span className="min-w-0 flex-1">
                                      <span className="block break-words text-xs font-semibold text-[#24466f]">{test.query}</span>
                                      <span className={"mt-1 block text-[10px] font-bold uppercase tracking-wider " + (test.passed ? "text-emerald-700" : "text-rose-700")}>{test.passed ? "PASS — assertion matched" : "FAIL — review required"}</span>
                                    </span>
                                    <span className="shrink-0 text-xs text-muted transition group-open:rotate-180">⌄</span>
                                  </summary>
                                  <div className="space-y-2 border-t border-[#eef2fa] px-3 pb-3 pt-2.5">
                                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Actual MediBot response</p>
                                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[#f6f9ff] p-3 font-sans text-xs leading-5 text-[#294363]">{test.actual || "(empty response)"}</pre>
                                    {!test.passed && <p className="rounded-lg border border-rose-200 bg-rose-50 p-2 text-xs leading-5 text-rose-800">Action: review this case before presenting the prototype. Do not treat a passing result in other cases as proof of clinical safety.</p>}
                                  </div>
                                </details>
                              ))}
                            </div>
                          </div>
                        </article>
                      );
                    })}
                  </div>

                  <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-3.5">
                    <p className="text-xs font-semibold text-amber-900">Interpret results responsibly</p>
                    <p className="mt-1 text-xs leading-5 text-amber-900/80">These tests exercise selected deterministic prototype examples only. They are not clinical validation, do not establish a real-world 100% block rate, and cannot verify the clinical appropriateness of medicine data or pharmacy prices.</p>
                  </div>
                </>
              )}
            </div>
          </section>
        </main>

        {/* RIGHT SIDEBAR (wide screens) */}
        <aside
          aria-label="Quick information"
          className="sticky top-16 hidden w-56 shrink-0 space-y-4 self-start py-5 lg:block xl:w-64 2xl:w-72"
        >
          {/* Quick Actions */}
          <div className="card p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
              Quick Actions
            </h3>

            <div className="mt-3 space-y-1">
              {QUICK_ACTIONS.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  onClick={() => populateQuery(action.query)}
                  className="side-link text-[13px]"
                >
                  <Icon
                    name={action.icon}
                    className="h-4 w-4 shrink-0 text-blue-600"
                  />
                  <span className="truncate">{action.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Evaluation Summary — actual existing results only */}
          <div className="card p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
              Evaluation Summary
            </h3>

            {evalTotals === null ? (
              <div className="mt-2.5">
                <p className="text-xs leading-5 text-muted">
                  Automated tests have not been run yet.
                </p>
                <button
                  type="button"
                  onClick={handleRunEvaluation}
                  className="btn-primary mt-3 w-full"
                >
                  Run Evaluation
                </button>
              </div>
            ) : (
              <div className="mt-2.5">
                <p className="text-2xl font-bold leading-none text-navy">
                  {evalTotals.passed}
                  <span className="text-sm font-medium text-muted">
                    /{evalTotals.total} passing
                  </span>
                </p>

                <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-[#e8eefb]">
                  <div
                    className="h-full rounded-full bg-emerald-500 transition-all"
                    style={{ width: `${evalPassRate}%` }}
                  />
                </div>
                <p className="mt-1.5 text-xs font-medium text-emerald-600">
                  {evalPassRate}% pass rate
                </p>

                <ul className="mt-3 space-y-1.5 border-t border-[#eef2fa] pt-3">
                  {evalCategories?.map((category) => (
                    <li
                      key={category.key}
                      className="flex items-center justify-between gap-2 text-xs"
                    >
                      <span className="min-w-0 truncate text-[#41546f]">
                        {category.icon} {category.title}
                      </span>
                      <span
                        className={
                          "shrink-0 font-medium " +
                          (category.passed === category.total
                            ? "text-emerald-600"
                            : "text-rose-600")
                        }
                      >
                        {category.passed}/{category.total}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Medical disclaimer (full required text) */}
          <div className="rounded-2xl border border-amber-200 bg-amber-50/80 p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-amber-700">
              Medical Disclaimer
            </h3>
            <p className="mt-2 text-xs leading-5 text-amber-900/90">
              MediBot is an informational tool. It does not diagnose medical
              conditions or prescribe medications. Users must always consult a
              qualified medical professional before taking any medication.
            </p>
          </div>
        </aside>
      </div>

      {/* FOOTER — full disclaimer stays visible on every screen size */}
      <footer className="border-t border-[#e4ebf7] bg-white/70">
        <div className="mx-auto max-w-[1680px] px-4 py-6 sm:px-6">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">
            Important Medical Disclaimer
          </p>
          <p className="mt-1.5 max-w-3xl text-xs leading-5 text-muted">
            MediBot is an informational tool. It does not diagnose medical
            conditions or prescribe medications. Users must always consult a
            qualified medical professional before taking any medication.
          </p>

          {/* Team credits */}
          <section
            aria-labelledby="team-doomsday-heading"
            className="mt-6 rounded-2xl border border-[#dbe7fb] bg-gradient-to-br from-blue-50 via-white to-indigo-50 p-4 sm:p-5"
          >
            <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-blue-700">
                  Built by
                </p>
                <h2 id="team-doomsday-heading" className="mt-1 text-lg font-extrabold tracking-tight text-navy sm:text-xl">
                  Team DOOMSDAY
                </h2>
              </div>
              <p className="text-xs font-medium text-muted">MediBot · A Health Assistant</p>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <article className="rounded-xl border border-[#e3eaf7] bg-white/90 p-3.5 shadow-sm">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Team Member 01</p>
                <h3 className="mt-1 text-sm font-bold text-navy">Nikunj Garg</h3>
                <p className="mt-1 text-xs text-muted">Roll No. <span className="font-semibold tabular-nums text-slate-700">260102236</span></p>
              </article>
              <article className="rounded-xl border border-[#e3eaf7] bg-white/90 p-3.5 shadow-sm">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Team Member 02</p>
                <h3 className="mt-1 text-sm font-bold text-navy">Tejas Damkondwar</h3>
                <p className="mt-1 text-xs text-muted">Roll No. <span className="font-semibold tabular-nums text-slate-700">260106069</span></p>
              </article>
              <article className="rounded-xl border border-[#e3eaf7] bg-white/90 p-3.5 shadow-sm">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Team Member 03</p>
                <h3 className="mt-1 text-sm font-bold text-navy">Dhruv Choudhary</h3>
                <p className="mt-1 text-xs text-muted">Roll No. <span className="font-semibold tabular-nums text-slate-700">260106023</span></p>
              </article>
            </div>
          </section>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-[#eef2fa] pt-4 text-[11px] text-muted">
            <span>
              MediBot • Informational tool • Not a substitute for professional
              medical advice
            </span>
            <span>Demo dataset • Sample prices only</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

/* ----------------------------- Smart Savings Calculator ----------------------------- */

/**
 * Compares demo pharmacy prices for curated OTC products. Dataset-only products
 * can appear as catalogue-reference entries, but no saving or pharmacy comparison
 * is calculated for them. Known Schedule H products stay excluded.
 */
function SmartSavingsCalculator({
  medicineList,
}: {
  medicineList: Medicine[];
}) {
  const calculatorMedicines = medicineList.filter((medicine) =>
    medicine.schedule === "OTC" ||
    (medicine.schedule === "Unverified" && medicine.datasetPrice != null)
  );
  const [selectedMedicineName, setSelectedMedicineName] = useState<string>(() => {
    const preferred = calculatorMedicines.find((medicine) =>
      medicine.schedule === "OTC" && /crocin\s*650/i.test(medicine.name)
    );
    return preferred?.name ?? calculatorMedicines[0]?.name ?? "";
  });

  const selectedMedicine = calculatorMedicines.find(
    (medicine) => medicine.name === selectedMedicineName
  );
  const allListings = selectedMedicine
    ? [...selectedMedicine.priceComparison].sort((a, b) => a.price - b.price)
    : [];
  const inStockListings = allListings.filter((listing) => listing.inStock);
  const lowestListing = inStockListings[0];
  const highestListing = inStockListings[inStockListings.length - 1];
  const potentialSavings =
    lowestListing && highestListing
      ? Math.max(0, highestListing.price - lowestListing.price)
      : null;

  const verifiedOptions = selectedMedicine
    ? findVerifiedAlternatives(selectedMedicine)
        .filter((candidate) => candidate.schedule === "OTC")
        .map((medicine) => ({
          medicine,
          listings: [...medicine.priceComparison]
            .filter((listing) => listing.inStock)
            .sort((a, b) => a.price - b.price),
        }))
        .filter((option) => option.listings.length > 0)
    : [];

  const formatINR = (amount: number) =>
    new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: "INR",
      maximumFractionDigits: 2,
    }).format(amount);

  return (
    <section
      id="savings-calculator"
      aria-label="Smart savings calculator"
      className="card scroll-mt-24 overflow-hidden"
    >
      <div className="border-b border-[#e4ebf7] bg-gradient-to-r from-white via-emerald-50/70 to-blue-50/70 p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-emerald-200 bg-emerald-50 text-xl text-emerald-700">
            ₹
          </div>
          <div className="min-w-0 flex-1">
            <div className="inline-flex rounded-full border border-emerald-200 bg-white px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-emerald-700">
              Price transparency tool
            </div>
            <h3 className="mt-2 text-lg font-bold tracking-tight text-navy sm:text-xl">
              Smart Savings Calculator
            </h3>
            <p className="mt-1 max-w-2xl text-sm leading-5 text-muted">
              Compare sample pharmacy prices for curated OTC entries. Dataset-only records can show their reference price and manufacturer, but savings are not calculated without comparable pharmacy listings. Known Schedule H products are excluded.
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-5 p-4 sm:p-6">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <label className="min-w-0 text-xs font-semibold text-[#41546f]">
            Choose a medicine or dataset reference entry
            <select
              value={selectedMedicineName}
              onChange={(event) => setSelectedMedicineName(event.target.value)}
              disabled={calculatorMedicines.length === 0}
              className="mt-1.5 w-full rounded-xl border border-[#dbe5f5] bg-white px-3 py-3 text-sm font-normal text-navy outline-none transition focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:cursor-not-allowed disabled:bg-slate-50"
            >
              {calculatorMedicines.length === 0 ? (
                <option value="">No priced catalogue entries available</option>
              ) : (
                calculatorMedicines.map((medicine) => (
                  <option key={medicine.name} value={medicine.name}>
                    {medicine.name}{medicine.schedule === "Unverified" ? " — reference only / status unverified" : ""}
                  </option>
                ))
              )}
            </select>
          </label>
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-3 text-xs text-emerald-900">
            <span className="font-semibold">Data mode:</span> demo/sample only
          </div>
        </div>

        {!selectedMedicine ? (
          <div className="rounded-xl border border-dashed border-[#dbe5f5] bg-[#f8fbff] p-5 text-sm text-muted">
            No priced catalogue entry is available in the current dataset. Ask MediBot about a medicine to load its dataset row.
          </div>
        ) : selectedMedicine.schedule === "Unverified" ? (
          <div className="rounded-2xl border border-amber-200 bg-amber-50/70 p-5">
            <div className="text-xs font-bold uppercase tracking-wider text-amber-900">Catalogue reference only · classification unverified</div>
            <h4 className="mt-2 text-base font-bold text-navy">{selectedMedicine.name}</h4>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-xl border border-amber-200 bg-white p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">A–Z reference price</p>
                <p className="mt-1 text-lg font-bold text-navy">{selectedMedicine.datasetPrice != null ? formatINR(selectedMedicine.datasetPrice) : "Not listed"}</p>
              </div>
              <div className="rounded-xl border border-amber-200 bg-white p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Product type</p>
                <p className="mt-1 text-sm font-semibold text-navy">{selectedMedicine.datasetType || "Not listed"}</p>
              </div>
              <div className="rounded-xl border border-amber-200 bg-white p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Manufacturer</p>
                <p className="mt-1 text-sm font-semibold text-navy">{selectedMedicine.manufacturer || "Not listed"}</p>
              </div>
              <div className="rounded-xl border border-amber-200 bg-white p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Pack size</p>
                <p className="mt-1 text-sm font-semibold text-navy">{selectedMedicine.packSize || "Not listed"}</p>
              </div>
            </div>
            {selectedMedicine.datasetComposition && <p className="mt-3 text-xs leading-5 text-amber-950"><strong>Composition as listed:</strong> {selectedMedicine.datasetComposition} <span className="block">Source-listed text, not independently verified.</span></p>}
            <p className="mt-3 text-xs leading-5 text-amber-950">No pharmacy comparison or savings estimate is available for this entry. The reference price is not live. Confirm the actual pack and prescription classification with a qualified pharmacist. MediBot will not suggest alternatives until equivalence and classification are verified.</p>
          </div>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-4">
                <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-800">
                  Lowest in-stock listing
                </p>
                <p className="mt-2 text-xl font-bold tabular-nums text-emerald-800">
                  {lowestListing ? formatINR(lowestListing.price) : "—"}
                </p>
                <p className="mt-1 text-xs text-emerald-900/80">
                  {lowestListing?.platform ?? "No in-stock listing"}
                </p>
              </div>
              <div className="rounded-xl border border-[#e4ebf7] bg-white p-4">
                <p className="text-[10px] font-bold uppercase tracking-wider text-muted">
                  Highest in-stock listing
                </p>
                <p className="mt-2 text-xl font-bold tabular-nums text-navy">
                  {highestListing ? formatINR(highestListing.price) : "—"}
                </p>
                <p className="mt-1 text-xs text-muted">
                  {highestListing?.platform ?? "No in-stock listing"}
                </p>
              </div>
              <div className="rounded-xl border border-blue-200 bg-blue-50/70 p-4">
                <p className="text-[10px] font-bold uppercase tracking-wider text-blue-800">
                  Potential price difference
                </p>
                <p className="mt-2 text-xl font-bold tabular-nums text-blue-800">
                  {potentialSavings === null ? "—" : formatINR(potentialSavings)}
                </p>
                <p className="mt-1 text-xs text-blue-900/80">
                  Highest minus lowest in-stock sample listing
                </p>
              </div>
            </div>

            <div className="overflow-hidden rounded-xl border border-[#e4ebf7]">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#e4ebf7] bg-[#f8fbff] px-4 py-3">
                <h4 className="text-sm font-bold text-navy">
                  Pharmacy listing comparison
                </h4>
                <span className="text-[11px] text-muted">
                  {allListings.length} sample listing{allListings.length === 1 ? "" : "s"}
                </span>
              </div>
              {allListings.length === 0 ? (
                <p className="p-4 text-sm text-muted">
                  No demo prices are available for this medicine.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[540px] text-left text-sm">
                    <thead className="bg-white text-[10px] uppercase tracking-wider text-muted">
                      <tr>
                        <th className="px-4 py-3 font-semibold">Platform</th>
                        <th className="px-4 py-3 font-semibold">Sample price</th>
                        <th className="px-4 py-3 font-semibold">Availability</th>
                        <th className="px-4 py-3 font-semibold">Delivery estimate</th>
                        <th className="px-4 py-3 font-semibold">Difference vs lowest</th>
                      </tr>
                    </thead>
                    <tbody>
                      {allListings.map((listing, index) => {
                        const gap =
                          listing.inStock && lowestListing
                            ? Math.max(0, listing.price - lowestListing.price)
                            : null;
                        return (
                          <tr
                            key={`${listing.platform}-${listing.price}-${index}`}
                            className="border-t border-[#eef2fa]"
                          >
                            <td className="px-4 py-3 font-semibold text-navy">
                              {listing.platform}
                              {listing.inStock && lowestListing === listing && (
                                <span className="ml-2 inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-[9px] font-bold text-emerald-800">
                                  LOWEST
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-3 font-semibold tabular-nums text-navy">
                              {formatINR(listing.price)}
                            </td>
                            <td className="px-4 py-3">
                              <span className={"inline-flex rounded-full px-2 py-1 text-[10px] font-semibold " + (listing.inStock ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600")}>
                                {listing.inStock ? "In stock (demo)" : "Out of stock (demo)"}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-xs text-muted">
                              {listing.delivery || "Not listed"}
                            </td>
                            <td className="px-4 py-3 tabular-nums text-muted">
                              {gap === null ? "—" : formatINR(gap)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="rounded-xl border border-[#e4ebf7] bg-white p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h4 className="text-sm font-bold text-navy">
                    Composition-matched OTC alternatives
                  </h4>
                  <p className="mt-1 text-xs leading-5 text-muted">
                    Only candidates passing the app&apos;s local ingredient, strength, dosage-form, and verification checks are shown.
                  </p>
                </div>
                <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[10px] font-semibold text-emerald-700">
                  Dataset checks only
                </span>
              </div>

              {verifiedOptions.length === 0 ? (
                <p className="mt-3 rounded-lg bg-[#f8fbff] p-3 text-xs leading-5 text-muted">
                  No eligible composition-matched OTC alternative with an in-stock sample price was found. MediBot will not invent an alternative or estimate a saving for one.
                </p>
              ) : (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {verifiedOptions.map(({ medicine, listings }) => (
                    <div key={medicine.name} className="rounded-xl border border-emerald-100 bg-emerald-50/40 p-3.5">
                      <p className="text-sm font-semibold text-navy">{medicine.name}</p>
                      <p className="mt-1 text-xs leading-5 text-muted">
                        {medicine.activeIngredients.join(" + ")} · {medicine.strength} · {medicine.dosageForm}
                      </p>
                      <div className="mt-3 flex flex-wrap items-end justify-between gap-2">
                        <div>
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Lowest in-stock sample price</p>
                          <p className="mt-0.5 text-lg font-bold text-emerald-800">{formatINR(listings[0].price)}</p>
                        </div>
                        <span className="text-[10px] font-semibold text-emerald-700">{listings[0].platform}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-3.5">
          <p className="text-xs font-semibold text-amber-900">Important price and medicine notice</p>
          <p className="mt-1 text-xs leading-5 text-amber-900/80">
            Prices, availability, and delivery details are demo/sample data and are not live pharmacy offers. The displayed price difference is arithmetic on these sample listings, not a guaranteed saving. Matching dataset fields do not establish clinical interchangeability; ask a doctor or pharmacist before changing medicines.
          </p>
        </div>
      </div>
    </section>
  );
}

/* ----------------------- Hindi intent + reply helpers ----------------------- */
/** Deterministic local Hindi phrase normalization. Brand names are expected in Latin script. */
function normalizeHindiQuery(input: string): string {
  let value = input.toLowerCase();
  const replacements: Array<[RegExp, string]> = [
    [/नमस्ते|नमस्कार/g, " hello "],
    [/धन्यवाद|शुक्रिया/g, " thank you "],
    [/आप कैसे हैं|कैसे हो/g, " how are you "],
    [/अलविदा|फिर मिलेंगे/g, " goodbye "],
    [/आप क्या कर सकते हैं|आप कैसे मदद कर सकते हैं|मदद करें|मदद/g, " what can you do "],
    [/क्या आप डॉक्टर हैं/g, " are you a doctor "],
    [/की कीमत क्या है|की कीमत|का दाम क्या है|का दाम|कितने का है|कितनी कीमत है/g, " price "],
    [/सस्ता विकल्प|सस्ता विकल्प बताओ|विकल्प बताओ|विकल्प|के बदले/g, " alternative "],
    [/तुलना करो|तुलना|की तुलना|में अंतर/g, " compare "],
    [/क्या है|कौन सी दवा है|बताइए|बताओ|समझाओ/g, " what is "],
    [/बुखार/g, " fever "], [/पानी की कमी|निर्जलीकरण/g, " dehydration "],
    [/एंटीबायोटिक प्रतिरोध/g, " antibiotic resistance "], [/एंटीबायोटिक/g, " antibiotic "],
    [/दवा|दवाई|मेडिसिन/g, " medicine "], [/की जानकारी|के बारे में/g, " information about "],
    [/मुझे बताएं|मुझे बताओ/g, " tell me "], [/की कीमत बताएं/g, " price "],
  ];
  for (const [pattern, replacement] of replacements) value = value.replace(pattern, replacement);
  return value.replace(/\s+/g, " ").trim();
}

/** Small, explicit phrasebook; prescription warning remains exactly present in English. */
function translateReplyToHindi(reply: string): string {
  const conversationTranslations: Array<[string, string]> = [
    ["Hello! I'm MediBot, your health companion. I can help with medicine information, demo price comparisons, alternatives listed in the dataset, and general health education. What would you like to explore?", "नमस्ते! मैं MediBot हूँ, आपका स्वास्थ्य सहायक। मैं डेटासेट में मौजूद दवाओं की जानकारी, डेमो कीमतों की तुलना, डेटासेट में सूचीबद्ध विकल्प और सामान्य स्वास्थ्य शिक्षा में मदद कर सकता हूँ। आप क्या जानना चाहेंगे?"],
    ["I'm here and ready to help! You can ask me about a medicine in the dataset, compare demo prices, or explore a general health topic.", "मैं मदद के लिए तैयार हूँ! आप डेटासेट में मौजूद दवा के बारे में पूछ सकते हैं, डेमो कीमतों की तुलना कर सकते हैं या सामान्य स्वास्थ्य विषय जान सकते हैं।"],
    ["You're welcome! I'm glad I could help. Remember, I provide information only and cannot diagnose or prescribe.", "आपका स्वागत है! मदद करके खुशी हुई। याद रखें, मैं केवल जानकारी देता हूँ; बीमारी का निदान या दवा का प्रिस्क्रिप्शन नहीं दे सकता।"],
    ["Goodbye! Take care. For personal medical concerns, please consult a qualified healthcare professional.", "अलविदा! अपना ध्यान रखें। व्यक्तिगत चिकित्सा संबंधी चिंता के लिए योग्य स्वास्थ्य पेशेवर से सलाह लें।"],
    ["No. I'm an informational assistant, not a doctor. I can't diagnose conditions, prescribe medicines, or replace advice from a qualified healthcare professional.", "नहीं। मैं जानकारी देने वाला सहायक हूँ, डॉक्टर नहीं। मैं बीमारी का निदान या दवा का प्रिस्क्रिप्शन नहीं दे सकता और योग्य स्वास्थ्य पेशेवर की सलाह का विकल्प नहीं हूँ।"],
    ["I'm MediBot, an informational pharmacy assistant. I can look up entries in my medicine dataset, compare demo prices, check dataset-listed alternatives, and answer a limited set of general health-education questions.", "मैं MediBot हूँ, एक जानकारी देने वाला फार्मेसी सहायक। मैं अपने दवा डेटासेट की प्रविष्टियाँ देख सकता हूँ, डेमो कीमतों की तुलना कर सकता हूँ, डेटासेट में सूचीबद्ध विकल्प दिखा सकता हूँ और कुछ सामान्य स्वास्थ्य-शिक्षा प्रश्नों के उत्तर दे सकता हूँ।"],
    ["I can help with medicine information from the current dataset, demo pharmacy price comparisons, eligible dataset-listed alternatives, basic health education, reminders, and your medicine cabinet. Try: 'What is Crocin 650?', 'Price of Crocin 650', or 'What is fever?'.", "मैं मौजूदा डेटासेट की दवा जानकारी, डेमो फार्मेसी कीमतों की तुलना, डेटासेट में उपलब्ध पात्र विकल्प, सामान्य स्वास्थ्य शिक्षा, रिमाइंडर और आपकी दवा सूची में मदद कर सकता हूँ। पूछें: 'What is Crocin 650?', 'Price of Crocin 650' या 'What is fever?'."],
    ["Glad to hear that! What would you like to explore today—medicine information, a demo price comparison, or a general health topic?", "यह सुनकर अच्छा लगा! आज आप क्या जानना चाहेंगे—दवा की जानकारी, डेमो कीमतों की तुलना या कोई सामान्य स्वास्थ्य विषय?"],
  ];
  for (const [english, hindi] of conversationTranslations) {
    if (reply === english) return hindi;
  }
  if (reply.includes(PRESCRIPTION_WARNING)) {
    return `⚠️ ${PRESCRIPTION_WARNING}\n\nइस दवा के लिए वैध प्रिस्क्रिप्शन आवश्यक है। कृपया अपने डॉक्टर से सलाह लें।`;
  }
  if (reply.includes("Fever is a temporary increase in body temperature.")) {
    return "बुखार शरीर के तापमान में अस्थायी वृद्धि है। यह संक्रमण या अन्य कारणों के प्रति शरीर की प्रतिक्रिया हो सकती है। तेज, लगातार या बार-बार आने वाले बुखार के लिए योग्य स्वास्थ्य पेशेवर से सलाह लें।\n\nव्यक्तिगत चिकित्सा सलाह के लिए योग्य स्वास्थ्य पेशेवर से संपर्क करें।";
  }
  if (reply.includes("Dehydration occurs when the body loses more fluid")) {
    return "निर्जलीकरण तब होता है जब शरीर में जाने वाले तरल की तुलना में अधिक तरल खो जाता है। प्यास, मुँह सूखना और पेशाब कम होना सामान्य संकेत हो सकते हैं। गंभीर या लगातार लक्षण होने पर स्वास्थ्य पेशेवर से संपर्क करें।\n\nव्यक्तिगत चिकित्सा सलाह के लिए योग्य स्वास्थ्य पेशेवर से संपर्क करें।";
  }
  if (reply.includes("Antibiotics are medicines used to treat bacterial infections.")) {
    return "एंटीबायोटिक दवाएँ बैक्टीरिया से होने वाले संक्रमणों के इलाज के लिए उपयोग की जाती हैं। वे वायरस से होने वाली बीमारियों जैसे अधिकांश सर्दी-जुकाम और फ्लू पर काम नहीं करतीं। एंटीबायोटिक का उपयोग केवल योग्य चिकित्सा पेशेवर की सलाह पर करें।\n\nव्यक्तिगत चिकित्सा सलाह के लिए योग्य स्वास्थ्य पेशेवर से संपर्क करें।";
  }
  if (reply.includes("I can provide general health information, but I can't diagnose")) {
    return "मैं सामान्य स्वास्थ्य जानकारी दे सकता हूँ, लेकिन आपकी बीमारी का निदान या दवा का प्रिस्क्रिप्शन नहीं दे सकता। व्यक्तिगत सलाह के लिए योग्य स्वास्थ्य पेशेवर से संपर्क करें।";
  }
  if (reply.includes("Some symptoms can be serious")) {
    return "कुछ लक्षण गंभीर हो सकते हैं और मैं यहाँ उनका आकलन या निदान नहीं कर सकता। कृपया जल्द ही योग्य स्वास्थ्य पेशेवर या स्थानीय आपातकालीन सेवाओं से संपर्क करें।";
  }
  if (reply.includes("Sorry, I couldn't find this medicine")) {
    return "क्षमा करें, यह दवा हमारे डेटाबेस में नहीं मिली। आप डेटासेट में उपलब्ध किसी दवा का नाम अंग्रेज़ी में लिखकर पूछ सकते हैं।";
  }
  // Translate familiar field labels without altering medicine names/data values.
  const labels: Array<[string, string]> = [
    ["Active composition:", "सक्रिय संघटन:"], ["Category:", "श्रेणी:"],
    ["MRP:", "अधिकतम खुदरा मूल्य (MRP):"], ["Schedule: Schedule H (prescription required)", "श्रेणी: Schedule H (प्रिस्क्रिप्शन आवश्यक)"],
    ["Schedule: OTC (no prescription required)", "श्रेणी: OTC (प्रिस्क्रिप्शन आवश्यक नहीं)"],
    ["This is general medication information. Please consult a qualified medical professional before taking any medication.", "यह सामान्य दवा-संबंधी जानकारी है। कोई भी दवा लेने से पहले योग्य चिकित्सा पेशेवर से सलाह लें."],
    ["Price comparison for", "कीमत की तुलना:"], ["(demo data)", "(डेमो डेटा)"],
    ["Demo/sample prices — not live pharmacy prices.", "डेमो/नमूना कीमतें — ये लाइव फार्मेसी कीमतें नहीं हैं."],
    ["Lowest listed price:", "सबसे कम सूचीबद्ध कीमत:"], ["Potential saving:", "संभावित अंतर:"],
    ["Active ingredient:", "सक्रिय घटक:"], ["Strength:", "ताकत:"], ["Dosage form:", "दवा का रूप:"],
    ["Composition-equivalent alternatives found:", "समान संरचना वाले विकल्प मिले:"],
    ["No composition-equivalent alternative was found in the verified database.", "सत्यापित डेटाबेस में समान संरचना वाला कोई विकल्प नहीं मिला."],
    ["In stock", "स्टॉक में"], ["Out of stock", "स्टॉक में नहीं"], ["Delivery:", "डिलीवरी:"],
    ["This comparison is for general information only. Consult a qualified healthcare professional before choosing or switching medicines.", "यह तुलना केवल सामान्य जानकारी के लिए है। दवा चुनने या बदलने से पहले योग्य स्वास्थ्य पेशेवर से सलाह लें."],
  ];
  let translated = reply;
  for (const [source, target] of labels) translated = translated.split(source).join(target);
  return translated;
}

/* ----------------------------- My Medicine Cabinet ----------------------------- */
type CabinetEntry = { name: string; addedAt: number };

function MyMedicineCabinet({ medicineList, language }: { medicineList: Medicine[]; language: "en" | "hi" }) {
  const [cabinet, setCabinet] = useState<CabinetEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedName, setSelectedName] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("medibot-cabinet-v1");
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          // Hydration-safe: the cabinet must stay empty on the server render
          // and be populated after mount, so this setState is intentional.
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setCabinet(parsed.filter((item): item is CabinetEntry =>
            item && typeof item.name === "string" && typeof item.addedAt === "number" && medicineList.some((med) => med.name === item.name)
          ));
        }
      }
    } catch {
      setNotice(language === "hi" ? "स्थानीय सूची नहीं पढ़ी जा सकी।" : "Could not read the local cabinet.");
    } finally {
      setLoaded(true);
    }
  }, [language, medicineList]);

  useEffect(() => {
    if (!loaded) return;
    try { window.localStorage.setItem("medibot-cabinet-v1", JSON.stringify(cabinet)); }
    // Writing storage is the effect's job; the notice setState only happens on
    // a genuine storage failure, so no render cascade is triggered in practice.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    catch { setNotice(language === "hi" ? "ब्राउज़र स्टोरेज उपलब्ध नहीं है।" : "Browser storage is unavailable."); }
  }, [cabinet, loaded, language]);

  function addMedicine() {
    if (!selectedName || cabinet.some((entry) => entry.name === selectedName)) return;
    setCabinet((old) => [...old, { name: selectedName, addedAt: Date.now() }]);
    setNotice(language === "hi" ? "दवा आपकी स्थानीय सूची में जोड़ दी गई।" : "Medicine added to your local cabinet.");
  }

  return (
    <section id="cabinet" className="card scroll-mt-24 overflow-hidden" aria-label="My medicine cabinet">
      <div className="border-b border-[#e4ebf7] bg-gradient-to-r from-white to-blue-50/70 p-5 sm:p-6">
        <p className="text-xs font-semibold uppercase tracking-wider text-blue-700">{language === "hi" ? "व्यक्तिगत सूची" : "Personal workspace"}</p>
        <h3 className="mt-1 text-xl font-bold text-navy">{language === "hi" ? "मेरी दवा कैबिनेट" : "My Medicine Cabinet"}</h3>
        <p className="mt-1 text-sm leading-5 text-muted">{language === "hi" ? "अपने लिए दवाओं के नाम इस ब्राउज़र में सहेजें।" : "Keep a personal list of medicines in this browser only."}</p>
      </div>
      <div className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-col gap-2 sm:flex-row">
          <select value={selectedName} onChange={(e) => setSelectedName(e.target.value)} aria-label="Choose a medicine" className="min-w-0 flex-1 rounded-xl border border-[#dbe5f5] bg-white px-3 py-2.5 text-sm text-navy">
            <option value="">{language === "hi" ? "डेटासेट से दवा चुनें" : "Choose a medicine from the dataset"}</option>
            {medicineList.filter((medicine) => medicine.schedule !== "Unverified").map((medicine) => <option key={medicine.name} value={medicine.name}>{medicine.name}{medicine.schedule === "Schedule H" ? " · Prescription required" : ""}</option>)}
          </select>
          <button type="button" onClick={addMedicine} disabled={!selectedName || cabinet.some((entry) => entry.name === selectedName)} className="btn-primary disabled:cursor-not-allowed disabled:opacity-40">{language === "hi" ? "सूची में जोड़ें" : "Add to cabinet"}</button>
        </div>
        {notice && <p role="status" className="text-xs text-muted">{notice}</p>}
        {cabinet.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[#dbe5f5] bg-[#f8fbff] p-6 text-center text-sm text-muted">{language === "hi" ? "आपकी कैबिनेट खाली है। ऊपर से कोई दवा जोड़ें।" : "Your cabinet is empty. Add a medicine above to get started."}</div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {cabinet.map((entry) => {
              const medicine = medicineList.find((item) => item.name === entry.name);
              if (!medicine) return null;
              const restricted = medicine.schedule === "Schedule H";
              return (
                <article key={entry.name} className="rounded-xl border border-[#e4ebf7] bg-white p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0"><h4 className="break-words text-sm font-semibold text-navy">{medicine.name}</h4><p className="mt-1 text-[11px] text-muted">{language === "hi" ? "जोड़ा गया" : "Added"}: {new Date(entry.addedAt).toLocaleDateString()}</p></div>
                    <span className={"shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold " + (restricted ? "bg-amber-50 text-amber-800" : "bg-emerald-50 text-emerald-700")}>{restricted ? "Schedule H" : "OTC"}</span>
                  </div>
                  {restricted && <p className="mt-2 rounded-lg bg-amber-50 p-2 text-[11px] leading-4 text-amber-900">{language === "hi" ? "प्रिस्क्रिप्शन आवश्यक।" : "Valid prescription required. Keep following your prescriber's instructions."}</p>}
                  <button type="button" onClick={() => { setCabinet((old) => old.filter((item) => item.name !== entry.name)); setNotice(language === "hi" ? "दवा सूची से हटाई गई।" : "Medicine removed from cabinet."); }} className="mt-3 rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-50">{language === "hi" ? "हटाएँ" : "Remove"}</button>
                </article>
              );
            })}
          </div>
        )}
        <p className="rounded-xl border border-amber-200 bg-amber-50/70 p-3 text-xs leading-5 text-amber-900">{language === "hi" ? "गोपनीयता: नाम इस ब्राउज़र के local storage में रहते हैं, किसी सर्वर पर नहीं भेजे जाते। साझा कंप्यूटर पर इस्तेमाल के बाद हटाएँ। यह सूची चिकित्सा सलाह या खुराक निर्देश नहीं देती।" : "Privacy: names are stored in this browser's local storage and are not uploaded to a server by this feature. Remove entries on shared devices. This list does not provide treatment or dose instructions."}</p>
      </div>
    </section>
  );
}

/* ----------------------------- Enhanced smart reminders ----------------------------- */
type SmartReminder = { id: string; medicineName: string; dueAt: string; status: "pending" | "taken" | "missed" };

function SmartReminderCenter({ medicineList, language }: { medicineList: Medicine[]; language: "en" | "hi" }) {
  const [reminders, setReminders] = useState<SmartReminder[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [medicineName, setMedicineName] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [notice, setNotice] = useState("");
  // Client-clock value is populated in an effect, avoiding Date.now() during prerender.
  const [currentTime, setCurrentTime] = useState(0);
  const notifiedIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("medibot-smart-reminders-v1");
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          // Hydration-safe: reminders must stay empty on the server render and
          // be populated after mount, so this setState is intentional.
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setReminders(parsed.filter((item): item is SmartReminder =>
            item && typeof item.id === "string" && typeof item.medicineName === "string" && typeof item.dueAt === "string" && ["pending", "taken", "missed"].includes(item.status) && medicineList.some((med) => med.name === item.medicineName)
          ));
        }
      }
    } catch { setNotice(language === "hi" ? "रिमाइंडर लोड नहीं हो सके।" : "Could not load saved reminders."); }
    finally { setLoaded(true); }
  }, [language, medicineList]);

  useEffect(() => {
    if (!loaded) return;
    try { window.localStorage.setItem("medibot-smart-reminders-v1", JSON.stringify(reminders)); }
    // Writing storage is the effect's job; the notice setState only happens on
    // a genuine storage failure, so no render cascade is triggered in practice.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    catch { setNotice(language === "hi" ? "ब्राउज़र स्टोरेज उपलब्ध नहीं है।" : "Browser storage is unavailable."); }
  }, [reminders, loaded, language]);

  useEffect(() => {
    if (!loaded) return;
    const checkDue = () => {
      const now = Date.now();
      setCurrentTime(now);
      reminders.forEach((reminder) => {
        const due = new Date(reminder.dueAt).getTime();
        if (reminder.status === "pending" && Number.isFinite(due) && due <= now && !notifiedIds.current.has(reminder.id)) {
          notifiedIds.current.add(reminder.id);
          setNotice(language === "hi" ? `${reminder.medicineName} के रिमाइंडर का समय हो गया है।` : `Reminder due: ${reminder.medicineName}.`);
          if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
            new Notification(language === "hi" ? "MediBot दवा रिमाइंडर" : "MediBot medicine reminder", { body: reminder.medicineName });
          }
        }
      });
    };
    checkDue();
    const timer = window.setInterval(checkDue, 30000);
    return () => window.clearInterval(timer);
  }, [reminders, loaded, language]);

  async function enableNotifications() {
    if (!("Notification" in window)) { setNotice(language === "hi" ? "यह ब्राउज़र नोटिफिकेशन समर्थित नहीं करता।" : "This browser does not support notifications."); return; }
    try {
      const permission = await Notification.requestPermission();
      setNotice(permission === "granted" ? (language === "hi" ? "ब्राउज़र नोटिफिकेशन चालू हैं। टैब खुला रहना चाहिए।" : "Browser notifications enabled. Keep this app tab open for alerts.") : (language === "hi" ? "नोटिफिकेशन अनुमति नहीं मिली।" : "Notification permission was not granted."));
    } catch { setNotice(language === "hi" ? "नोटिफिकेशन सक्रिय नहीं हो सके।" : "Notifications could not be enabled."); }
  }

  function addReminder() {
    if (!medicineName || !dueAt || new Date(dueAt).getTime() <= Date.now()) {
      setNotice(language === "hi" ? "दवा चुनें और भविष्य का समय चुनें।" : "Choose a medicine and a future date/time.");
      return;
    }

    // Explicitly type the new object so TypeScript keeps status as a valid union member.
    const newReminder: SmartReminder = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      medicineName,
      dueAt: new Date(dueAt).toISOString(),
      status: "pending",
    };

    setReminders((old: SmartReminder[]): SmartReminder[] =>
      [...old, newReminder].sort((a, b) => a.dueAt.localeCompare(b.dueAt))
    );
    setMedicineName("");
    setDueAt("");
    setNotice(language === "hi" ? "रिमाइंडर सहेजा गया।" : "Reminder saved.");
  }

  function snooze(reminder: SmartReminder) {
    // Use the currentTime state (kept fresh by the 30s check-due interval,
    // which also runs immediately on mount) instead of Date.now() so this
    // stays compatible with react-hooks/purity. Drift is at most 30 seconds
    // on a 10-minute snooze, which is acceptable for a reminder.
    const newDue = new Date(currentTime + 10 * 60 * 1000).toISOString();
    notifiedIds.current.delete(reminder.id);

    setReminders((old: SmartReminder[]): SmartReminder[] =>
      old
        .map((item): SmartReminder =>
          item.id === reminder.id
            ? { ...item, dueAt: newDue, status: "pending" }
            : item
        )
        .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
    );
    setNotice(language === "hi" ? "रिमाइंडर 10 मिनट के लिए टाल दिया गया।" : "Reminder snoozed for 10 minutes.");
  }

  const pendingCount = reminders.filter((item) => item.status === "pending").length;
  const takenCount = reminders.filter((item) => item.status === "taken").length;
  return (
    <section className="card overflow-hidden" aria-label="Enhanced smart reminder manager">
      <div className="border-b border-[#e4ebf7] bg-gradient-to-r from-white to-indigo-50/70 p-5 sm:p-6">
        <p className="text-xs font-semibold uppercase tracking-wider text-indigo-700">{language === "hi" ? "समय-आधारित अलर्ट" : "Time-based alerts"}</p>
        <h3 className="mt-1 text-xl font-bold text-navy">{language === "hi" ? "स्मार्ट दवा रिमाइंडर" : "Smart Medicine Reminders"}</h3>
        <p className="mt-1 text-sm leading-5 text-muted">{language === "hi" ? "एक बार के रिमाइंडर बनाएँ, पूरा चिह्नित करें या 10 मिनट बाद याद दिलाएँ।" : "Create one-time reminders, mark them taken/missed, or snooze for 10 minutes."}</p>
      </div>
      <div className="space-y-4 p-4 sm:p-5">
        <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
          <select aria-label="Medicine for reminder" value={medicineName} onChange={(e) => setMedicineName(e.target.value)} className="min-w-0 rounded-xl border border-[#dbe5f5] bg-white px-3 py-2.5 text-sm text-navy">
            <option value="">{language === "hi" ? "दवा चुनें" : "Choose medicine"}</option>
            {medicineList.filter((medicine) => medicine.schedule !== "Unverified").map((medicine) => <option key={medicine.name} value={medicine.name}>{medicine.name}{medicine.schedule === "Schedule H" ? " · Rx" : ""}</option>)}
          </select>
          <input aria-label="Reminder date and time" type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} min={currentTime > 0 ? new Date(currentTime + 60000).toISOString().slice(0, 16) : undefined} className="min-w-0 rounded-xl border border-[#dbe5f5] bg-white px-3 py-2.5 text-sm text-navy" />
          <button type="button" onClick={addReminder} className="btn-primary">{language === "hi" ? "रिमाइंडर जोड़ें" : "Add reminder"}</button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-2 text-xs"><span className="rounded-full bg-blue-50 px-3 py-1.5 font-semibold text-blue-700">{language === "hi" ? "बाकी" : "Pending"}: {pendingCount}</span><span className="rounded-full bg-emerald-50 px-3 py-1.5 font-semibold text-emerald-700">{language === "hi" ? "ली गई" : "Taken"}: {takenCount}</span></div>
          <button type="button" onClick={enableNotifications} className="rounded-xl border border-[#d6e2f5] bg-white px-3 py-2 text-xs font-semibold text-[#24466f] hover:bg-blue-50">{language === "hi" ? "नोटिफिकेशन चालू करें" : "Enable browser notifications"}</button>
        </div>
        {notice && <p role="status" className="rounded-lg bg-[#f8fbff] p-3 text-xs text-muted">{notice}</p>}
        {reminders.length === 0 ? <p className="rounded-xl border border-dashed border-[#dbe5f5] bg-[#f8fbff] p-5 text-center text-sm text-muted">{language === "hi" ? "अभी कोई रिमाइंडर नहीं है।" : "No reminders yet. Add one above."}</p> : (
          <div className="space-y-2">
            {reminders.map((reminder) => {
              const due = new Date(reminder.dueAt);
              const isDue = currentTime > 0 && reminder.status === "pending" && due.getTime() <= currentTime;
              return <article key={reminder.id} className="flex flex-col gap-3 rounded-xl border border-[#e4ebf7] bg-white p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0"><p className="break-words text-sm font-semibold text-navy">{reminder.medicineName}</p><p className="mt-1 text-xs text-muted">{due.toLocaleString()} {isDue ? (language === "hi" ? "· समय हो गया" : "· Due now") : ""}</p><span className={"mt-2 inline-flex rounded-full px-2 py-1 text-[10px] font-semibold " + (reminder.status === "taken" ? "bg-emerald-50 text-emerald-700" : reminder.status === "missed" ? "bg-rose-50 text-rose-700" : "bg-blue-50 text-blue-700")}>{reminder.status === "taken" ? (language === "hi" ? "ली गई" : "Taken") : reminder.status === "missed" ? (language === "hi" ? "छूटी" : "Missed") : (language === "hi" ? "बाकी" : "Pending")}</span></div>
                <div className="flex flex-wrap gap-2">
                  {reminder.status !== "taken" && <button type="button" onClick={() => setReminders((old: SmartReminder[]): SmartReminder[] => old.map((item): SmartReminder => item.id === reminder.id ? { ...item, status: "taken" } : item))} className="rounded-lg border border-emerald-200 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-50">{language === "hi" ? "ली गई चिह्नित करें" : "Mark taken"}</button>}
                  {reminder.status === "pending" && <button type="button" onClick={() => snooze(reminder)} className="rounded-lg border border-blue-200 px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-50">{language === "hi" ? "10 मिनट बाद" : "Snooze 10m"}</button>}
                  {reminder.status === "pending" && <button type="button" onClick={() => setReminders((old: SmartReminder[]): SmartReminder[] => old.map((item): SmartReminder => item.id === reminder.id ? { ...item, status: "missed" } : item))} className="rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-50">{language === "hi" ? "छूटी चिह्नित करें" : "Mark missed"}</button>}
                  <button type="button" onClick={() => setReminders((old) => old.filter((item) => item.id !== reminder.id))} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50">{language === "hi" ? "हटाएँ" : "Delete"}</button>
                </div>
              </article>;
            })}
          </div>
        )}
        <p className="rounded-xl border border-amber-200 bg-amber-50/70 p-3 text-xs leading-5 text-amber-900">{language === "hi" ? "रिमाइंडर तभी चलता है जब MediBot टैब खुला हो। ब्राउज़र नोटिफिकेशन के लिए अनुमति आवश्यक है। यह ऐप खुराक नहीं सुझाता; डॉक्टर के निर्देशों का पालन करें।" : "Reminders run while this MediBot tab is open. Browser notifications require permission. This feature does not recommend doses; follow your clinician's instructions."}</p>
      </div>
    </section>
  );
}

/* ----------------------------- Small stroke icon ----------------------------- */

const ICON_PATHS: Record<IconName, string> = {
  home: "M3 10.8 12 3.5l9 7.3V20a1 1 0 0 1-1 1h-5v-6.5H10V21H4a1 1 0 0 1-1-1z",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM16.2 16.2 21 21",
  tag: "M12.6 3H21v8.4L11.6 20.8 3.2 12.4zM17 7.2h.01",
  swap: "M4 8h13m0 0-3.5-3.5M17 8l-3.5 3.5M20 16H7m0 0 3.5-3.5M7 16l3.5 3.5",
  columns: "M4 5h6.5v14H4zM13.5 5H20v14h-6.5z",
  activity: "M3 12h4l2.5-6 4 12 2.5-6H21",
  chart: "M4 20h16M7 20v-6M12 20V7M17 20v-9",
  calculator: "M5 3h14a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM8 7h8M8 11h2M14 11h2M8 15h2M14 15h2M8 18h2M14 18h2",
  cabinet: "M4 4h16v16H4zM4 10h16M9 4v6M15 4v6M9 14h6",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4",
  trash: "M4 7h16M9.5 7V4.5h5V7M6.5 7l.8 12.2a1 1 0 0 0 1 .8h7.4a1 1 0 0 0 1-.8L17.5 7",
};

/** Inline SVG icon (no icon dependency needed). */
function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className ?? "h-4 w-4"}
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

/* ------------------------------ Feature card ------------------------------ */

function Feature({
  icon,
  title,
  text,
  tint,
}: {
  icon: string;
  title: string;
  text: string;
  tint: "blue" | "lavender" | "mint" | "orange";
}) {
  // Full class strings (never concatenated fragments) so Tailwind can see
  // every color variant used by the tint lookup.
  const tileClasses = {
    blue: "border-blue-200 bg-blue-50 text-blue-600",
    lavender: "border-indigo-200 bg-indigo-50 text-indigo-500",
    mint: "border-emerald-200 bg-emerald-50 text-emerald-600",
    orange: "border-orange-200 bg-orange-50 text-orange-500",
  }[tint];

  return (
    <div className="card card-hover p-4">
      <div
        className={
          "flex h-10 w-10 items-center justify-center rounded-xl border text-lg " +
          tileClasses
        }
      >
        {icon}
      </div>

      <h3 className="mt-3 text-sm font-semibold text-navy">{title}</h3>

      <p className="mt-1 text-xs leading-5 text-muted">{text}</p>
    </div>
  );
}

/* ------------- Presentation-only renderer for assistant replies ------------- */
/*
 * Splits an EXISTING reply string into styled segments for readability.
 * Presentation only: no text is changed, removed, or invented, and none of
 * the reply / safety logic lives here — the exact reply strings that the
 * evaluation tests assert are rendered verbatim.
 */

type ReplySegment =
  | { kind: "heading"; text: string }
  | { kind: "subheading"; text: string }
  | { kind: "row"; label: string; value: string }
  | { kind: "bullet"; text: string }
  | { kind: "warning"; text: string }
  | { kind: "demo"; text: string }
  | { kind: "verified"; text: string }
  | { kind: "text"; text: string };

const REPLY_ROW_PATTERN =
  /^(Active composition|Category|MRP|Schedule|Active ingredient|Strength|Dosage form|Lowest listed price|Potential saving):\s*(.+)$/;

const REPLY_HEADING_EMOJI = ["💊", "⚖️", "💸"];

function parseReplySegments(content: string): ReplySegment[] {
  const paragraphs = content.split(/\n\s*\n/);
  const segments: ReplySegment[] = [];

  for (const paragraph of paragraphs) {
    const lines = paragraph
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");

    lines.forEach((line, index) => {
      if (line.startsWith("⚠️")) {
        segments.push({ kind: "warning", text: line });
        return;
      }
      if (line.includes("Demo/sample prices")) {
        segments.push({ kind: "demo", text: line });
        return;
      }
      if (line.startsWith("✓")) {
        segments.push({ kind: "verified", text: line });
        return;
      }
      if (line.startsWith("•")) {
        segments.push({ kind: "bullet", text: line.replace(/^•\s*/, "") });
        return;
      }
      const row = REPLY_ROW_PATTERN.exec(line);
      if (row !== null) {
        segments.push({ kind: "row", label: row[1], value: row[2] });
        return;
      }
      const isHeading =
        index === 0 &&
        (REPLY_HEADING_EMOJI.some((emoji) => line.startsWith(emoji)) ||
          line === "Composition-equivalent alternatives found:");
      if (isHeading) {
        segments.push({ kind: "heading", text: line });
        return;
      }
      if (index === 0 && lines.length > 1 && !line.includes(":")) {
        segments.push({ kind: "subheading", text: line });
        return;
      }
      segments.push({ kind: "text", text: line });
    });
  }

  return segments;
}

/** Renders one assistant reply with light cards, rows and badges. */
function AssistantText({ content }: { content: string }) {
  const segments = parseReplySegments(content);

  return (
    <div className="space-y-1.5 text-sm leading-6 text-[#213a5e]">
      {segments.map((segment, index) => {
        switch (segment.kind) {
          case "heading":
            return (
              <p
                key={index}
                className="pt-1 text-sm font-semibold text-navy first:pt-0"
              >
                {segment.text}
              </p>
            );
          case "subheading":
            return (
              <p key={index} className="text-sm font-semibold text-navy">
                {segment.text}
              </p>
            );
          case "row":
            return (
              <div
                key={index}
                className="flex flex-wrap items-baseline gap-x-2"
              >
                <span className="text-xs font-medium text-muted">
                  {segment.label}:
                </span>
                <span className="font-medium text-navy">{segment.value}</span>
              </div>
            );
          case "bullet":
            return (
              <div key={index} className="flex gap-2">
                <span className="text-blue-600" aria-hidden>
                  •
                </span>
                <span>{segment.text}</span>
              </div>
            );
          case "warning":
            return (
              <div
                key={index}
                className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 font-medium text-amber-900"
              >
                {segment.text}
              </div>
            );
          case "demo":
            return (
              <p
                key={index}
                className="inline-flex rounded-lg border border-orange-200 bg-orange-50 px-2.5 py-1.5 text-xs font-medium text-orange-700"
              >
                {segment.text}
              </p>
            );
          case "verified":
            return (
              <span
                key={index}
                className="inline-flex w-fit rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700"
              >
                {segment.text}
              </span>
            );
          default:
            return (
              <p key={index} className="text-sm text-[#213a5e]">
                {segment.text}
              </p>
            );
        }
      })}
    </div>
  );
}